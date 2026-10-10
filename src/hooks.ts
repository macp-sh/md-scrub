import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync, copyFileSync, unlinkSync } from "node:fs";
import { join, basename, extname, resolve, isAbsolute } from "node:path";
import { config, log, apiKey, budget, hash } from "./config.ts";
import { detect, describe, MARKDOWN_FILE, type Detection } from "./detect.ts";
import { clean, summariseEdits } from "./clean.ts";
import { Call, writeJson, SETUP_FILE, type Outcome } from "./progress.ts";
import { isIgnored } from "./ignore.ts";
import { startTurn, record, readTurn } from "./turn.ts";
import { loadScrubConfig, rule, ScrubConfigError, type ScrubConfig } from "./scrub.ts";

// Folders of generated or third-party files, which Claude doesn't write Markdown into by hand.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", ".venv", "target"]);

// Paths a shell command writes to: redirect and tee targets, the last argument of cp/mv/ln/install,
// touch arguments, and the Markdown files given to sed -i or perl -i. Heredoc bodies and quoted
// strings are ignored, so text that merely mentions a file never counts. Writes from scripts
// (python, node) are left to the end-of-turn sweep.
export function bashWriteTargets(cmd: string): string[] {
  const unquote = (t: string) => t.replace(/^(['"])(.*)\1$/, "$2");
  let text = cmd.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<$2$3");
  const targets: string[] = [];
  const quotedAware = text.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, (q, _m, offset: number) =>
    /(>>?|\btee(\s+-a)?)\s*$/.test(text.slice(0, offset)) ? q : "''",
  );
  // > and >> (also &>, &>> and 1>), but not 2> or >&, which send errors or point at another stream.
  for (const m of quotedAware.matchAll(/(?:^|[^<0-9&>]|(?<=[\s;|(])1|&)>>?\s*(?!&)((['"])[^'"]*\2|[^\s'";|&<>()]+)/g)) targets.push(unquote(m[1]!));
  for (const m of quotedAware.matchAll(/\btee\s+(?:(?:-a|--append)\s+)?((['"])[^'"]*\2|[^\s'";|&<>()]+)/g)) targets.push(unquote(m[1]!));
  text = text.replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/g, "''");
  for (const part of text.split(/[;&|\n]+/)) {
    const [cmdName, ...args] = part.trim().split(/\s+/).filter((w) => w && w !== "''");
    const files = args.filter((a) => !a.startsWith("-") && !a.includes(">"));
    if (["cp", "mv", "ln", "install"].includes(cmdName ?? "") && files.length >= 2) targets.push(files.at(-1)!);
    if (cmdName === "touch") targets.push(...files);
    if ((cmdName === "sed" || cmdName === "perl") && args.some((a) => /^-\w*i/.test(a))) targets.push(...files.filter((f) => MARKDOWN_FILE.test(f)));
  }
  return targets;
}

type Output = Record<string, unknown> | null;

// One hook call's work: its progress record for the status mod (once md-scrub decides the call is
// its business), what it changed, why it blocked, and the Jev failures to report.
class Job {
  private call: Call | null = null;
  edits = 0;
  reason = "";
  private jevErrors: string[] = [];

  begin(id: string, file: string) {
    this.call = new Call(id, file);
  }

  progress = (phase: string) => this.call?.phase(phase);

  finish(outcome: Outcome, file?: string) {
    this.call?.end(outcome, {
      edits: this.edits || undefined,
      reason: outcome === "blocked" ? this.reason : undefined,
      ...(file ? { file } : {}),
    });
    this.call = null;
  }

  // Records a Jev failure and applies the "If Jev is unavailable" option: a reason to block, or null.
  // Without a key the hooks don't run at all (cli.ts), so this only meets real failures.
  jevBlock(d: Pick<Detection, "jevError">): string | null {
    if (!d.jevError) return null;
    this.jevErrors.push(d.jevError);
    log({ event: "jev-error", error: d.jevError });
    return config.jevOnError === "block" ? `classifier unavailable (${d.jevError}); Markdown writes are blocked until it responds` : null;
  }

  withJevNotice(out: Output): Output {
    const failure = this.jevErrors[0];
    if (!failure) return out;
    const action = config.jevOnError === "block" ? "Markdown writes are blocked until it responds" : "checked with keywords only";
    const notice = `md-scrub: Jev classifier unavailable (${failure}); ${action}.`;
    const existing = (out as any)?.systemMessage;
    return { ...(out ?? {}), systemMessage: existing ? `${existing}\n${notice}` : notice };
  }

  // `next` tells Claude what to do instead; `topics` limits the rule quoted to the topics that matched.
  deny(target: string, why: string, scrub: ScrubConfig, { next = "Rewrite the content without it, or leave it out.", topics }: { next?: string; topics?: string[] } = {}): Output {
    this.reason = `${basename(target)}: ${why}`.split("\n")[0]!;
    log({ event: "deny", target, why });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `md-scrub blocked this write to ${target}: ${why}\n${rule(scrub, topics?.length ? topics : undefined)} ${next}`,
      },
    };
  }
}

// The topics that flagged anything, so messages cite only those.
const flaggedTopics = (d: Detection) => [...new Set(d.flagged.flatMap((f) => f.topics))];

// A broken settings or topic file, or any unexpected error, is reported in the terminal rather than
// crashing the hook, which Claude Code would treat as a silent pass.
function failure(e: unknown, what: string): Output {
  if (e instanceof ScrubConfigError) {
    log({ event: "config-error", error: e.message });
    return { systemMessage: `md-scrub: scrub config error, so nothing is being checked until it's fixed: ${e.message}` };
  }
  const message = (e as any)?.message ?? String(e);
  log({ event: "error", what, error: message });
  return { systemMessage: `md-scrub: internal error, so ${what} wasn't checked: ${message}` };
}

// Whether a whole text is mostly a topic, by Jev's length-weighted share.
const isMostly = (d: Detection, scrub: ScrubConfig, text: string) =>
  text.length >= config.mostlyMinChars && d.mostly !== undefined && d.mostly >= scrub.thresholds.mostly;
const topicNames = (scrub: ScrubConfig) => scrub.topics.map((t) => t.name).join(" or ");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- PreToolUse ----------

export async function pre(input: any): Promise<Output> {
  budget.until = Date.now() + config.preBudgetMs;
  const job = new Job();
  let out: Output;
  try {
    out = await preTool(input, job);
  } catch (e) {
    job.finish("error");
    return failure(e, "this write");
  }
  const h = (out as any)?.hookSpecificOutput;
  job.finish(h?.permissionDecision === "deny" ? "blocked" : h?.updatedInput ? "cleaned" : "clean");
  return job.withJevNotice(out);
}

async function preTool(input: any, job: Job): Promise<Output> {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};

  if (tool === "Bash") {
    record(input.session_id, { type: "bash", id: input.tool_use_id, at: Date.now(), cwd: input.cwd });
    return preBash(input, ti.command ?? "", job);
  }
  if (!["Write", "Edit", "MultiEdit"].includes(tool)) return null;

  const target: string = ti.file_path ?? "";
  if (!MARKDOWN_FILE.test(target) || isIgnored(target, input.cwd)) return null;
  const scrub = loadScrubConfig(target);
  if (!scrub.topics.length) return null; // switched off for this project
  record(input.session_id, { type: "touch", file: target });
  job.begin(input.tool_use_id ?? `pre-${Date.now()}`, target);

  // Each piece of new text is checked and cleaned on its own, then put back into the tool input.
  const pieces: { get: string; set: (s: string) => void }[] = [];
  const updated = structuredClone(ti);
  if (tool === "Write") pieces.push({ get: ti.content ?? "", set: (s) => (updated.content = s) });
  if (tool === "Edit") pieces.push({ get: ti.new_string ?? "", set: (s) => (updated.new_string = s) });
  if (tool === "MultiEdit") (ti.edits ?? []).forEach((e: any, i: number) => pieces.push({ get: e.new_string ?? "", set: (s) => (updated.edits[i].new_string = s) }));

  const removed: string[] = [];
  const topics: string[] = [];
  for (const piece of pieces) {
    if (!piece.get.trim()) continue;
    const d = await detect(piece.get, scrub);
    const jev = job.jevBlock(d);
    if (jev) return job.deny(target, jev, scrub);
    // A file that is mostly unwanted content doesn't belong in the project at all.
    if (tool === "Write" && isMostly(d, scrub, piece.get)) {
      return job.deny(
        target,
        `it is mostly ${topicNames(scrub)} (about ${Math.round(d.mostly! * 100)}%)`,
        scrub,
        { next: "Don't save it in the project; use the content from context instead." },
      );
    }
    if (!d.flagged.length) continue;
    topics.push(...flaggedTopics(d));
    const c = await clean(piece.get, d.flagged, job.progress, scrub);
    if (!c.ok) {
      log({ event: "clean-failed", target, error: c.error });
      return job.deny(target, describe(d.flagged), scrub, {
        next: "Automatic clean-up failed, so rewrite it yourself without that content.",
        topics: flaggedTopics(d),
      });
    }
    const recheck = job.jevBlock(c);
    if (recheck) return job.deny(target, recheck, scrub);
    piece.set(c.text);
    job.edits += c.edits.length;
    removed.push(summariseEdits(c.edits));
  }
  if (!removed.length) return null;

  log({ event: "cleaned", target, edits: removed.length });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: updated,
      additionalContext:
        `md-scrub removed ${topicNames(scrub)} before writing ${target}, so the file differs from what you sent:\n` +
        `${removed.join("\n")}\n${rule(scrub, [...new Set(topics)])} Don't add it back.`,
    },
  };
}

