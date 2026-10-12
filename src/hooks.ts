import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { config, log, apiKey, budget, hash } from "./config.ts";
import { detect, describe, MARKDOWN_FILE, type Detection } from "./detect.ts";
import { clean, summariseEdits } from "./clean.ts";
import { Call, readCall, writeJson, SETUP_FILE, type Outcome } from "./progress.ts";
import { isExcluded } from "./exclusions.ts";
import { startTurn, record, readTurn } from "./turn.ts";
import { loadScrubConfig, rule, ScrubConfigError, type ScrubConfig } from "./scrub.ts";

// md-scrub never refuses a write. Claude's Write and Edit calls are scrubbed before they reach disk;
// everything else Claude caused (shell commands, scripts) is checked at the end of the turn. What
// can't be scrubbed is flagged: left as written, with Claude and the user told.

// Folders of generated or third-party files, which Claude doesn't write Markdown into by hand.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", ".venv", "target"]);

// Paths a shell command writes to: redirect and tee targets, the last argument of cp/mv/ln/install,
// touch arguments, and the Markdown files given to sed -i or perl -i. Heredoc bodies and quoted
// strings are ignored, so text that merely mentions a file never counts. Writes from scripts
// (python, node) are found by the end-of-turn sweep's folder walk.
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
// its business), its outcome, and the log line for the panel.
class Job {
  private call: Call | null = null;
  outcome: Outcome = "clean";
  edits = 0;
  reason = "";

  begin(id: string, file: string) {
    this.call = new Call(id, file);
  }

  progress = (phase: string) => this.call?.phase(phase);

  finish(outcome: Outcome = this.outcome, file?: string) {
    this.call?.end(outcome, {
      edits: this.edits || undefined,
      reason: this.reason || undefined,
      ...(file ? { file } : {}),
    });
    this.call = null;
  }
}

// One line in the log per file md-scrub acted on (or couldn't check), for the panel's Log.
function action(action: Outcome, file: string, extra: Record<string, unknown> = {}) {
  log({ event: "action", action, file, ...extra });
}

// The topics that flagged anything, so messages cite only those. A text that is mostly a topic may have
// no single chunk over the flag threshold; then the topics it is mostly are cited.
const flaggedTopics = (d: Detection, scrub?: ScrubConfig) => {
  const ids = [...new Set(d.flagged.flatMap((f) => f.topics))];
  return ids.length || !scrub ? ids : (d.mostlyTopics ?? scrub.topics.map((t) => t.id));
};

// Any unexpected error is reported in the terminal rather than crashing the hook, which Claude Code
// would treat as a silent pass. A broken settings file turns md-scrub off until it's fixed.
function failure(e: unknown, what: string): Output {
  if (e instanceof ScrubConfigError) {
    log({ event: "config-error", error: e.message });
    return { systemMessage: `md-scrub: settings error, so nothing is being checked until it's fixed: ${e.message}` };
  }
  const message = (e as any)?.message ?? String(e);
  log({ event: "error", what, error: message });
  return { systemMessage: `md-scrub: internal error, so ${what} wasn't checked: ${message}` };
}

// Whether a whole text is mostly a topic: some topic's length-weighted share is over its own threshold.
const isMostly = (d: Detection, text: string) =>
  text.length >= config.mostlyMinChars && !!d.mostlyTopics?.length;
const topicNames = (scrub: ScrubConfig, ids?: string[]) =>
  scrub.topics.filter((t) => !ids || ids.includes(t.id)).map((t) => t.name).join(" or ");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const percent = (d: Detection) => Math.round(d.mostly! * 100);

// ---------- PreToolUse ----------

export async function pre(input: any): Promise<Output> {
  budget.until = Date.now() + config.preBudgetMs;
  const job = new Job();
  try {
    const out = await preTool(input, job);
    job.finish();
    return out;
  } catch (e) {
    job.finish("error");
    return failure(e, "this write");
  }
}

