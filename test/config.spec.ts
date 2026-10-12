// Topics, settings and exclusions: what md-scrub keeps out, and where (built in, user, project).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { loadScrubConfig, jevQuestions, rule, ScrubConfigError, MAX_QUESTION_CHARS } from "../src/scrub.ts";
import { keywordHits } from "../src/detect.ts";
import { setProjectRoot } from "../src/config.ts";
import { project, fixtureProject, run, pre, write, untouched, DOC, tmp } from "./helpers.ts";

const secrets = {
  name: "credentials",
  description: "API keys, passwords and tokens.",
  examples: { is: ["OPENAI_KEY=sk-123"], isNot: ["Set your key in .env"] },
  keywords: [{ label: "API key", pattern: "\\bsk-[A-Za-z0-9]{3,}" }],
};

describe("the shipped topic", () => {
  // Outside any project, so only built-in (and user) settings apply.
  beforeEach(() => setProjectRoot(undefined));

  test("is third-party-terms from defaults/", () => {
    const c = loadScrubConfig();
    expect(c.topics.map((t) => t.id)).toEqual(["third-party-terms"]);
    expect(c.topics[0]!.source).toEndWith(join("defaults", "topics", "third-party-terms.json"));
    expect(c.thresholds).toEqual({ flag: 0.4, mostly: 0.5 });
  });

  test("has keywords for stated obligations, not licence names", () => {
    const c = loadScrubConfig();
    expect(keywordHits("OpenRouter's terms prohibit reselling API access.", 1, c)).toHaveLength(1);
    for (const allowed of ["This project is licensed under MIT.", "zod (MIT), sharp (Apache 2.0)", "See our Terms of Service in the footer."]) {
      expect(keywordHits(allowed, 1, c), allowed).toEqual([]);
    }
  });

  test("asks Jev two questions", () => {
    expect(Object.keys(jevQuestions(loadScrubConfig()))).toEqual(["third-party-terms", "third-party-terms__mostly"]);
  });
});

describe("topic files", () => {
  test("a project's topic is added, named by its file, for files in that project only", () => {
    const p = project({ topics: { secrets } });
    const c = loadScrubConfig(p.file);
    expect(c.topics.map((t) => t.id)).toEqual(["third-party-terms", "secrets"]);
    expect(keywordHits("OPENAI_KEY=sk-abc123", 1, c)[0]?.label).toBe("API key");
    expect(rule(c)).toContain("credentials");
    expect(loadScrubConfig("/elsewhere/a.md").topics.map((t) => t.id)).toEqual(["third-party-terms"]);
  });

  test("a file named like an existing topic adjusts it: set fields replace, add appends, the rest is inherited", () => {
    const base = loadScrubConfig().topics[0]!;
    const renamed = loadScrubConfig(project({ topics: { "third-party-terms": { name: "vendor terms" } } }).file).topics[0]!;
    expect(renamed.name).toBe("vendor terms");
    expect(renamed.examples.is).toEqual(base.examples.is);
    expect(renamed.regexes.length).toBe(base.regexes.length);

    const appended = loadScrubConfig(project({ topics: { "third-party-terms": { add: { examples: { isNot: ["Our SLA is 99.9%."] }, keywords: [{ label: "x", pattern: "xyz" }] } } } }).file).topics[0]!;
    expect(appended.examples.isNot).toEqual([...base.examples.isNot, "Our SLA is 99.9%."]);
    expect(appended.examples.is.length).toBe(base.examples.is.length);
    expect(appended.regexes.length).toBe(base.regexes.length + 1);

    const replaced = loadScrubConfig(project({ topics: { "third-party-terms": { examples: { isNot: ["only this"] } } } }).file).topics[0]!;
    expect(replaced.examples.isNot).toEqual(["only this"]);
    expect(replaced.examples.is.length).toBe(base.examples.is.length);
  });

  test("a topic in ~/.claude/md-scrub/topics applies in every project", () => {
    const home = tmp("home");
    mkdirSync(join(home, ".claude", "md-scrub", "topics"), { recursive: true });
    writeFileSync(join(home, ".claude", "md-scrub", "topics", "secrets.json"), JSON.stringify(secrets));
    const dir = tmp("anywhere");
    const r = run("pre", { ...write(join(dir, "notes.md"), "# Notes\n\nSECRETS for the demo.\n"), cwd: dir }, { HOME: home }).json;
    expect(r.hookSpecificOutput.additionalContext).toContain("credentials");
  });

  test("all topics go in one Jev request, so topics too large together are rejected", () => {
    const big = (n: number) => ({ ...secrets, examples: { is: ["x".repeat(MAX_QUESTION_CHARS / 2 - 2000) + n], isNot: ["y"] } });
    expect(Object.keys(jevQuestions(loadScrubConfig(project({ topics: { big1: big(1), small: secrets } }).file)))).toHaveLength(6);
    expect(() => loadScrubConfig(project({ topics: { big1: big(1), big2: big(2) } }).file)).toThrow("keep them under");
  });
});

