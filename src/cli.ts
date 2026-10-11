#!/usr/bin/env bun
// Entry point for md-scrub's Claude Code hooks: `cli.ts <event>`, reading the hook's JSON on stdin.
import { pre, post, stop, turnStart, sessionStart } from "./hooks.ts";
import { apiKey, setProjectRoot } from "./config.ts";

async function hook(event: string) {
  if (process.env.MD_SCRUB_INNER) return; // our own Haiku call; never recurse
  // Without a key md-scrub is off: only the start-up check runs, to say so.
  if (event !== "session-start" && !apiKey()) return;
  const raw = await Bun.stdin.text();
  let input: any = {};
  try {
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ systemMessage: `md-scrub: couldn't read the hook input, so this ${event} wasn't checked.` }) + "\n");
    return;
  }
  setProjectRoot(input.cwd);
  const out =
    event === "pre" ? await pre(input)
    : event === "post" ? post(input)
    : event === "stop" ? await stop(input)
    : event === "turn-start" ? turnStart(input)
    : event === "session-start" ? sessionStart(input)
    : null;
  if (out) process.stdout.write(JSON.stringify(out) + "\n");
}

const EVENTS = ["pre", "post", "turn-start", "stop", "session-start"];
const event = process.argv[2];
if (!event || !EVENTS.includes(event)) {
  console.error(`usage: cli.ts <${EVENTS.join("|")}>  (run by Claude Code's hooks)`);
  process.exit(1);
}
await hook(event);
