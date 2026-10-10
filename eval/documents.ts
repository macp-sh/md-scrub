// Whole-document "mostly" share from Jev on labelled documents, to set thresholds.mostly.
//   bun eval/documents.ts            the tuning set
//   bun eval/documents.ts holdout    the held-out set
import { detect } from "../src/detect.ts";
import { loadScrubConfig } from "../src/scrub.ts";
import tuning from "./cases/documents.ts";
import holdout from "./cases/documents-holdout.ts";

const cases = process.argv[2] === "holdout" ? holdout : tuning;
const scrub = loadScrubConfig();
const rows = [];
for (const c of cases) {
  const d = await detect(c.text, scrub);
  rows.push({ ...c, share: d.mostly });
  console.log(`${c.mostly ? "MOSTLY" : "OTHER "}  ${d.mostly === undefined ? "ERR " : d.mostly.toFixed(2)}  ${c.name}${d.jevError ? `  [${d.jevError}]` : ""}`);
}
for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
  const caught = rows.filter((r) => r.mostly && (r.share ?? 0) >= t).length;
  const wrong = rows.filter((r) => !r.mostly && (r.share ?? 0) >= t).length;
  console.log(`threshold ${t}: mostly caught ${caught}/${rows.filter((r) => r.mostly).length}, others wrongly flagged ${wrong}/${rows.filter((r) => !r.mostly).length}`);
}
