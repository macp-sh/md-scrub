// The end-of-turn sweep: which files count as Claude's, how they are cleaned or moved, and how
// repeated problems are handed to the user.
import { test, expect, describe } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, utimesSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { filesChangedDuring } from "../src/hooks.ts";
import { readTurn, record, startTurn } from "../src/turn.ts";
import { STATE, fixtureProject, run, untouched, write, DOC, stateJson, sessionId, tmp } from "./helpers.ts";

const DIRTY = DOC("Released, licensed under MIT.");

// A turn in a fresh project: turn-start, then any number of Bash commands bracketing file writes.
function turn(opts: { scratchpad?: boolean } = {}) {
  const dir = fixtureProject();
  const id = sessionId();
  const scratchpad = opts.scratchpad ? tmp("pad") : undefined;
  const base = { session_id: id, cwd: dir, ...(scratchpad ? { scratchpad_dir: scratchpad } : {}) };
  run("turn-start", base);
  let n = 0;
  return {
    dir,
    id,
    scratchpad,
    file: (name: string) => join(dir, name),
    // The files are written "by" a Bash command: its pre and post hooks bracket the writes.
    bash: (during: () => void, cwd = dir) => {
      const call = { ...base, cwd, tool_name: "Bash", tool_input: { command: "python3 gen.py" }, tool_use_id: `toolu_${id}_${n++}` };
      run("pre", call);
      during();
      run("post", call);
    },
    writeTool: (file: string, content: string) => run("pre", { ...base, ...write(file, content), tool_use_id: `toolu_w_${id}_${n++}` }),
    stop: (active = false, env: Record<string, string> = {}) => run("stop", { ...base, stop_hook_active: active }, env).json,
  };
}
const context = (r: any): string => r?.hookSpecificOutput?.additionalContext ?? "";

describe("which files are Claude's", () => {
  test("a file changed during a command is cleaned; older files and clean ones are left alone", () => {
    const t = turn();
    writeFileSync(t.file("old.md"), "© 2020 Old");
    utimesSync(t.file("old.md"), new Date(0), new Date(0));
    Bun.sleepSync(1100); // setting times also sets ctime, which counts; step past the 1 s grace
    t.bash(() => {
      writeFileSync(t.file("new.md"), DIRTY);
      writeFileSync(t.file("clean.md"), "Nothing here.");
    });
    const ctx = context(t.stop());
    expect(ctx).toContain("new.md");
    expect(ctx).not.toContain("old.md");
    expect(ctx).not.toContain("clean.md");
    expect(readFileSync(t.file("new.md"), "utf8")).not.toContain("licensed under");
    expect(readFileSync(t.file("old.md"), "utf8")).toBe("© 2020 Old");
  });

  test("a file changed outside Claude's commands, such as an editor save, is left alone", () => {
    const t = turn();
    t.bash(() => {});
    writeFileSync(t.file("editor.md"), DIRTY);
    const later = new Date(Date.now() + 60_000);
    utimesSync(t.file("editor.md"), later, later);
    expect(untouched(t.stop())).toBe(true);
    expect(readFileSync(t.file("editor.md"), "utf8")).toContain("licensed under");
  });

  test("a file Claude wrote with the Write tool is swept, whenever it changed", () => {
    const t = turn();
    t.writeTool(t.file("w.md"), "Nothing here.");
    writeFileSync(t.file("w.md"), DIRTY); // what ends up on disk, e.g. after a later edit
    expect(context(t.stop())).toContain("w.md");
  });

  test("a command's files in another folder than the session's are checked", () => {
    const t = turn();
    const other = fixtureProject();
    t.bash(() => writeFileSync(join(other, "notes.md"), DIRTY), other);
    expect(context(t.stop())).toContain(join(other, "notes.md"));
  });

  test("a file moved into place with its old modification time counts", () => {
    const t = turn();
    t.bash(() => {
      writeFileSync(t.file("old.md"), DIRTY);
      utimesSync(t.file("old.md"), new Date(0), new Date(0)); // as mv or tar would leave it
    });
    expect(context(t.stop())).toContain("old.md");
  });

  test("a folder whose name ends in .md is skipped", () => {
    const t = turn();
    mkdirSync(t.file("folder.md"));
    t.writeTool(t.file("folder.md"), "x");
    expect(t.stop()).toBeNull();
  });

  test("nothing is swept, and nothing said, without a turn or when nothing matches", () => {
    expect(run("stop", { session_id: sessionId(), cwd: fixtureProject() }).out).toBe("");
    const t = turn();
    t.bash(() => writeFileSync(t.file("a.md"), "Just notes."));
    expect(untouched(t.stop())).toBe(true);
  });
});

