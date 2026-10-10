// Ignore files list paths md-scrub leaves alone, one pattern per line, matched without regard to case:
//   README.md        a name without a slash matches that file name in any folder
//   docs/            a trailing slash matches everything under that folder
//   notes/*.md       anything else is a glob
// Like settings and topics, a project's ignore file comes from the nearest .md-scrub/ at or above a
// path, and its globs are relative to the folder holding it. The built-in defaults/ignore and your
// ~/.config/md-scrub/ignore apply everywhere, so their globs match in any folder.
// Blank lines and lines starting with # are skipped.
import { readFileSync } from "node:fs";
import { join, relative, isAbsolute, resolve, dirname } from "node:path";
import { DEFAULTS_DIR, USER_DIR, nearestProjectFolder } from "./scrub.ts";

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
export function isIgnored(path: string, base: string | undefined): boolean {
  if (!path) return false;
  const abs = isAbsolute(path) ? path : resolve(base ?? process.cwd(), path);
  for (const dir of [DEFAULTS_DIR, USER_DIR()]) {
    if (patterns(join(dir, "ignore"), true).some((g) => g.match(abs.toLowerCase()))) return true;
  }
  const project = nearestProjectFolder(abs);
  if (!project) return false;
  const rel = relative(dirname(project), abs).toLowerCase();
  return patterns(join(project, "ignore"), false).some((g) => g.match(rel));
}
