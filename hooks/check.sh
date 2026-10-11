#!/bin/sh
# md-scrub's SessionStart check. Plain sh, so it can still say something when Bun is missing;
# with Bun present it hands over to `cli.ts session-start` for the remaining checks.
cat >/dev/null
if ! command -v bun >/dev/null 2>&1; then
  # Also leave the problem for the status mod, which keeps it on screen (see src/progress.ts).
  state="$HOME/.claude/md-scrub/state"
  cwd=$(printf '%s' "$PWD" | sed 's/[\\"]/\\&/g')
  mkdir -p "$state" && printf '{"cwd":"%s","line":"not running: Bun isn'"'"'t on the PATH"}\n' "$cwd" > "$state/setup.json"
  printf '%s\n' '{"systemMessage":"md-scrub: Bun is not on the PATH Claude Code starts with, so Markdown writes are not being checked. Install it from https://bun.sh, or add its folder to that PATH."}'
  exit 0
fi
exec bun --no-env-file "$(dirname "$0")/../src/cli.ts" session-start </dev/null
