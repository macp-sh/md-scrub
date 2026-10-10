// Progress and outcome records the md-scrub-status mod reads to draw its status line.
//   state/calls/<id>.json     one per hook call: what it's doing now, then how it ended
import { writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, LOG_FILE, safe } from "./config.ts";

const CALLS_DIR = join(STATE_DIR, "calls");
const KEEP_CALLS_MS = 60 * 60 * 1000;
const KEEP_TURNS_MS = 24 * 60 * 60 * 1000;
// Past this size the log moves to log.old.jsonl (replacing the previous one) and starts afresh.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// The setup problem the mod keeps on the status line until it's fixed, written at session start:
//   state/setup.json   { cwd, line }, line null when all is well
export const SETUP_FILE = join(STATE_DIR, "setup.json");

export type Outcome = "clean" | "cleaned" | "blocked" | "moved" | "error";

export type CallRecord = {
  id: string;
  file: string;
  phase: string; // human-readable: "checking", "cleaning 1 section", "re-checking", "done"
  startedAt: number;
  endedAt?: number;
  outcome?: Outcome;
  edits?: number;
  reason?: string;
};

export function writeJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path); // the mod never reads a half-written file
}

export class Call {
  private record: CallRecord;
  private path: string;

  constructor(id: string, file: string) {
    mkdirSync(CALLS_DIR, { recursive: true });
    prune();
    this.path = join(CALLS_DIR, `${safe(id)}.json`);
    this.record = { id, file, phase: "checking", startedAt: Date.now() };
    writeJson(this.path, this.record);
  }

  phase(phase: string) {
    this.record.phase = phase;
    writeJson(this.path, this.record);
  }

  end(outcome: Outcome, extra: Partial<CallRecord> = {}) {
    Object.assign(this.record, { outcome, phase: "done", endedAt: Date.now() }, extra);
    writeJson(this.path, this.record);
  }
}

// Old call records and turn files are deleted; an oversized log is rotated.
function prune() {
  const now = Date.now();
  for (const [dir, keepMs, prefix] of [[CALLS_DIR, KEEP_CALLS_MS, ""], [STATE_DIR, KEEP_TURNS_MS, "turn-"]] as const) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith(prefix)) continue;
      const p = join(dir, n);
      try { if (statSync(p).mtimeMs < now - keepMs) unlinkSync(p); } catch {}
    }
  }
  try { if (statSync(LOG_FILE).size > MAX_LOG_BYTES) renameSync(LOG_FILE, join(STATE_DIR, "log.old.jsonl")); } catch {}
}