describe("settings in .claude/md-scrub/config.json", () => {
  test("switch a topic off, or md-scrub as a whole", () => {
    expect(loadScrubConfig(project({ config: { topics: { "third-party-terms": { enabled: false } } } }).file).topics).toEqual([]);
    const off = loadScrubConfig(project({ config: { enabled: false }, topics: { secrets } }).file);
    expect(off.enabled).toBe(false);
    expect(off.topics).toEqual([]);
  });

  test("set thresholds", () => {
    expect(loadScrubConfig(project({ config: { thresholds: { mostly: 0.8 } } }).file).thresholds).toEqual({ flag: 0.4, mostly: 0.8 });
  });

  test('"enabled": false stops the hooks for that project, and only that project', () => {
    const off = fixtureProject();
    writeFileSync(join(off, ".claude", "md-scrub", "config.json"), JSON.stringify({ enabled: false }));
    expect(run("pre", { ...write(join(off, "a.md"), "licensed under MIT"), cwd: off }).out).toBe("");
    const on = fixtureProject();
    expect(pre({ ...write(join(on, "a.md"), DOC("licensed under MIT")), cwd: on }).hookSpecificOutput.updatedInput).toBeDefined();
  });
});

describe("validation", () => {
  const load = (opts: Parameters<typeof project>[0]) => loadScrubConfig(project(opts).file);

  describe("a topic's own Jev settings", () => {
    // The model ID is checked against the provider in use, here OpenRouter.
    beforeEach(() => { process.env.OPENROUTER_API_KEY = "or"; process.env.TYPESAFE_API_KEY = ""; });
    afterEach(() => { process.env.OPENROUTER_API_KEY = ""; process.env.TYPESAFE_API_KEY = ""; });
    const withJev = (jev: unknown) => load({ topics: { secrets: { ...secrets, jev } } });

    test("are accepted in either form, and its thresholds apply to it alone", () => {
      const c = withJev({ model: "typesafe/jev-1.14", flag: 0.3 });
      expect(c.errors).toEqual([]);
      expect(c.topics.find((t) => t.id === "secrets")!.jev).toEqual({ model: "typesafe/jev-1.14", flag: 0.3 });
      expect(withJev({ model: { typesafe: "jev-1.14.0", openrouter: "typesafe/jev-1.14" } }).errors).toEqual([]);
      expect(c.thresholds).toEqual({ flag: 0.4, mostly: 0.5 });
    });

    test("that don't fit turn off only that topic, saying why", () => {
      const cases: [unknown, string][] = [
        [{ model: "jev-1.14.0" }, '"jev.model" jev-1.14.0 is a TypeSafe ID, but md-scrub is using OpenRouter'],
        [{ model: "gpt-5" }, "neither a TypeSafe ID (jev-…) nor an OpenRouter ID (typesafe/…)"],
        [{ model: { typesafe: "jev-1.14.0" } }, '"jev.model" gives no OpenRouter ID, and md-scrub is using OpenRouter'],
        [{ model: { openrouter: "jev-1.14.0" } }, '"jev.model.openrouter" must be an OpenRouter ID'],
        [{ flag: 2 }, '"jev.flag" must be a number from 0 to 1'],
        ["fast", '"jev" must be an object'],
      ];
      for (const [jev, message] of cases) {
        const c = withJev(jev);
        expect(c.topics.map((t) => t.id), message).toEqual(["third-party-terms"]);
        expect(c.errors.join("\n"), message).toContain(message);
      }
    });

    test("with TypeSafe in use, a TypeSafe ID fits and an OpenRouter one doesn't", () => {
      process.env.TYPESAFE_API_KEY = "ts";
      expect(withJev({ model: "jev-1.14.0" }).errors).toEqual([]);
      expect(withJev({ model: "typesafe/jev-1.14" }).errors.join("\n")).toContain("is an OpenRouter ID, but md-scrub is using TypeSafe");
    });
  });

  test("a broken topic file turns off only that topic, naming the problem", () => {
    const cases: [Parameters<typeof project>[0], string][] = [
      [{ topics: { secrets: { ...secrets, keywords: [{ label: "bad", pattern: "(" }] } } }, 'keyword "bad" has an invalid pattern'],
      [{ topics: { secrets: { ...secrets, keywords: [{ label: "sticky", pattern: "a", flags: "gi" }] } } }, "can't use the g or y flags"],
      [{ topics: { secrets: { ...secrets, description: "" } } }, '"description" is required'],
      [{ topics: { secrets: { ...secrets, examples: { is: ["x"], isNot: [] } } } }, '"examples.isNot"'],
      [{ topics: { Secrets: secrets } }, "kebab-case"],
      [{ topics: { secrets: { ...secrets, id: "creds" } } }, '"id" is the file name'],
      [{ raw: { "topics/secrets.json": "{ not json" } }, "secrets.json: not valid JSON"],
      [{ config: { topics: { nope: { enabled: false } } } }, "no topics/nope.json defines it"],
    ];
    for (const [opts, message] of cases) {
      const c = load(opts);
      expect(c.topics.map((t) => t.id), message).toEqual(["third-party-terms"]);
      expect(c.errors.join("\n"), message).toContain(message);
    }
  });

  test("a broken settings file, or topics too large together, turn md-scrub off", () => {
    const cases: [Parameters<typeof project>[0], string][] = [
      [{ topics: { secrets: { ...secrets, examples: { is: ["x".repeat(50_000)], isNot: ["y"] } } } }, "keep them under"],
      [{ config: { thresholds: { flag: 2 } } }, '"thresholds.flag"'],
      [{ config: { enabled: "no" } }, '"enabled" must be true or false'],
      [{ raw: { "config.json": "{ not json" } }, "config.json: not valid JSON"],
    ];
    for (const [opts, message] of cases) {
      let error: unknown;
      try { load(opts); } catch (e) { error = e; }
      expect(error, message).toBeInstanceOf(ScrubConfigError);
      expect((error as Error).message, message).toContain(message);
    }
    const p = project({ raw: { "config.json": "{ not json" } });
    const r = pre({ ...write(p.file, "licensed under MIT"), cwd: p.dir });
    expect(r.systemMessage).toContain("settings error");
    expect(r.hookSpecificOutput).toBeUndefined();
  });
});

