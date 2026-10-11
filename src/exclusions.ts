// Exclusions: paths md-scrub leaves alone, one pattern per line in an `exclusions` file, matched
// without regard to case:
//   README.md        a name without a slash matches that file name in any folder
//   docs/            a trailing slash matches everything under that folder
//   notes/*.md       anything else is a glob
// The project's file (<project root>/.claude/md-scrub/exclusions) is relative to the project root.
// The built-in defaults/exclusions and your ~/.claude/md-scrub/exclusions apply everywhere, so their
// globs match in any folder. Blank lines and lines starting with # are skipped.
import { readFileSync } from "node:fs";
import { join, relative, isAbsolute, resolve, dirname } from "node:path";
import { USER_DIR } from "./config.ts";
import { DEFAULTS_DIR, projectFolder } from "./scrub.ts";

const cache = new Map<string, Bun.Glob[]>();

function patterns(file: string, anywhere: boolean): Bun.Glob[] {
  const cached = cache.get(file);
  if (cached) return cached;
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {}
  const globs = lines
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"))
    .map((p) => p.replace(/^\.?\//, ""))
    .map((p) => (p.endsWith("/") ? `${p}**` : p))
    .map((p) => (anywhere || !p.includes("/") ? `**/${p}` : p))
    .map((p) => new Bun.Glob(p));
  cache.set(file, globs);
  return globs;
}

// `base` resolves a relative path (a shell command's target), usually the session's working folder.
export function isExcluded(path: string, base: string | undefined): boolean {
  if (!path) return false;
  const abs = isAbsolute(path) ? path : resolve(base ?? process.cwd(), path);
  for (const dir of [DEFAULTS_DIR, USER_DIR]) {
    if (patterns(join(dir, "exclusions"), true).some((g) => g.match(abs.toLowerCase()))) return true;
  }
  const folder = projectFolder(abs);
  if (!folder) return false;
  const rel = relative(dirname(dirname(folder)), abs).toLowerCase();
  return patterns(join(folder, "exclusions"), false).some((g) => g.match(rel));
}