async function preBash(input: any, cmd: string, job: Job): Promise<Output> {
  // Targets resolve against the folder the command runs in. Recording them lets the sweep check
  // them wherever they are, even outside the session's folder.
  const base = input.cwd ?? process.cwd();
  const targets = bashWriteTargets(cmd)
    .map((t) => (isAbsolute(t) ? t : resolve(base, t)))
    .filter((t) => MARKDOWN_FILE.test(t) && !isIgnored(t, base) && loadScrubConfig(t).topics.length);
  for (const t of targets) record(input.session_id, { type: "touch", file: t });
  const target = targets[0];
  if (!target) return null;
  job.begin(input.tool_use_id ?? `pre-${Date.now()}`, target);
  const scrub = loadScrubConfig(target);
  const d = await detect(cmd, scrub);
  const jev = job.jevBlock(d);
  if (jev) return job.deny(target, jev, scrub);
  // Commands can't be safely rewritten, so Bash writes are blocked rather than cleaned.
  return d.flagged.length
    ? job.deny(target, describe(d.flagged), scrub, { next: "Write the file with the Write tool instead, without that content.", topics: flaggedTopics(d) })
    : null;
}

// ---------- SessionStart ----------

// Says once, at the start of a session, what would stop md-scrub working properly. Silent when all is well.
// Each problem has a full message for the transcript and a short line for the status mod, which keeps
// the most serious one on screen until a later session finds it fixed.
export function sessionStart(input: any): Output {
  const problems: { message: string; line: string }[] = [];
  if (!apiKey()) {
    problems.push({
      message: "off until you add an OpenRouter key, in /plugin > Installed > md-scrub > Configure",
      line: "off: add your OpenRouter key in /plugin > Installed > md-scrub > Configure",
    });
  }
  try {
    loadScrubConfig(input?.cwd ? join(input.cwd, "x.md") : undefined);
  } catch (e) {
    if (!(e instanceof ScrubConfigError)) throw e;
    problems.push({ message: `settings or topic error, so nothing is checked: ${e.message}`, line: "off: a settings or topic file has an error" });
  }
  if (!Bun.which("claude")) {
    problems.push({ message: "`claude` isn't on the PATH, so content can't be cleaned, only blocked", line: "can't clean, only block: claude isn't on the PATH" });
  }
  const line = problems.length ? problems[0]!.line + (problems.length > 1 ? ` (+${problems.length - 1} more)` : "") : null;
  try {
    writeJson(SETUP_FILE, { cwd: input?.cwd ?? null, line });
  } catch {}
  return problems.length ? { systemMessage: `md-scrub: ${problems.map((p) => p.message).join("; ")}.` } : null;
}

