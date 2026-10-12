import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { PROVIDERS } from "./jev-model.ts";

export const ROOT = dirname(import.meta.dir);

// $HOME first, so a process given another home (tests) uses it; Bun's homedir() ignores a changed HOME.
const HOME = process.env.HOME || homedir();

// Your settings, topics and exclusions, beside Claude Code's own ~/.claude files. State and the log
// live under it too, outside the plugin's install folder (replaced on every update); the status mod
// derives the same path from $HOME.
export const USER_DIR = join(HOME, ".claude", "md-scrub");
export const STATE_DIR = join(USER_DIR, "state");
export const LOG_FILE = join(STATE_DIR, "log.jsonl");
mkdirSync(STATE_DIR, { recursive: true });

// Claude Code exports the plugin's options to its hooks as CLAUDE_PLUGIN_OPTION_<KEY>.
const env = process.env;

export const config = {
  jevTimeoutMs: 8000,
  chunkChars: 3000,
  concurrency: 6,
  haikuModel: "claude-haiku-5-5",
  haikuTimeoutMs: 45000,
  // Largest share of a chunk Haiku may change before the clean-up is rejected, though it may always
  // delete up to minChangeChars, so a short note can lose its one bad sentence.
  maxChangeRatio: 0.6,
  minChangeChars: 200,
  // Shorter texts are never "mostly" a topic: a note with one bad sentence in two scores around half,
  // but should be scrubbed, not flagged.
  mostlyMinChars: 500,
  // How many entries the sweep looks through per folder before giving up (and saying so).
  walkLimit: 20_000,
  // Claude Code's timeouts for these hooks are 120 s (PreToolUse) and 300 s (Stop); finish well inside them.
  preBudgetMs: 100_000,
  stopBudgetMs: 280_000,
};

// Each hook call sets a deadline below Claude Code's timeout for it; Jev and Haiku calls stop in time,
// so a slow run ends in a reported block rather than the hook being killed and the write going through.
export const budget = { until: Number.POSITIVE_INFINITY };
export const remainingMs = () => budget.until - Date.now();

// The project the session belongs to: Claude Code's project root, else the folder the hook ran in.
// Its settings live in <root>/.claude/md-scrub/. Set once per hook call by cli.ts.
export const project = { root: undefined as string | undefined };
export const setProjectRoot = (cwd: string | undefined) => (project.root = env.CLAUDE_PROJECT_DIR || cwd || undefined);

// Jev is reached through one of PROVIDERS (src/jev-model.ts), never both: TypeSafe's own API when its
// key is set, else OpenRouter. There is no failover.
export type Provider = (typeof PROVIDERS)[keyof typeof PROVIDERS] & { key: string };

export function jevProvider(): Provider | undefined {
  const typesafe = env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY || env.TYPESAFE_API_KEY;
  if (typesafe) return { ...PROVIDERS.typesafe, key: typesafe };
  const openrouter = env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY || env.OPENROUTER_API_KEY;
  if (openrouter) return { ...PROVIDERS.openrouter, key: openrouter };
}

export const apiKey = () => jevProvider()?.key;

export function log(entry: Record<string, unknown>) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

// A session id or tool-use id made safe to use in a file name.
export const safe = (s: string) => String(s).replace(/[^\w-]/g, "");
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
