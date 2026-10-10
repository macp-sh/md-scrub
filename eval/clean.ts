// Runs detection and Haiku clean-up on mixed documents. A case passes when the result
// no longer flags and every `keep` string survives unchanged.
// Run from the project root: bun eval/clean.ts
import { detect } from "../src/detect.ts";
import { clean, summariseEdits } from "../src/clean.ts";
import { loadScrubConfig } from "../src/scrub.ts";

// `allowed` cases contain only content the topic allows (own licence, dependency licence names): they must pass untouched.
const cases: { name: string; text: string; keep: string[]; allowed?: true }[] = [
  {
    name: "dependency licences named in prose stay",
    allowed: true,
    text: `# Image service

## Dependencies

We use zod (MIT) for validation and sharp (Apache 2.0) for resizing. Both are fast and well maintained.

## Running

Run \`bun dev\` and open localhost:3000.
`,
    keep: ["# Image service", "for validation", "for resizing", "Both are fast and well maintained.", "Run `bun dev` and open localhost:3000."],
  },
  {
    name: "licence column in a dependency table stays",
    allowed: true,
    text: `## Libraries

| Library | Version | Licence | Purpose |
| --- | --- | --- | --- |
| zod | 3.23 | MIT | Validation |
| hono | 4.6 | MIT | HTTP routing |
| sharp | 0.33 | Apache-2.0 | Image resizing |

All three are pinned in bun.lock.
`,
    keep: ["Validation", "HTTP routing", "Image resizing", "All three are pinned in bun.lock.", "3.23"],
  },
  {
    name: "whole licensing section among normal sections",
    text: `# Mapping notes

## Provider choice

We chose Mapbox because the styling API is flexible and vector tiles load quickly.

## Attribution and terms

Mapbox terms require their wordmark and a credit link on every map. OSM data must be credited wherever tiles are shown.

## Caching

Tiles are cached for 12 hours in the CDN.
`,
    keep: ["## Provider choice", "styling API is flexible", "## Caching", "Tiles are cached for 12 hours in the CDN."],
  },
  {
    name: "paraphrased service terms mid-paragraph",
    text: `## SMS reminders

Reminders go out through Twilio at 9am local time. Twilio's acceptable use policy forbids marketing messages without opt-in consent. Failed sends retry twice.
`,
    keep: ["## SMS reminders", "Reminders go out through Twilio at 9am local time.", "Failed sends retry twice."],
  },
  {
    name: "own copyright footer and licence badge stay",
    allowed: true,
    text: `# md-demo

![build](https://img.shields.io/badge/build-passing-green) ![licence](https://img.shields.io/badge/license-MIT-blue)

A tiny demo app.

---

© 2026 Acme Pty Ltd. Released under the MIT License.
`,
    keep: ["# md-demo", "badge/build-passing-green", "A tiny demo app."],
  },
  {
    name: "borderline content and own licence line stay",
    allowed: true,
    text: `## Costs

Pro plan is $20/month per user and we have 5 Figma seats. TODO: check licence compatibility before adding the PDF library. The core package is licensed under MIT.
`,
    keep: ["Pro plan is $20/month per user", "5 Figma seats", "TODO: check licence compatibility before adding the PDF library."],
  },
];

const scrub = loadScrubConfig();
let passed = 0;
for (const c of cases) {
  const t0 = performance.now();
  const d = await detect(c.text, scrub);
  if (c.allowed) {
    const ok = !d.flagged.length;
    if (ok) passed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${ok ? "" : `: flagged lines ${d.flagged.map((f) => `${f.from}-${f.to}`).join(", ")}`}`);
    continue;
  }
  if (!d.flagged.length) { console.log(`FAIL  ${c.name}: nothing detected`); continue; }
  const r = await clean(c.text, d.flagged, undefined, scrub);
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) { console.log(`FAIL  ${c.name}: ${r.error} (${ms} ms)`); continue; }
  const lost = c.keep.filter((k) => !r.text.includes(k));
  const ok = lost.length === 0;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name} (${ms} ms)${lost.length ? `\n      lost: ${lost.join(" | ")}` : ""}`);
  console.log(summariseEdits(r.edits).split("\n").map((l) => `      ${l}`).join("\n"));
}
console.log(`\n${passed}/${cases.length} passed`);
