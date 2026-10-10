#!/usr/bin/env bun
// Stands in for `claude -p` in tests. FAKE_MODE=noop returns no edits; otherwise it
// deletes every excerpt line containing an obvious licensing marker.
const prompt = process.argv.at(-1) ?? "";
const excerpt = prompt.match(/<(excerpt-\w+)>\n([\s\S]*)\n<\/\1>/)?.[2] ?? "";
// FAKE_TOUCH=<path> changes that file while "cleaning", as the user's editor might mid-check.
if (process.env.FAKE_TOUCH) require("node:fs").appendFileSync(process.env.FAKE_TOUCH, "\nedited meanwhile\n");
// FAKE_MODE=reword returns an edit that adds text, as a prompt-injected Haiku might.
const firstLine = excerpt.split("\n").find((l) => l.trim()) ?? "";
const edits = process.env.FAKE_MODE === "reword" ? [{ find: firstLine, replace: "INJECTED TEXT" }] : process.env.FAKE_MODE === "noop" ? [] :
  excerpt.split("\n").filter((l) => /licensed under|©|\(MIT\)|GPL/i.test(l)).map((l) => ({ find: excerpt.includes(l + "\n") ? l + "\n" : l, replace: "" }));
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0, duration_ms: 1, structured_output: { edits } }));