describe("command windows", () => {
  test("a command with no end event only counts for Bash's longest timeout", () => {
    const id = sessionId();
    startTurn(id);
    record(id, { type: "bash", id: "t1", at: 1_000 });
    expect(readTurn(id, 1_000 + 60 * 60 * 1000).bashWindows[0]!.end).toBe(1_000 + 10 * 60 * 1000);
  });

  test("a failed command closes its window through PostToolUseFailure", () => {
    const id = sessionId();
    startTurn(id);
    record(id, { type: "bash", id: "t2", at: Date.now() });
    run("post", { tool_name: "Bash", tool_input: { command: "false" }, tool_use_id: "t2", session_id: id, hook_event_name: "PostToolUseFailure" });
    expect(readTurn(id, Date.now() + 60 * 60 * 1000).bashWindows[0]!.end).toBeLessThan(Date.now() + 1000);
  });

  test("the folder walk stops at its limit and says so", () => {
    const dir = tmp("big");
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.md`), "x");
    const r = filesChangedDuring(dir, [{ start: 0, end: Date.now() + 10_000 }], 3);
    expect(r.truncated).toBe(true);
    expect(r.files.length).toBeLessThan(5);
  });
});

describe("problems", () => {
  test("a failed clean-up goes to Claude once, then to the user if it's the same again", () => {
    const t = turn();
    t.bash(() => writeFileSync(t.file("new.md"), DIRTY));
    expect(context(t.stop(false, { FAKE_MODE: "noop" }))).toContain("couldn't remove");
    const events = readFileSync(join(STATE, `turn-${t.id}.events.jsonl`), "utf8");
    expect(events).toMatch(/"type":"problems","hash":"[0-9a-f]{64}"/);
    const second = t.stop(true, { FAKE_MODE: "noop" });
    expect(second.systemMessage).toContain("new.md");
    expect(second.hookSpecificOutput).toBeUndefined();
  });

  test("a file that changes while being checked is left alone", () => {
    const t = turn();
    t.bash(() => writeFileSync(t.file("notes.md"), DIRTY));
    const r = t.stop(false, { FAKE_TOUCH: t.file("notes.md") });
    expect(context(r)).toContain("changed while being checked");
    expect(readFileSync(t.file("notes.md"), "utf8")).toContain("licensed under MIT");
  });

  test("an unexpected error is reported instead of crashing, and closes the status record", () => {
    const t = turn();
    t.bash(() => {
      writeFileSync(t.file("notes.md"), DIRTY);
      chmodSync(t.file("notes.md"), 0o444); // the clean-up can't write it back
    });
    expect(t.stop().systemMessage).toContain("internal error");
    expect(stateJson(`calls/stop-${t.id}.json`).outcome).toBe("error");
  });
});

describe("files that are mostly the topic, written by a shell command", () => {
  const JEV = { OPENROUTER_API_KEY: "test", FAKE_JEV: "score" };
  const clause = (n: number) => `## ${n}. Section\n\nMOSTLY These terms govern your use of the service. You may not resell, sublicense or share access, and we may suspend accounts that do.\n`;
  const terms = `# Terms\n\n${[1, 2, 3, 4, 5].map(clause).join("\n")}`;

  test("are moved to the session scratchpad, and Claude is told where", () => {
    const t = turn({ scratchpad: true });
    t.bash(() => writeFileSync(t.file("terms.md"), terms));
    const ctx = context(t.stop(false, JEV));
    expect(ctx).toContain("moved");
    expect(ctx).toContain(join(t.scratchpad!, "terms.md"));
    expect(existsSync(t.file("terms.md"))).toBe(false);
    expect(readFileSync(join(t.scratchpad!, "terms.md"), "utf8")).toBe(terms);
    expect(stateJson(`calls/stop-${t.id}.json`).outcome).toBe("moved");
  });

  test("never overwrite a file already in the scratchpad", () => {
    const t = turn({ scratchpad: true });
    writeFileSync(join(t.scratchpad!, "terms.md"), "earlier");
    t.bash(() => writeFileSync(t.file("terms.md"), terms));
    t.stop(false, JEV);
    expect(readFileSync(join(t.scratchpad!, "terms.md"), "utf8")).toBe("earlier");
    expect(readFileSync(join(t.scratchpad!, "terms-2.md"), "utf8")).toBe(terms);
  });

  test("go through the normal clean-up when the session has no scratchpad", () => {
    const t = turn();
    t.bash(() => writeFileSync(t.file("terms.md"), terms));
    expect(context(t.stop(false, JEV))).toContain("couldn't remove");
    expect(existsSync(t.file("terms.md"))).toBe(true);
  });
});
