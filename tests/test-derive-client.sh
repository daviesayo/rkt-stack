#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugins/rkt" && pwd)"
SKILL="$ROOT/skills/derive-client"
SCRIPTS="$SKILL/scripts"

for path in \
  "$SKILL/SKILL.md" \
  "$SCRIPTS/package.json" \
  "$SCRIPTS/src/record.ts" \
  "$SCRIPTS/src/derive.ts"; do
  if [[ ! -f "$path" ]]; then
    echo "Missing derive-client artifact: ${path#$ROOT/}" >&2
    exit 1
  fi
done

HOME_PATH_PATTERN="/Users""/rocket"
if grep -R "$HOME_PATH_PATTERN" "$SKILL" >/dev/null 2>&1; then
  echo "derive-client must not hardcode machine-local home paths" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "derive-client: bun not installed, skipping unit tests" >&2
  echo "OK (skipped unit tests)"
  exit 0
fi

( cd "$SCRIPTS" && bun test )

echo "OK"
