// The PreToolUse hook (Write, Edit, MultiEdit, Bash), the start-up check and the plugin's hook wiring.
import { test, expect, describe } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { bashWriteTargets } from "../src/hooks.ts";
import {
  ROOT, CLI, ENV, PATH_WITH_CLAUDE, PATH_WITHOUT_CLAUDE, fixtureProject, run, pre, write, bash, decision, untouched, DOC, stateJson, tmp,
} from "./helpers.ts";

const P = fixtureProject();
const at = (rel: string) => join(P, rel);
const reason = (r: any): string => r.hookSpecificOutput.permissionDecisionReason;
const JEV = { OPENROUTER_API_KEY: "test", FAKE_JEV: "score" };
const OUTAGE = { OPENROUTER_API_KEY: "test", FAKE_JEV: "down" };

describe("Write, Edit and MultiEdit", () => {
  test("a Write is cleaned before it reaches disk, and Claude is told what changed", () => {
    const out = pre(write(at("notes.md"), DOC("We use zod (MIT) for validation."))).hookSpecificOutput;
    expect(out.permissionDecision).toBeUndefined(); // normal permission rules still apply
    expect(out.updatedInput.file_path).toBe(at("notes.md"));
    expect(out.updatedInput.content).not.toContain("(MIT)");
    expect(out.updatedInput.content).toContain("Run `bun dev` to start it locally.");
    expect(out.additionalContext).toContain("removed");
  });

  test("an Edit's new_string is cleaned, leaving old_string alone", () => {
    const r = pre({ tool_name: "Edit", tool_input: { file_path: at("a.md"), old_string: "x", new_string: DOC("© 2026 Acme") } });
    expect(r.hookSpecificOutput.updatedInput.new_string).not.toContain("©");
    expect(r.hookSpecificOutput.updatedInput.old_string).toBe("x");
  });

  test("only the MultiEdit edit that needs it is cleaned", () => {
    const edits = [{ old_string: "a", new_string: "fine" }, { old_string: "b", new_string: DOC("Released, licensed under MIT.") }];
    const out = pre({ tool_name: "MultiEdit", tool_input: { file_path: at("a.md"), edits } }).hookSpecificOutput.updatedInput.edits;
    expect(out[0].new_string).toBe("fine");
    expect(out[1].new_string).not.toContain("licensed under");
  });

  test("clean Markdown, other file types and md-scrub's own Haiku call are left alone", () => {
    expect(untouched(pre(write(at("notes.md"), DOC("Nothing else."))))).toBe(true);
    expect(untouched(pre(write(at("src/app.ts"), "// licensed under MIT")))).toBe(true);
    expect(run("pre", write(at("notes.md"), DOC("licensed under MIT")), { MD_SCRUB_INNER: "1" }).out).toBe("");
  });

  test("unreadable hook input is reported, not a silent crash", () => {
    const r = run("pre", "{bad");
    expect(r.code).toBe(0);
    expect(r.json.systemMessage).toContain("couldn't read the hook input");
  });
});

describe("when the clean-up can't be trusted", () => {
  test("a failed clean-up denies the write with every hit listed", () => {
    const r = pre(write(at("notes.md"), DOC("We use zod (MIT).\nFooter © 2026 Acme.")), { FAKE_MODE: "noop" });
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toContain("line 5");
    expect(reason(r)).toContain("line 6");
    expect(reason(r)).toContain("Automatic clean-up failed");
  });

  test("a missing claude blocks the write with every hit listed instead of crashing", () => {
    const r = run("pre", write(at("notes.md"), DOC("We use zod (MIT).")), { PATH: PATH_WITHOUT_CLAUDE });
    expect(r.code).toBe(0);
    expect(decision(r.json)).toBe("deny");
    expect(reason(r.json)).toContain("line 5");
  });

  test("an edit that adds or rewords text is rejected, and the write is blocked", () => {
    const r = pre(write(at("notes.md"), DOC("We use zod (MIT).")), { FAKE_MODE: "reword" });
    expect(decision(r)).toBe("deny");
    expect(JSON.stringify(r)).not.toContain("INJECTED TEXT");
  });

  test("a block cites only the topics that matched", () => {
    const p = fixtureProject();
    writeFileSync(
      join(p, ".md-scrub", "topics", "secrets.json"),
      JSON.stringify({ name: "credentials", description: "API keys.", message: "No credentials, please.", examples: { is: ["sk-1"], isNot: ["key in .env"] }, keywords: [{ label: "key", pattern: "\\bsk-\\w+" }] }),
    );
    const r = pre({ ...write(join(p, "a.md"), DOC("zod (MIT)")), cwd: p }, { FAKE_MODE: "noop" });
    expect(reason(r)).toContain("Test fixture rule");
    expect(reason(r)).not.toContain("No credentials");
  });
});

