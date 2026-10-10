// What happened during the current turn, so the end-of-turn sweep only looks at files Claude wrote.
// Hooks for parallel tool calls run at the same time, so events are appended one line each to
// turn-<session>.events.jsonl rather than rewriting a shared file.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, safe } from "./config.ts";

type TurnEvent =
  | { type: "touch"; file: string } // Write/Edit/MultiEdit target
  | { type: "bash"; id: string; at: number; cwd?: string } // a Bash command started
  | { type: "bashEnd"; id: string; at: number } // and finished
  | { type: "problems"; hash: string | null }; // what the last sweep asked Claude to fix

const eventsFile = (sessionId: string | undefined) => join(STATE_DIR, `turn-${safe(sessionId ?? "unknown")}.events.jsonl`);

export function startTurn(sessionId: string | undefined) {
  writeFileSync(eventsFile(sessionId), "");
}

export function record(sessionId: string | undefined, event: TurnEvent) {
  try {
    appendFileSync(eventsFile(sessionId), JSON.stringify(event) + "\n");
  } catch {}
}

const MAX_BASH_MS = 10 * 60 * 1000;

export type Turn = {
  started: boolean; // false when no prompt started a turn this session (nothing to sweep)
  touched: Set<string>;
  bashWindows: { start: number; end: number; cwd?: string }[];
  lastProblems: string | null;
};

export function readTurn(sessionId: string | undefined, now = Date.now()): Turn {
  const turn: Turn = { started: false, touched: new Set(), bashWindows: [], lastProblems: null };
  const path = eventsFile(sessionId);
  if (!existsSync(path)) return turn;
  turn.started = true;
  const starts = new Map<string, { at: number; cwd?: string }>();
  const ends = new Map<string, number>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let e: TurnEvent;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "touch") turn.touched.add(e.file);
    if (e.type === "bash") starts.set(e.id, { at: e.at, cwd: e.cwd });
    if (e.type === "bashEnd") ends.set(e.id, e.at);
    if (e.type === "problems") turn.lastProblems = e.hash;
  }
  // A command with no end event was interrupted or is still running in the background. Its window is
  // capped at Bash's longest timeout, so a stray start can't make every later change count as Claude's.
  for (const [id, s] of starts) turn.bashWindows.push({ start: s.at, end: ends.get(id) ?? Math.min(now, s.at + MAX_BASH_MS), cwd: s.cwd });
  return turn;
}