describe("exclusions", () => {
  const p = fixtureProject();
  writeFileSync(join(p, ".claude", "md-scrub", "exclusions"), "# saved docs stay verbatim\nreadme.md\nclaude/docs/\nnotes/*.md\n");
  const at = (rel: string, content = DOC("zod (MIT)")) => pre({ ...write(join(p, rel), content), cwd: p });

  test("a project's names match in any folder, without regard to case", () => {
    expect(untouched(at("README.md"))).toBe(true);
    expect(untouched(at("pkg/Readme.md"))).toBe(true);
  });

  test("a project's folders and globs are relative to the project root", () => {
    expect(untouched(at("claude/docs/ref.md"))).toBe(true);
    expect(untouched(at("notes/a.md"))).toBe(true);
    expect(at("sub/notes/a.md").hookSpecificOutput.updatedInput).toBeDefined();
    expect(at("docs/a.md").hookSpecificOutput.updatedInput).toBeDefined();
  });

  test("a project's exclusions and settings don't reach files outside it", () => {
    // README.md is excluded in the project, and the fixture topic replaces the shipped one there; a
    // file outside the project gets neither, so the shipped topic scrubs it.
    const out = pre({ ...write(join(tmp("outside"), "README.md"), DOC("zod (MIT)")), cwd: p }).hookSpecificOutput;
    expect(out.updatedInput).toBeDefined();
    expect(out.additionalContext).toContain("third-party legal terms");
    expect(out.additionalContext).not.toContain("Test fixture rule");
  });

  test("the built-in list skips licence files by name in any folder and case", () => {
    expect(untouched(at("license.md"))).toBe(true);
    expect(untouched(at("docs/LICENCE.md"))).toBe(true);
    expect(untouched(at("NOTICE.md"))).toBe(true);
  });

  test("globs in ~/.claude/md-scrub/exclusions match in any folder", () => {
    const home = tmp("home");
    mkdirSync(join(home, ".claude", "md-scrub"), { recursive: true });
    writeFileSync(join(home, ".claude", "md-scrub", "exclusions"), "docs/legal/\n");
    const userAt = (rel: string) => run("pre", { ...write(join(p, rel), DOC("zod (MIT)")), cwd: p }, { HOME: home }).json;
    expect(untouched(userAt("docs/legal/terms.md"))).toBe(true);
    expect(untouched(userAt("site/Docs/Legal/terms.md"))).toBe(true);
    expect(userAt("docs/a.md").hookSpecificOutput.updatedInput).toBeDefined();
  });
});
