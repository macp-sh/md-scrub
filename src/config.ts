import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const ROOT = dirname(import.meta.dir);

// One state folder for the hooks and the status mod, outside the plugin's install folder (which is
// replaced on every update). The mod derives the same path from $HOME.
export const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "md-scrub");
export const LOG_FILE = join(STATE_DIR, "log.jsonl");
mkdirSync(STATE_DIR, { recursive: true });

// Claude Code exports the plugin's options to its hooks as CLAUDE_PLUGIN_OPTION_<KEY>.
const env = process.env;

export const config = {
  jevModel: "typesafe/jev-1.13",
  jevUrl: "https://openrouter.ai/api/alpha/decisions",
  jevTimeoutMs: 8000,
  // "allow" or "block" when Jev can't answer (no key, network error, timeout).
  jevOnError: env.CLAUDE_PLUGIN_OPTION_JEV_ON_ERROR || "allow",
  chunkChars: 3000,
  concurrency: 6,
  haikuModel: "claude-haiku-5-5",
  haikuTimeoutMs: 45000,
  // Largest share of a chunk Haiku may change before the clean-up is rejected, though it may always
  // delete up to minChangeChars, so a short note can lose its one bad sentence.
  maxChangeRatio: 0.6,
  minChangeChars: 200,
  // Shorter texts are never "mostly" a topic: a note with one bad sentence in two scores around half,
  // but should be cleaned, not blocked or moved.
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

export function apiKey() {
  return env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY || env.OPENROUTER_API_KEY;
}

export function log(entry: Record<string, unknown>) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

// A session id or tool-use id made safe to use in a file name.
export const safe = (s: string) => String(s).replace(/[^\w-]/g, "");
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