describe("Bash", () => {
  test("commands writing unwanted content to Markdown are denied", () => {
    for (const cmd of ["cat > notes.md <<'EOF'\nlicensed under MIT\nEOF", "echo 'licensed under MIT' | tee -a docs/a.md"]) {
      expect(decision(pre({ ...bash(cmd), cwd: P })), cmd).toBe("deny");
    }
  });

  test("other commands are allowed, including ones that only mention licence words", () => {
    const cmds = ["echo '# Notes' > notes.md", "cat LICENSE", "bun test", "python3 - x.ts <<'EOF'\nprint('blocked LICENSE: licence file')\nEOF"];
    for (const cmd of cmds) expect(untouched(pre({ ...bash(cmd), cwd: P })), cmd).toBe(true);
  });

  test("write targets are found in redirects, tee, cp/mv/ln, touch and sed -i, not in text", () => {
    const cases: [string, string[]][] = [
      ["echo hi > LICENSE", ["LICENSE"]],
      ["echo hi >> notes.md", ["notes.md"]],
      ["echo x > 'my notes.md'", ["my notes.md"]],
      ["ls &> out.md", ["out.md"]],
      ["ls &>> out.md", ["out.md"]],
      ["echo hi 1>a.md", ["a.md"]],
      ["echo x 2> err.md", []],
      ["cp template.txt ./COPYING", ["./COPYING"]],
      ["mv a.md b.md && echo done", ["b.md"]],
      ["echo x | tee -a docs/a.md", ["docs/a.md"]],
      ["echo x | tee --append notes.md", ["notes.md"]],
      ["touch LICENCE.md", ["LICENCE.md"]],
      ['sed -i "" s/a/b/ README.md', ["README.md"]],
      ["cat > notes.md <<'EOF'\nsome > other.md\nEOF", ["notes.md"]],
      ["cat LICENSE", []],
      ["grep -n licence src/hooks.ts", []],
      ["bun test 2>&1 | tail", []],
      ['echo "see LICENSE > here"', []],
      ["python3 - x.ts <<'EOF'\nprint('blocked LICENSE: licence file > a.md')\nEOF", []],
    ];
    for (const [cmd, want] of cases) expect(bashWriteTargets(cmd), cmd).toEqual(want);
  });
});

describe("when Jev can't answer", () => {
  test("allow mode lets the write through and tells the user", () => {
    const r = pre(write(at("notes.md"), "Plain text."), OUTAGE);
    expect(untouched(r)).toBe(true);
    expect(r.systemMessage).toContain("Jev classifier unavailable");
    expect(r.systemMessage).toContain("keywords only");
  });

  test("block mode denies during an outage, and tells the user too", () => {
    const block = { CLAUDE_PLUGIN_OPTION_JEV_ON_ERROR: "block" };
    expect(decision(pre(write(at("notes.md"), "Plain text."), { ...OUTAGE, ...block }))).toBe("deny");
    expect(pre(write(at("notes.md"), "Plain text."), { ...OUTAGE, ...block }).systemMessage).toContain("blocked until it responds");
  });

  test("without a key md-scrub is off: nothing is checked or blocked, whatever the option says", () => {
    const off = { OPENROUTER_API_KEY: "", CLAUDE_PLUGIN_OPTION_JEV_ON_ERROR: "block" };
    expect(pre(write(at("notes.md"), "This project is licensed under MIT. LICENSING"), off)).toBeNull();
    expect(run("pre", bash(`echo LICENSING > ${at("x.md")}`), off).out).toBe("");
    expect(run("stop", { session_id: "s-off", cwd: P }, off).out).toBe("");
  });

  test("a server error or a reply missing an answer is reported", () => {
    expect(pre(write(at("a.md"), "# A\n\nplain text\n"), { ...JEV, FAKE_JEV: "error" }).systemMessage).toContain("Jev HTTP 500");
    expect(pre(write(at("a.md"), "# A\n\nplain text\n"), { ...JEV, FAKE_JEV: "missing" }).systemMessage).toContain("missing an answer");
  });

});