// ---------- PostToolUse ----------

// Records when each Bash command finished (PostToolUse, or PostToolUseFailure for a failed one), so the
// sweep knows which files it could have written.
export function post(input: any): Output {
  if (input.tool_name === "Bash") record(input.session_id, { type: "bashEnd", id: input.tool_use_id, at: Date.now() });
  return null;
}

// ---------- turn tracking and Stop sweep ----------

export function turnStart(input: any): Output {
  startTurn(input.session_id);
  return null;
}

// Markdown files under `root` modified or put in place while a Bash command was running. ctime counts
// too, since mv, cp -p, tar and unzip keep a file's old modification time. `truncated` says the walk
// stopped at `limit` entries, so the caller can say some files went unchecked.
export function filesChangedDuring(
  root: string,
  windows: { start: number; end: number }[],
  limit = config.walkLimit,
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let seen = 0;
  let truncated = false;
  const during = (t: number) => windows.some((w) => t >= w.start - 1000 && t <= w.end + 1000);
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > limit) { truncated = true; return; }
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
      if (!e.isFile() || !MARKDOWN_FILE.test(e.name)) continue;
      try {
        const st = statSync(p);
        if (during(Math.max(st.mtimeMs, st.ctimeMs))) files.push(p);
      } catch {}
    }
  };
  walk(root);
  return { files, truncated };
}

