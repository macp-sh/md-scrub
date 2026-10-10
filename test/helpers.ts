// Shared harness. Hooks run as Claude Code runs them: a separate Bun process per event, reading JSON
// on stdin. Nothing in src/ knows about tests:
//   - a fake `claude` (test/fake-claude.ts) sits first on PATH, standing in for Haiku
//   - test/jev-mock.ts is preloaded into each hook process and answers Jev requests (see FAKE_JEV)
//   - topics come from a temporary project whose .md-scrub/ holds test/fixture
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const CLI = join(ROOT, "src", "cli.ts");
export const JEV_MOCK = join(import.meta.dir, "jev-mock.ts");
export const STATE = join(process.env.XDG_STATE_HOME!, "md-scrub");
export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `md-scrub-${prefix}-`));

// A bin folder holding only the fake claude, with absolute paths so PATH needn't hold Bun.
export const FAKE_BIN = tmp("bin");
writeFileSync(join(FAKE_BIN, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fake-claude.ts")}' "$@"\n`);
chmodSync(join(FAKE_BIN, "claude"), 0o755);
export const PATH_WITH_CLAUDE = `${FAKE_BIN}:/usr/bin:/bin`;
export const PATH_WITHOUT_CLAUDE = "/usr/bin:/bin";

// By default Jev has a key but can't be reached, so the keyword fallback decides; tests of Jev itself
// set FAKE_JEV, and tests of a missing key clear OPENROUTER_API_KEY.
export const ENV: Record<string, string | undefined> = { ...process.env, PATH: PATH_WITH_CLAUDE, OPENROUTER_API_KEY: "test", FAKE_JEV: "down", MD_SCRUB_INNER: "" };

// A project whose .md-scrub/ holds the fixture topic (broad licensing keywords) with the shipped topic
// switched off, so editing the shipped definition breaks nothing here.
export function fixtureProject(): string {
  const dir = tmp("proj");
  cpSync(join(import.meta.dir, "fixture"), join(dir, ".md-scrub"), { recursive: true });
  return dir;
}

// A project with its own .md-scrub/ (config.json, topic files, other raw files) and no fixture.
export function project(opts: { config?: unknown; topics?: Record<string, unknown>; raw?: Record<string, string> } = {}) {
  const dir = tmp("proj");
  const folder = join(dir, ".md-scrub");
  mkdirSync(join(folder, "topics"), { recursive: true });
  if (opts.config) writeFileSync(join(folder, "config.json"), JSON.stringify(opts.config));
  for (const [id, t] of Object.entries(opts.topics ?? {})) writeFileSync(join(folder, "topics", `${id}.json`), JSON.stringify(t));
  for (const [name, text] of Object.entries(opts.raw ?? {})) writeFileSync(join(folder, name), text);
  mkdirSync(join(dir, "docs"));
  return { dir, file: join(dir, "docs", "a.md") };
}

// Runs one hook event the way hooks/hooks.json does (bun --no-env-file), with the Jev mock preloaded.
export function run(event: string, input?: unknown, env: Record<string, string | undefined> = {}, cwd?: string) {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "--preload", JEV_MOCK, CLI, event], {
    stdin: input === undefined ? "ignore" : Buffer.from(typeof input === "string" ? input : JSON.stringify(input)),
    env: { ...ENV, ...env },
    cwd,
  });
  const out = p.stdout.toString().trim();
  return { code: p.exitCode, out, err: p.stderr.toString(), json: out.startsWith("{") ? JSON.parse(out) : null };
}

export const pre = (input: unknown, env: Record<string, string | undefined> = {}) => run("pre", input, env).json;
export const write = (file_path: string, content: string) => ({ tool_name: "Write", tool_input: { file_path, content } });
export const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
export const decision = (r: any) => r?.hookSpecificOutput?.permissionDecision;
// Without a Jev key a passing write may still carry a notice for the user; nothing else may come back.
export const untouched = (r: any) => r === null || (r.hookSpecificOutput === undefined && Object.keys(r).every((k) => k === "systemMessage"));
export const DOC = (extra: string) => `# Notes\n\nThe service resizes images on upload and stores them in R2.\nIt runs on Bun and deploys to Fly.\n${extra}\nRun \`bun dev\` to start it locally.\n`;
export const stateJson = (rel: string) => JSON.parse(readFileSync(join(STATE, rel), "utf8"));
export const sessionId = () => `s-${Math.random().toString(36).slice(2)}`;
