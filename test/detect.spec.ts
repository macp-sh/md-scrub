// Detection (keywords, chunking, Jev's scores) and the clean-up's safety rules, in process.
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { keywordHits, chunk, joinChunks, detect } from "../src/detect.ts";
import { isDeletion, clean } from "../src/clean.ts";
import { budget, setProjectRoot } from "../src/config.ts";
import { loadScrubConfig } from "../src/scrub.ts";
import { fixtureProject } from "./helpers.ts";

const P = fixtureProject();
setProjectRoot(P);
const FIX = loadScrubConfig(join(P, "x.md"));

describe("keywords", () => {
  test("flag each line that matches", () => {
    const hits = [
      "This package is licensed under MIT.", "Uses `sharp` (Apache-2.0).", "License: GPL-3.0-or-later",
      "![licence](https://img.shields.io/badge/license-MIT-blue)", "GPL is copyleft, so linking it would require us to open-source the app.",
      "© 2026 Mapbox, Inc.", "Copyright (c) Vercel", "OpenRouter's terms of service prohibit reselling API access.",
      "Twilio's acceptable use policy forbids marketing SMS without opt-in.", "The free tier is for non-commercial use only.",
      "Inter is under the SIL Open Font License.", "Photo from Unsplash, free under the Unsplash License.", "Dataset is CC BY 4.0.",
      "Dependencies: zod (MIT), sharp (Apache 2.0).", "| zod | MIT |", "We can't use that one, it's GPL.",
      "ffmpeg is LGPLv2 so it must be dynamically linked.", "Both are MIT-licensed.", "It ships under a BSD 3-clause licence.",
    ];
    for (const h of hits) expect(keywordHits(h, 1, FIX).length, h).toBe(1);
  });

  test("leave look-alikes alone", () => {
    const passes = [
      "Install with `bun add stripe`.", "The API needs an `Authorization` header.", "We hired a licensed electrician.",
      "Driver's licence scanning feature.", "Copy the config to `.env`.", "We have 5 Figma seats.", "Pro plan is $20/month per user.",
      "TODO: check licence compatibility before adding this.", "Set LICENSE_KEY in .env.", "We stream events through Apache Kafka.",
      "An MIT study found the cache helps.", "Runs on FreeBSD and Linux.", "Uses Boost.Asio for networking.", "Download it from the Mozilla add-ons site.",
    ];
    for (const t of passes) expect(keywordHits(t, 1, FIX), t).toEqual([]);
  });

  test("report every matching line with its number", () => {
    expect(keywordHits("a\n© 2026 Acme\nb\nzod (MIT)\n", 1, FIX).map((h) => h.line)).toEqual([2, 4]);
  });
});

describe("chunking", () => {
  test("splits an over-long line so no chunk outgrows a Jev request, and rejoins exactly", () => {
    const text = `intro\n${"word ".repeat(10_000)}\nend`;
    const chunks = chunk(text);
    expect(Math.max(...chunks.map((c) => c.body.length))).toBeLessThanOrEqual(6000);
    expect(joinChunks(chunks)).toBe(text);
  });

  test("rejoins ordinary text exactly, including CRLF and a trailing newline", () => {
    const text = "a\r\nb\r\n\r\n" + "x\n".repeat(4000) + "last\n";
    expect(joinChunks(chunk(text))).toBe(text);
  });
});