// Moves a file into the session scratchpad without overwriting anything already there.
function moveToScratchpad(file: string, scratchpad: string): string {
  const ext = extname(file);
  const stem = basename(file, ext);
  let dest = join(scratchpad, basename(file));
  for (let n = 2; existsSync(dest); n++) dest = join(scratchpad, `${stem}-${n}${ext}`);
  try {
    renameSync(file, dest);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    copyFileSync(file, dest); // a different volume: rename can't cross it
    unlinkSync(file);
  }
  return dest;
}

export async function stop(input: any): Promise<Output> {
  budget.until = Date.now() + config.stopBudgetMs;
  const job = new Job();
  try {
    const { out, outcome, file } = await sweep(input, job);
    job.finish(outcome, file);
    return job.withJevNotice(out);
  } catch (e) {
    job.finish("error");
    return failure(e, "this turn's files");
  }
}

async function sweep(input: any, job: Job): Promise<{ out: Output; outcome: Outcome; file?: string }> {
  // Only files Claude wrote: Write/Edit targets, plus files changed while one of its Bash commands ran
  // (which covers redirects, downloads and scripts). Editor saves and other processes are left alone.
  const turn = readTurn(input.session_id);
  if (!turn.started) return { out: null, outcome: "clean" };
  const isFile = (f: string) => {
    try { return statSync(f).isFile(); } catch { return false; }
  };
  const candidates = new Set([...turn.touched].filter(isFile));
  // Each folder a Bash command ran in, plus the session's own, walked once each.
  const roots = new Set([input.cwd ?? process.cwd(), ...turn.bashWindows.map((w) => w.cwd).filter((c): c is string => !!c)]);
  const unwalked: string[] = [];
  if (turn.bashWindows.length) {
    for (const root of roots) {
      const { files, truncated } = filesChangedDuring(root, turn.bashWindows);
      for (const f of files) candidates.add(f);
      if (truncated) unwalked.push(root);
    }
  }
  const files = [...candidates].filter((f) => !isIgnored(f, input.cwd));

  const cleaned: string[] = [];
  const problems: string[] = [];
  const moved: string[] = [];
  const skipped: string[] = [];
  // Something else (the user's editor, another session) may change a file while it's being checked.
  const unchangedSince = (f: string, mtime: number) => {
    try {
      if (statSync(f).mtimeMs === mtime) return true;
    } catch {}
    skipped.push(f);
    return false;
  };
  const rules = new Set<string>();
  if (files.length) job.begin(`stop-${input.session_id ?? "unknown"}`, `${plural(files.length, "changed file")}`);
  for (const f of files) {
    const scrub = loadScrubConfig(f);
    if (!scrub.topics.length) continue; // switched off for this project
    const mtime = statSync(f).mtimeMs;
    const text = readFileSync(f, "utf8");
    const d = await detect(text, scrub);
    job.jevBlock(d);
    // A whole page of unwanted content (a saved terms page, say) belongs in the scratchpad, not the project.
    if (isMostly(d, scrub, text) && input.scratchpad_dir) {
      if (!unchangedSince(f, mtime)) continue;
      const dest = moveToScratchpad(f, input.scratchpad_dir);
      moved.push(`${f} → ${dest} (about ${Math.round(d.mostly! * 100)}% ${topicNames(scrub)})`);
      log({ event: "moved", target: f, to: dest });
      continue;
    }
    if (!d.flagged.length) continue;
    rules.add(rule(scrub, flaggedTopics(d)));
    const c = await clean(text, d.flagged, undefined, scrub);
    if (c.ok) {
      job.jevBlock(c);
      if (!unchangedSince(f, mtime)) continue;
      job.edits += c.edits.length;
      writeFileSync(f, c.text);
      cleaned.push(`${f}:\n${summariseEdits(c.edits)}`);
    } else {
      job.reason = `${basename(f)}: automatic clean-up failed`;
      problems.push(`${f} (automatic clean-up failed: ${c.error}):\n${describe(d.flagged)}`);
    }
  }
  if (skipped.length) log({ event: "skipped", files: skipped });
  if (unwalked.length) log({ event: "walk-limit", roots: unwalked });
  // The walk limit is news for the user, not work for Claude: show it in the terminal, once per turn,
  // without continuing the conversation.
  const limitNote =
    unwalked.length && !input.stop_hook_active
      ? `md-scrub: stopped looking after ${config.walkLimit.toLocaleString("en-AU")} entries in ${unwalked.join(", ")}, so files your commands wrote there may be unchecked.`
      : undefined;
  const outcome: Outcome = problems.length ? "blocked" : moved.length ? "moved" : cleaned.length ? "cleaned" : "clean";
  const file = moved.length ? plural(moved.length, "file") : undefined;
  if (!cleaned.length && !problems.length && !moved.length && !skipped.length) {
    return { out: limitNote ? { systemMessage: limitNote } : null, outcome };
  }
  log({ event: "sweep", cleaned: cleaned.length, problems: problems.length, moved: moved.length });

  const problemsHash = hash(problems.join("\n"));
  if (input.stop_hook_active && problems.length && turn.lastProblems === problemsHash) {
    // Claude already had one attempt at these exact problems; hand over to the user.
    return { out: { systemMessage: `md-scrub: unwanted content remains after clean-up:\n${problems.join("\n")}` }, outcome, file };
  }
  record(input.session_id, { type: "problems", hash: problems.length ? problemsHash : null });

  const summary = [
    cleaned.length && `cleaned ${plural(cleaned.length, "file")} (${plural(job.edits, "edit")})`,
    moved.length && `moved ${moved.length} to the scratchpad`,
    problems.length && `${problems.length} need${problems.length === 1 ? "s" : ""} your fix`,
  ].filter(Boolean).join(", ");
  const parts = summary ? [`md-scrub: ${summary}.`] : [];
  if (moved.length) parts.push(`md-scrub moved files that are mostly content kept out of the project to the session scratchpad. Read them there if you need them; don't copy them back:\n${moved.join("\n")}`);
  if (cleaned.length) parts.push(`md-scrub removed unwanted content from files changed this turn. Re-read them before editing again:\n${cleaned.join("\n")}`);
  if (problems.length) parts.push(`md-scrub found content it couldn't remove. Remove it yourself, re-reading each file first:\n${problems.join("\n")}`);
  if (skipped.length) parts.push(`md-scrub left these alone because they changed while being checked:\n${skipped.join("\n")}`);
  return {
    out: {
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: `${parts.join("\n\n")}${rules.size ? `\n${[...rules].join(" ")}` : ""}` },
      ...(limitNote ? { systemMessage: limitNote } : {}),
    },
    outcome,
    file,
  };
}
