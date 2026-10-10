// Topics, settings and ignore files: what md-scrub keeps out, and where.
import { test, expect, describe } from "bun:test";
import { mkdirSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { loadScrubConfig, jevQuestions, rule, ScrubConfigError, MAX_QUESTION_CHARS } from "../src/scrub.ts";
import { keywordHits } from "../src/detect.ts";
import { project, fixtureProject, run, pre, write, untouched, decision, DOC, tmp } from "./helpers.ts";

const secrets = {
  name: "credentials",
  description: "API keys, passwords and tokens.",
  examples: { is: ["OPENAI_KEY=sk-123"], isNot: ["Set your key in .env"] },
  keywords: [{ label: "API key", pattern: "\\bsk-[A-Za-z0-9]{3,}" }],
};

describe("the shipped topic", () => {
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
  test("a project's topic is added, named by its file, for that project only", () => {
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

  test("a topic in ~/.config/md-scrub/topics applies in every project", () => {
    const home = tmp("home");
    mkdirSync(join(home, ".config", "md-scrub", "topics"), { recursive: true });
    writeFileSync(join(home, ".config", "md-scrub", "topics", "secrets.json"), JSON.stringify(secrets));
    const r = run("pre", write(join(tmp("anywhere"), "notes.md"), "OPENAI_KEY=sk-abc123"), { HOME: home }).json;
    expect(decision(r)).toBe("deny");
  });

  test("all topics go in one Jev request, so topics too large together are rejected", () => {
    const big = (n: number) => ({ ...secrets, examples: { is: ["x".repeat(MAX_QUESTION_CHARS / 2 - 2000) + n], isNot: ["y"] } });
    expect(Object.keys(jevQuestions(loadScrubConfig(project({ topics: { big1: big(1), small: secrets } }).file)))).toHaveLength(6);
    expect(() => loadScrubConfig(project({ topics: { big1: big(1), big2: big(2) } }).file)).toThrow("keep them under");
  });
});

describe("settings in .md-scrub/config.json", () => {
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
    writeFileSync(join(off, ".md-scrub", "config.json"), JSON.stringify({ enabled: false }));
    expect(run("pre", write(join(off, "a.md"), "licensed under MIT")).out).toBe("");
    expect(pre(write(join(fixtureProject(), "a.md"), DOC("licensed under MIT"))).hookSpecificOutput.updatedInput).toBeDefined();
  });
});

describe("validation", () => {
  test("rejects broken settings and topic files, naming the problem", () => {
    const cases: [Parameters<typeof project>[0], string][] = [
      [{ topics: { secrets: { ...secrets, keywords: [{ label: "bad", pattern: "(" }] } } }, 'keyword "bad" has an invalid pattern'],
      [{ topics: { secrets: { ...secrets, keywords: [{ label: "sticky", pattern: "a", flags: "gi" }] } } }, "can't use the g or y flags"],
      [{ topics: { secrets: { ...secrets, description: "" } } }, '"description" is required'],
      [{ topics: { secrets: { ...secrets, examples: { is: ["x"], isNot: [] } } } }, '"examples.isNot"'],
      [{ topics: { Secrets: secrets } }, "kebab-case"],
      [{ topics: { secrets: { ...secrets, id: "creds" } } }, '"id" is the file name'],
      [{ topics: { secrets: { ...secrets, examples: { is: ["x".repeat(50_000)], isNot: ["y"] } } } }, "keep them under"],
      [{ config: { thresholds: { flag: 2 } } }, '"thresholds.flag"'],
      [{ config: { enabled: "no" } }, '"enabled" must be true or false'],
      [{ config: { topics: { nope: { enabled: false } } } }, "no topics/nope.json defines it"],
      [{ raw: { "config.json": "{ not json" } }, "config.json: not valid JSON"],
    ];
    for (const [opts, message] of cases) {
      const p = project(opts);
      let error: unknown;
      try { loadScrubConfig(p.file); } catch (e) { error = e; }
      expect(error, message).toBeInstanceOf(ScrubConfigError);
      expect((error as Error).message, message).toContain(message);
    }
  });

  test("a broken file switches the hooks off visibly instead of failing silently", () => {
    const p = project({ topics: { secrets: { ...secrets, keywords: [{ label: "bad", pattern: "(" }] } } });
    const r = pre({ ...write(p.file, "licensed under MIT"), cwd: p.dir });
    expect(r.systemMessage).toContain("scrub config error");
    expect(r.hookSpecificOutput).toBeUndefined();
  });
});

describe("ignore files", () => {
  const p = fixtureProject();
  writeFileSync(join(p, ".md-scrub", "ignore"), "# saved docs stay verbatim\nreadme.md\nclaude/docs/\nnotes/*.md\n");
  const at = (rel: string, content = DOC("zod (MIT)")) => pre({ ...write(join(p, rel), content), cwd: p });

  test("a project's names match in any folder, without regard to case", () => {
    expect(untouched(at("README.md"))).toBe(true);
    expect(untouched(at("pkg/Readme.md"))).toBe(true);
  });

  test("a project's folders and globs are relative to the folder holding .md-scrub/", () => {
    expect(untouched(at("claude/docs/ref.md"))).toBe(true);
    expect(untouched(at("notes/a.md"))).toBe(true);
    expect(at("sub/notes/a.md").hookSpecificOutput.updatedInput).toBeDefined();
    expect(at("docs/a.md").hookSpecificOutput.updatedInput).toBeDefined();
  });

  test("are found from the target, whatever the session's folder, for Bash targets too", () => {
    expect(untouched(pre({ ...write(join(p, "README.md"), "© 2026 Acme"), cwd: tmp("elsewhere") }))).toBe(true);
    expect(untouched(pre({ ...{ tool_name: "Bash", tool_input: { command: "echo '© 2026' > README.md" } }, cwd: p }))).toBe(true);
  });

  test("only the nearest .md-scrub/ applies, as for settings and topics", () => {
    const outer = fixtureProject();
    writeFileSync(join(outer, ".md-scrub", "ignore"), "readme.md\n");
    cpSync(join(outer, ".md-scrub", "topics"), join(outer, "pkg", ".md-scrub", "topics"), { recursive: true });
    cpSync(join(outer, ".md-scrub", "config.json"), join(outer, "pkg", ".md-scrub", "config.json"));
    const file = (rel: string) => pre({ ...write(join(outer, rel), DOC("zod (MIT)")), cwd: outer });
    expect(untouched(file("README.md"))).toBe(true);
    expect(file("pkg/README.md").hookSpecificOutput.updatedInput).toBeDefined();
  });

  test("the built-in list skips licence files by name in any folder and case", () => {
    expect(untouched(at("license.md"))).toBe(true);
    expect(untouched(at("docs/LICENCE.md"))).toBe(true);
    expect(untouched(at("NOTICE.md"))).toBe(true);
  });

  test("globs in ~/.config/md-scrub/ignore match in any folder", () => {
    const home = tmp("home");
    mkdirSync(join(home, ".config", "md-scrub"), { recursive: true });
    writeFileSync(join(home, ".config", "md-scrub", "ignore"), "docs/legal/\n");
    const userAt = (rel: string) => run("pre", { ...write(join(p, rel), DOC("zod (MIT)")), cwd: p }, { HOME: home }).json;
    expect(untouched(userAt("docs/legal/terms.md"))).toBe(true);
    expect(untouched(userAt("site/Docs/Legal/terms.md"))).toBe(true);
    expect(userAt("docs/a.md").hookSpecificOutput.updatedInput).toBeDefined();
  });
});