async function preTool(input: any, job: Job): Promise<Output> {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};

  if (tool === "Bash") {
    // Nothing is checked before a command runs; the sweep checks what it wrote. Recording the command
    // and the files it names lets the sweep find them, even outside the session's folder.
    record(input.session_id, { type: "bash", id: input.tool_use_id, at: Date.now(), cwd: input.cwd });
    const base = input.cwd ?? process.cwd();
    for (const t of bashWriteTargets(ti.command ?? "")) {
      const abs = isAbsolute(t) ? t : resolve(base, t);
      if (MARKDOWN_FILE.test(abs)) record(input.session_id, { type: "touch", file: abs });
    }
    return null;
  }
  if (!["Write", "Edit", "MultiEdit"].includes(tool)) return null;

  const target: string = ti.file_path ?? "";
  if (!MARKDOWN_FILE.test(target) || isExcluded(target, input.cwd)) return null;
  const scrub = loadScrubConfig(target);
  if (!scrub.topics.length) return null; // switched off here
  record(input.session_id, { type: "touch", file: target });
  job.begin(input.tool_use_id ?? `pre-${Date.now()}`, target);

  // Each piece of new text is checked and scrubbed on its own, then put back into the tool input.
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
    if (d.jevError) {
      // Stand down: the write goes through as sent.
      job.outcome = "unchecked";
      job.reason = "Jev isn't responding";
      action("unchecked", target, { reason: d.jevError });
      return null;
    }
    // A new file that is mostly unwanted content can't be scrubbed down sensibly: leave it, say so.
    if (tool === "Write" && isMostly(d, piece.get)) {
      job.outcome = "flagged";
      job.reason = `mostly ${topicNames(scrub, d.mostlyTopics)}`;
      action("flagged", target, { topics: flaggedTopics(d, scrub), reason: "mostly", share: percent(d) });
      return notice(
        `md-scrub: ${target} is mostly ${topicNames(scrub, d.mostlyTopics)} (about ${percent(d)}%), so it was saved as written. ` +
          `${rule(scrub)} Tell the user; they decide whether to keep it.`,
      );
    }
    if (!d.flagged.length) continue;
    topics.push(...flaggedTopics(d));
    const c = await clean(piece.get, d.flagged, job.progress, scrub);
    if (!c.ok) {
      // The write goes through as sent; Claude is told what to remove.
      job.outcome = "flagged";
      job.reason = "couldn't scrub it";
      log({ event: "clean-failed", target, error: c.error });
      action("flagged", target, { topics: flaggedTopics(d), reason: "clean-up failed" });
      return notice(
        `md-scrub found content it couldn't remove automatically in ${target}, so it was saved as written:\n${describe(d.flagged)}\n` +
          `${rule(scrub, flaggedTopics(d))} Remove it yourself.`,
      );
    }
    piece.set(c.text);
    job.edits += c.edits.length;
    removed.push(summariseEdits(c.edits));
  }
  if (!removed.length) return null;

  job.outcome = "scrubbed";
  action("scrubbed", target, { topics: [...new Set(topics)], edits: job.edits });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: updated,
      additionalContext:
        `md-scrub removed ${topicNames(scrub, topics)} before writing ${target}, so the file differs from what you sent:\n` +
        `${removed.join("\n")}\n${rule(scrub, [...new Set(topics)])} Don't add it back.`,
    },
  };
}

const notice = (text: string): Output => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

// ---------- SessionStart ----------

// Says once, at the start of a session, what would stop md-scrub working properly, and leaves the most
// serious problem for the status mod, which keeps it on screen until a later session finds it fixed.
export function sessionStart(input: any): Output {
  const problems: { message: string; line: string }[] = [];
  if (!apiKey()) {
    problems.push({
      message: "off until you add an OpenRouter or TypeSafe key, in /plugin > Installed > md-scrub > Configure",
      line: "off: add an OpenRouter or TypeSafe key in /plugin > Installed > md-scrub > Configure",
    });
  }
  try {
    const scrub = loadScrubConfig();
    for (const e of scrub.errors) problems.push({ message: `a topic is off because of an error: ${e}`, line: "a topic file has an error; that topic is off" });
  } catch (e) {
    if (!(e instanceof ScrubConfigError)) throw e;
    problems.push({ message: `settings error, so nothing is checked: ${e.message}`, line: "off: a settings file has an error" });
  }
  if (!Bun.which("claude")) {
    problems.push({ message: "`claude` isn't on the PATH, so flagged content can't be scrubbed", line: "can't scrub: claude isn't on the PATH" });
  }
  const line = problems.length ? problems[0]!.line + (problems.length > 1 ? ` (+${problems.length - 1} more)` : "") : null;
  try {
    writeJson(SETUP_FILE, { cwd: input?.cwd ?? null, line });
  } catch {}
  return problems.length ? { systemMessage: `md-scrub: ${problems.map((p) => p.message).join("; ")}.` } : null;
}

// ---------- PostToolUse ----------