describe("with Jev answering", () => {
  const clause = (n: number) => `## ${n}. Section\n\nMOSTLY These terms govern your use of the service. You may not resell, sublicense or share access, and we may suspend accounts that do.\n`;
  const terms = `# Terms\n\n${[1, 2, 3, 4, 5].map(clause).join("\n")}`; // a terms page, long enough to count as "mostly"

  test("a Write that is mostly the topic is blocked without asking, and Claude is told to use it from context", () => {
    const r = pre({ ...write(at("terms.md"), terms), tool_use_id: "toolu_mostly1" }, JEV);
    expect(decision(r)).toBe("deny");
    expect(reason(r)).toContain("it is mostly third-party licensing content (about 95%)");
    expect(reason(r)).toContain("use the content from context");
    expect(stateJson("calls/toolu_mostly1.json").outcome).toBe("blocked");
  });

  test("a file where the topic is a small part, or a short note, is cleaned rather than blocked", () => {
    const notes = "# Notes\n\nThe service resizes images on upload.\nWe use zod, licensed under MIT, for validation.\nRun `bun dev` to start it.\n";
    const small = pre(write(at("notes.md"), notes), JEV).hookSpecificOutput;
    expect(small.permissionDecision).toBeUndefined();
    expect(small.updatedInput.content).not.toContain("licensed under");
    const short = pre(write(at("short.md"), "# Email\n\nWe use Postmark.\nMOSTLY Their terms prohibit purchased lists, licensed under MIT.\n"), JEV).hookSpecificOutput;
    expect(short.permissionDecision).toBeUndefined();
    expect(short.updatedInput.content).not.toContain("purchased lists");
  });

  test("a keyword hit Jev scores low is let through, such as text describing the rule", () => {
    expect(pre(write(at("rules.md"), "# Rules\n\nNever copy what a vendor's terms of service say into these notes.\n"), JEV)).toBeNull();
  });
});

describe("progress records for the status mod", () => {
  test("a cleaned write is recorded", () => {
    pre({ ...write(at("notes.md"), DOC("We use zod (MIT).")), tool_use_id: "toolu_clean1", session_id: "s-progress-clean" });
    const r = stateJson("calls/toolu_clean1.json");
    expect(r).toMatchObject({ outcome: "cleaned", edits: 1, file: at("notes.md") });
  });

  test("a block is recorded with a short reason", () => {
    pre({ ...write(at("notes.md"), DOC("Released, licensed under MIT.")), tool_use_id: "toolu_block1" }, { FAKE_MODE: "noop" });
    const r = stateJson("calls/toolu_block1.json");
    expect(r.outcome).toBe("blocked");
    expect(r.reason).toStartWith("notes.md: line ");
  });

  test("nothing is written for calls md-scrub ignores", () => {
    pre({ ...write(at("app.ts"), "x"), tool_use_id: "toolu_ignored", session_id: "s-progress-ignored" });
    expect(() => stateJson("calls/toolu_ignored.json")).toThrow();
  });
});