describe("Jev", () => {
  // In this process Jev is stubbed directly: chunks containing MOSTLY are judged mostly the topic.
  async function withJev<T>(fn: () => Promise<T>): Promise<T> {
    const realFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = "test";
    globalThis.fetch = (async (_url: any, init: any) => {
      const { state, questions } = JSON.parse(init.body);
      const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: /MOSTLY/.test(state.chunk) ? 0.9 : 0.1 }]));
      return Response.json({ answers });
    }) as typeof fetch;
    try { return await fn(); } finally {
      globalThis.fetch = realFetch;
      process.env.OPENROUTER_API_KEY = "";
    }
  }

  test("decides alone when it answers: a keyword hit it scores low isn't flagged", async () => {
    const d = await withJev(() => detect("We use zod (MIT).", FIX));
    expect(d.flagged).toEqual([]);
    expect(d.jevError).toBeUndefined();
  });

  test("the mostly share is weighted by chunk length", async () => {
    const text = `${"MOSTLY terms. ".repeat(250)}\n\n${"Plain notes. ".repeat(500)}`;
    const chunks = chunk(text).filter((c) => c.body.trim());
    const score = (body: string) => (/MOSTLY/.test(body) ? 0.9 : 0.1);
    expect(new Set(chunks.map((c) => score(c.body))).size).toBe(2);
    const total = chunks.reduce((n, c) => n + c.body.length, 0);
    const want = chunks.reduce((n, c) => n + score(c.body) * c.body.length, 0) / total;
    expect(want).not.toBeCloseTo(0.5, 2);
    const d = await withJev(() => detect(text, FIX));
    expect(d.mostly).toBeCloseTo(want, 5);
  });

  // One provider per call: TypeSafe's own API when its key is set (even beside an OpenRouter key),
  // else OpenRouter; each with its own endpoint, model and key.
  test.each([
    [{ OPENROUTER_API_KEY: "or" }, "https://openrouter.ai/api/alpha/decisions", "typesafe/jev-1.13", "Bearer or"],
    [{ TYPESAFE_API_KEY: "ts" }, "https://api.typesafe.ai/v1/systemone", "jev-1.13.0", "Bearer ts"],
    [{ OPENROUTER_API_KEY: "or", TYPESAFE_API_KEY: "ts" }, "https://api.typesafe.ai/v1/systemone", "jev-1.13.0", "Bearer ts"],
  ])("with keys %o, Jev is called at %s", async (keys: Record<string, string>, url: string, model: string, auth: string) => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    Object.assign(process.env, keys);
    globalThis.fetch = (async (to: any, init: any) => {
      calls.push(`${to} ${JSON.parse(init.body).model} ${init.headers.Authorization}`);
      const answers = Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map((id) => [id, { noul: 0.1 }]));
      return Response.json({ answers });
    }) as typeof fetch;
    try {
      await detect("We use zod (MIT).", FIX);
    } finally {
      globalThis.fetch = realFetch;
      process.env.OPENROUTER_API_KEY = "";
      process.env.TYPESAFE_API_KEY = "";
    }
    expect(new Set(calls)).toEqual(new Set([`${url} ${model} ${auth}`]));
  });

  describe("a topic's own Jev settings", () => {
    // Every question scores 0.5; requests are recorded as `<model>: <question ids>`.
    async function scored<T>(fn: () => Promise<T>): Promise<{ result: T; requests: string[] }> {
      const realFetch = globalThis.fetch;
      const requests: string[] = [];
      process.env.OPENROUTER_API_KEY = "or";
      globalThis.fetch = (async (_url: any, init: any) => {
        const { model, questions } = JSON.parse(init.body);
        requests.push(`${model}: ${Object.keys(questions).sort().join(" ")}`);
        return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: 0.5 }])) });
      }) as typeof fetch;
      try { return { result: await fn(), requests }; } finally {
        globalThis.fetch = realFetch;
        process.env.OPENROUTER_API_KEY = "";
      }
    }
    const base = FIX.topics[0]!;
    const withTopics = (...topics: typeof FIX.topics) => ({ ...FIX, topics });

    test("its flag threshold replaces the settings' for it alone", async () => {
      const strict = { ...base, id: "strict", jev: { flag: 0.6 } };
      const { result } = await scored(() => detect("Plain notes.", withTopics(base, strict)));
      expect(result.flagged.flatMap((f) => f.topics)).toEqual([base.id]);
    });

    test("its model gets a request of its own; the rest share md-scrub's", async () => {
      const own = { ...base, id: "own", jev: { model: "typesafe/jev-9" } };
      const { requests } = await scored(() => detect("Plain notes.", withTopics(base, own)));
      expect(requests.sort()).toEqual([
        `typesafe/jev-1.13: ${base.id} ${base.id}__mostly`,
        "typesafe/jev-9: own own__mostly",
      ]);
    });

    test("its mostly threshold decides whether the text is mostly it", async () => {
      const strict = { ...base, id: "strict", jev: { mostly: 0.6 } };
      const { result } = await scored(() => detect("Plain notes.", withTopics(base, strict)));
      expect(result.mostly).toBeCloseTo(0.5, 5);
      expect(result.mostlyTopics).toEqual([base.id]);
    });
  });

  test("a TypeSafe error body is reported, whatever its shape", async () => {
    const realFetch = globalThis.fetch;
    process.env.TYPESAFE_API_KEY = "ts";
    globalThis.fetch = (async () => Response.json({ detail: [{ loc: ["body", "model"], msg: "unknown model" }] }, { status: 422 })) as unknown as typeof fetch;
    try {
      const d = await detect("We use zod (MIT).", FIX);
      expect(d.flagged).toEqual([]);
      expect(d.jevError).toContain("Jev HTTP 422 (TypeSafe)");
      expect(d.jevError).toContain("unknown model");
    } finally {
      globalThis.fetch = realFetch;
      process.env.TYPESAFE_API_KEY = "";
    }
  });

  test("when Jev can't answer, nothing is flagged and the error says why: md-scrub stands down", async () => {
    const d = await detect("We use zod (MIT).", FIX);
    expect(d.flagged).toEqual([]);
    expect(d.jevError).toBe("no Jev key set (OpenRouter or TypeSafe)");
    expect(d.mostly).toBeUndefined();
  });
});

describe("clean-up safety", () => {
  test("edits may only delete, comparing emoji and other astral characters whole", () => {
    expect(isDeletion({ find: "Use 😀 now. Their terms forbid X.", replace: "Use 😀 now." })).toBe(true);
    expect(isDeletion({ find: "Use 😀 now.", replace: "Use 😃 now." })).toBe(false);
    expect(isDeletion({ find: "terms forbid X", replace: "terms allow X" })).toBe(false);
  });

  test("a clean-up that runs out of time fails instead of running past the hook's timeout", async () => {
    const doc = "# Notes\n\nWe use zod (MIT) for validation.\n";
    budget.until = Date.now() + 500;
    try {
      const flagged = [{ index: 0, body: doc, from: 1, to: 3, after: "", topics: ["fixture-licensing"], keywordHits: [] }];
      expect(await clean(doc, flagged, undefined, FIX)).toEqual({ ok: false, error: "out of time before the clean-up could run" });
    } finally {
      budget.until = Number.POSITIVE_INFINITY;
    }
  });
});