// Records when each Bash command finished (PostToolUse, or PostToolUseFailure for a failed one), so the
// sweep knows which files it could have written; and, for a Write or Edit md-scrub already handled
// (passed, scrubbed or flagged and reported), the file as saved, so the sweep doesn't check or report it
// again. Writes it couldn't check (Jev down) are left for the sweep.
export function post(input: any): Output {
  if (input.tool_name === "Bash") record(input.session_id, { type: "bashEnd", id: input.tool_use_id, at: Date.now() });
  if (["Write", "Edit", "MultiEdit"].includes(input.tool_name) && input.tool_use_id) {
    const call = readCall(input.tool_use_id);
    if (call && (call.outcome === "clean" || call.outcome === "scrubbed" || call.outcome === "flagged")) {
      try {
        record(input.session_id, { type: "checked", file: call.file, hash: hash(readFileSync(call.file, "utf8")) });
      } catch {}
    }
  }
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

export async function stop(input: any): Promise<Output> {
  budget.until = Date.now() + config.stopBudgetMs;
  const job = new Job();
  try {
    const { out, outcome } = await sweep(input, job);
    job.finish(outcome);
    return out;
  } catch (e) {
    job.finish("error");
    return failure(e, "this turn's files");
  }
}

async function sweep(input: any, job: Job): Promise<{ out: Output; outcome: Outcome }> {
  // Only files Claude wrote: Write/Edit targets, the files its commands named, and files changed while
  // one of its Bash commands ran (which covers redirects, downloads and scripts). Editor saves and
  // other processes are left alone, as are files md-scrub already passed and that haven't changed.
  const turn = readTurn(input.session_id);
  if (!turn.started) return { out: null, outcome: "clean" };
  const isFile = (f: string) => {
    try { return statSync(f).isFile(); } catch { return false; }
  };
  const candidates = new Set([...turn.touched].filter(isFile));
  const roots = new Set([input.cwd ?? process.cwd(), ...turn.bashWindows.map((w) => w.cwd).filter((c): c is string => !!c)]);
  const unwalked: string[] = [];
  if (turn.bashWindows.length) {
    for (const root of roots) {
      const { files, truncated } = filesChangedDuring(root, turn.bashWindows);
      for (const f of files) candidates.add(f);
      if (truncated) unwalked.push(root);
    }
  }
  const files = [...candidates].filter((f) => !isExcluded(f, input.cwd));

  const scrubbed: string[] = [];
  const problems: string[] = [];
  const mostly: string[] = [];
  const unchecked: string[] = [];
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
  let begun = false;
  for (const f of files) {
    const scrub = loadScrubConfig(f);
    if (!scrub.topics.length) continue; // switched off here
    const mtime = statSync(f).mtimeMs;
    const text = readFileSync(f, "utf8");
    if (turn.checked.get(f) === hash(text)) continue; // passed before the write, and unchanged since
    if (!begun) { job.begin(`stop-${input.session_id ?? "unknown"}`, plural(files.length, "changed file")); begun = true; }
    const d = await detect(text, scrub);
    if (d.jevError) {
      unchecked.push(f);
      action("unchecked", f, { reason: d.jevError });
      continue;
    }
    // A whole page of unwanted content (a saved terms page, say) can't be scrubbed down: flag it.
    if (isMostly(d, text)) {
      mostly.push(`${f} (about ${percent(d)}% ${topicNames(scrub, d.mostlyTopics)})`);
      rules.add(rule(scrub));
      action("flagged", f, { topics: flaggedTopics(d, scrub), reason: "mostly", share: percent(d) });
      continue;
    }
    if (!d.flagged.length) continue;
    rules.add(rule(scrub, flaggedTopics(d)));
    const c = await clean(text, d.flagged, undefined, scrub);
    if (c.ok) {
      if (!unchangedSince(f, mtime)) continue;
      job.edits += c.edits.length;
      writeFileSync(f, c.text);
      scrubbed.push(`${f}:\n${summariseEdits(c.edits)}`);
      action("scrubbed", f, { topics: flaggedTopics(d), edits: c.edits.length });
    } else {
      problems.push(`${f} (automatic clean-up failed: ${c.error}):\n${describe(d.flagged)}`);
      action("flagged", f, { topics: flaggedTopics(d), reason: "clean-up failed" });
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
  const flaggedCount = problems.length + mostly.length;
  const outcome: Outcome = flaggedCount ? "flagged" : scrubbed.length ? "scrubbed" : unchecked.length ? "unchecked" : "clean";
  job.reason = flaggedCount ? plural(flaggedCount, "file") : unchecked.length ? "Jev isn't responding" : "";
  if (!scrubbed.length && !flaggedCount && !skipped.length) {
    return { out: limitNote ? { systemMessage: limitNote } : null, outcome };
  }
  log({ event: "sweep", scrubbed: scrubbed.length, problems: problems.length, mostly: mostly.length });

  const problemsHash = hash([...problems, ...mostly].join("\n"));
  if (input.stop_hook_active && flaggedCount && turn.lastProblems === problemsHash) {
    // Claude already had one turn with these exact findings; hand over to the user.
    return { out: { systemMessage: `md-scrub: unwanted content remains:\n${[...problems, ...mostly].join("\n")}` }, outcome };
  }
  record(input.session_id, { type: "problems", hash: flaggedCount ? problemsHash : null });

  const summary = [
    scrubbed.length && `scrubbed ${plural(scrubbed.length, "file")} (${plural(job.edits, "edit")})`,
    flaggedCount && `flagged ${flaggedCount}`,
  ].filter(Boolean).join(", ");
  const parts = summary ? [`md-scrub: ${summary}.`] : [];
  if (scrubbed.length) parts.push(`md-scrub removed unwanted content from files changed this turn. Re-read them before editing again:\n${scrubbed.join("\n")}`);
  if (problems.length) parts.push(`md-scrub found content it couldn't remove. Remove it yourself, re-reading each file first:\n${problems.join("\n")}`);
  if (mostly.length) parts.push(`md-scrub left these files as written because they are mostly content kept out of the project. Tell the user; they decide whether to keep them:\n${mostly.join("\n")}`);
  if (skipped.length) parts.push(`md-scrub left these alone because they changed while being checked:\n${skipped.join("\n")}`);
  return {
    out: {
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: `${parts.join("\n\n")}${rules.size ? `\n${[...rules].join(" ")}` : ""}` },
      ...(limitNote ? { systemMessage: limitNote } : {}),
    },
    outcome,
  };
}