describe("start-up check", () => {
  const CHECK = join(ROOT, "hooks", "check.sh");

  test("is silent when everything is in place", () => {
    expect(run("session-start", {}, { OPENROUTER_API_KEY: "test" }).out).toBe("");
  });

  test("names a missing key and a missing claude in one message", () => {
    const msg = run("session-start", {}, { PATH: PATH_WITHOUT_CLAUDE, OPENROUTER_API_KEY: "" }).json.systemMessage;
    expect(msg).toContain("off until you add an OpenRouter key");
    expect(msg).toContain("`claude` isn't on the PATH");
  });

  test("names a broken settings or topic file", () => {
    const p = tmp("proj");
    mkdirSync(join(p, ".md-scrub", "topics"), { recursive: true });
    writeFileSync(join(p, ".md-scrub", "topics", "bad.json"), "{ nope");
    expect(run("session-start", { cwd: p }, { OPENROUTER_API_KEY: "test" }).json.systemMessage).toContain("not valid JSON");
  });

  test("leaves the most serious problem for the status line, and clears it once fixed", () => {
    const p = tmp("proj");
    run("session-start", { cwd: p }, { PATH: PATH_WITHOUT_CLAUDE, OPENROUTER_API_KEY: "" });
    expect(stateJson("setup.json")).toEqual({ cwd: p, line: "off: add your OpenRouter key in /plugin > Installed > md-scrub > Configure (+1 more)" });
    run("session-start", { cwd: p }, { PATH: PATH_WITHOUT_CLAUDE });
    expect(stateJson("setup.json").line).toBe("can't clean, only block: claude isn't on the PATH");
    run("session-start", { cwd: p }, { OPENROUTER_API_KEY: "test" });
    expect(stateJson("setup.json")).toEqual({ cwd: p, line: null });
  });

  test("check.sh reports a missing Bun without needing Bun", () => {
    const bin = tmp("bin"); // only sh, so the test holds wherever Bun happens to be installed
    for (const tool of ["sh", "mkdir", "sed"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
    const state = tmp("state");
    const p = Bun.spawnSync(["/bin/sh", CHECK], { cwd: bin, env: { PATH: bin, XDG_STATE_HOME: state }, stdin: Buffer.from("{}") });
    expect(JSON.parse(p.stdout.toString()).systemMessage).toContain("Bun is not on the PATH");
    expect(JSON.parse(readFileSync(join(state, "md-scrub", "setup.json"), "utf8")).line).toBe("not running: Bun isn't on the PATH");
  });

  test("check.sh hands over to md-scrub, which ignores a .env in the project", () => {
    const p = tmp("proj");
    writeFileSync(join(p, ".env"), "OPENROUTER_API_KEY=sk-from-the-project\n");
    // No key in the environment at all, since a .env never overrides a variable that is set, even empty.
    const { OPENROUTER_API_KEY: _key, ...rest } = ENV;
    const env = { ...rest, PATH: `${dirname(process.execPath)}:${PATH_WITH_CLAUDE}` };
    const viaCheck = Bun.spawnSync(["/bin/sh", CHECK], { cwd: p, env, stdin: Buffer.from("{}") });
    expect(JSON.parse(viaCheck.stdout.toString()).systemMessage).toContain("off until you add an OpenRouter key");
    // The control: without --no-env-file, Bun would have loaded the project's key.
    const plain = Bun.spawnSync([process.execPath, CLI, "session-start"], { cwd: p, env, stdin: Buffer.from("{}") });
    expect(plain.stdout.toString()).not.toContain("OpenRouter key");
  });
});

describe("hooks/hooks.json", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;

  test("runs Bun without loading the project's .env", () => {
    const commands = Object.values<any[]>(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    for (const h of commands.filter((h) => h.command === "bun")) expect(h.args[0], JSON.stringify(h.args)).toBe("--no-env-file");
    expect(readFileSync(join(ROOT, "hooks", "check.sh"), "utf8")).toContain("exec bun --no-env-file");
  });

  test("records command end times for Bash only", () => {
    expect(hooks.PostToolUse.map((g: any) => g.matcher)).toEqual(["Bash"]);
    expect(hooks.PostToolUseFailure.map((g: any) => g.matcher)).toEqual(["Bash"]);
  });
});
