#!/usr/bin/env bash
# scaffold-agents.sh — drop the reusable AGENTS.md template + a CLAUDE.md (@AGENTS.md)
# into the current repo so you never start an AGENTS.md from scratch.
#
# Usage:  bash <rkt-plugin-root>/skills/scaffold/scaffold-agents.sh [target-dir]
# Safe by default: never overwrites an existing AGENTS.md or CLAUDE.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TEMPLATE="${SCRIPT_DIR}/AGENTS.template.md"
DEST="${1:-$PWD}"

[ -f "$TEMPLATE" ] || { echo "✗ template not found: $TEMPLATE" >&2; exit 1; }
[ -d "$DEST" ] || { echo "✗ target dir not found: $DEST" >&2; exit 1; }

agents="$DEST/AGENTS.md"
claude="$DEST/CLAUDE.md"

if [ -e "$agents" ]; then
  echo "• AGENTS.md already exists — leaving it untouched."
else
  cp "$TEMPLATE" "$agents"
  echo "✓ wrote AGENTS.md (fill the {{PLACEHOLDER}} tokens, delete the 'How to use' block + 'Section frequency' table)"
fi

if [ -e "$claude" ]; then
  echo "• CLAUDE.md already exists — leaving it untouched."
else
  printf '@AGENTS.md\n' > "$claude"
  echo "✓ wrote CLAUDE.md (just imports AGENTS.md so both Claude Code and Codex read one source of truth)"
fi

echo
echo "Next: open AGENTS.md and fill it in — or run /scaffold in Claude Code to have it"
echo "auto-fill the placeholders from this repo's package.json / pyproject / go.mod / etc."
