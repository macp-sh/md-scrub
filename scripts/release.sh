#!/usr/bin/env bash
# shellcheck disable=SC2016 # the bun -e scripts are JavaScript; their ${} is meant for JS
# Releases md-scrub: runs the tests, commits all changes with the version bump, merges to main, tags,
# publishes a GitHub Release, points the claude-plugins marketplace at the new tag and updates the local install.
#
# Usage: scripts/release.sh "<summary>" ["<release notes>"] [patch|minor|major|X.Y.Z]   (default: patch)
# The summary is the commit message after `vX.Y.Z: ` and must fit in 72 characters with it; the
# release notes default to the summary. The marketplace checkout defaults to ../claude-plugins; set
# MARKETPLACE_DIR to use another.
set -euo pipefail

usage='usage: scripts/release.sh "<summary>" ["<release notes>"] [patch|minor|major|X.Y.Z]'
summary=${1:?$usage}
notes=${2:-$summary}
bump=${3:-patch}
root=$(cd "$(dirname "$0")/.." && pwd)
market=${MARKETPLACE_DIR:-$root/../claude-plugins}
cd "$root"

[[ -f "$market/.claude-plugin/marketplace.json" ]] || { echo "no marketplace at $market" >&2; exit 1; }
[[ -z $(git -C "$market" status --porcelain) ]] || { echo "$market has uncommitted changes" >&2; exit 1; }

current=$(bun -e 'console.log(require("./.claude-plugin/plugin.json").version)')
version=$(bun -e '
  const [cur, bump] = process.argv.slice(1)
  if (/^\d+\.\d+\.\d+$/.test(bump)) { console.log(bump); process.exit(0) }
  let [ma, mi, pa] = cur.split(".").map(Number)
  if (bump === "major") { ma++; mi = 0; pa = 0 } else if (bump === "minor") { mi++; pa = 0 } else if (bump === "patch") pa++
  else { console.error(`unknown bump: ${bump}`); process.exit(1) }
  console.log(`${ma}.${mi}.${pa}`)
' "$current" "$bump")
tag="v$version"
subject="$tag: $summary"
(( ${#subject} <= 72 )) || { echo "commit message is ${#subject} characters, over 72: $subject" >&2; echo "shorten the summary; put the detail in the release notes" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "$tag already exists" >&2; exit 1; }
echo "md-scrub $current -> $version"

bun test
claude plugin test .
claude plugin validate --strict .

bun -e '
  const f = "./.claude-plugin/plugin.json", j = await Bun.file(f).json()
  j.version = process.argv[1]
  await Bun.write(f, JSON.stringify(j, null, 2) + "\n")
' "$version"
branch=$(git branch --show-current)
git add -A
git commit -q -m "$tag: $summary"

if [[ $branch != main ]]; then
  git push -q origin "$branch"
  git checkout -q main
  git pull -q --ff-only origin main
  git merge -q --no-edit "$branch"
fi
git push -q origin main

git tag -a "$tag" -m "md-scrub $tag"
git push -q origin "$tag"
gh release create "$tag" --title "md-scrub $tag" --notes "$notes"

git -C "$market" pull -q --ff-only
bun -e '
  const f = process.argv[1] + "/.claude-plugin/marketplace.json", j = await Bun.file(f).json()
  const p = j.plugins.find(p => p.name === "md-scrub")
  if (!p) { console.error("md-scrub is not in the marketplace"); process.exit(1) }
  p.source.ref = process.argv[2]
  await Bun.write(f, JSON.stringify(j, null, 2) + "\n")
' "$market" "$tag"
git -C "$market" commit -q -am "md-scrub $tag"
git -C "$market" push -q

claude plugin marketplace update macp-sh
claude plugin update md-scrub@macp-sh
echo "Released md-scrub $tag. Restart Claude Code or run /reload-plugins to load it."
