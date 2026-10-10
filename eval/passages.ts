// Scores labelled passages with Jev alone (keywords skipped), to set thresholds.flag.
//   bun eval/passages.ts            the tuning set
//   bun eval/passages.ts holdout    the held-out set
import { jevScore, pool } from "../src/detect.ts";
import { loadScrubConfig } from "../src/scrub.ts";
import tuning from "./cases/passages.ts";
import holdout from "./cases/passages-holdout.ts";

const cases = process.argv[2] === "holdout" ? holdout : tuning;
const scrub = loadScrubConfig();
const rows = await pool(cases, async ([label, text]) => {
  const r = await jevScore(text, scrub);
  return { label, text, p: "p" in r ? r.p : NaN, error: "error" in r ? r.error : undefined };
});

for (const r of rows) {
  console.log(`${r.label ? "HIT " : "PASS"}  ${Number.isNaN(r.p) ? "ERR " : r.p.toFixed(2)}  ${r.text.replace(/\n/g, " ").slice(0, 90)}${r.error ? `  [${r.error}]` : ""}`);
}
const hits = rows.filter((r) => r.label).length;
for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
  const caught = rows.filter((r) => r.label && r.p >= t).length;
  const falseBlocks = rows.filter((r) => !r.label && r.p >= t).length;
  console.log(`threshold ${t}: hits caught ${caught}/${hits}, false blocks ${falseBlocks}/${rows.length - hits}`);
}
