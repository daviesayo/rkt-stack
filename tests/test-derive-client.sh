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

grep -q 'AskUserQuestion' "$SKILL/SKILL.md" || {
  echo "derive-client must use AskUserQuestion for prompts" >&2
  exit 1
}

grep -q 'RKT_PLUGIN_ROOT' "$SKILL/SKILL.md" || {
  echo "derive-client should document plugin-root resolution" >&2
  exit 1
}

grep -Eq 'serviceWorkers:\s*["'\'']block["'\'']' "$SCRIPTS/src/record.ts" || {
  echo "recordHar.serviceWorkers must be 'block' or Service Worker traffic is invisible" >&2
  exit 1
}

grep -Eq 'content:\s*["'\'']attach["'\'']' "$SCRIPTS/src/record.ts" || {
  echo "recordHar.content must be 'attach' or response bodies are missing" >&2
  exit 1
}

grep -Eq 'mode:\s*["'\'']full["'\'']' "$SCRIPTS/src/record.ts" || {
  echo "recordHar.mode must be 'full' or the auth pass loses cookies" >&2
  exit 1
}

# No secrets file may ever be tracked by git.
if git -C "$ROOT/../.." ls-files --error-unmatch '**/secrets/*.json' >/dev/null 2>&1; then
  echo "secrets files must never be committed" >&2
  exit 1
fi

# The leak test is the structural guarantee that manifests carry no secrets;
# its absence must fail the suite rather than silently reduce coverage.
if [[ ! -f "$SCRIPTS/tests/leak.test.ts" ]]; then
  echo "missing structural leak test at scripts/tests/leak.test.ts" >&2
  exit 1
fi

if [[ ! -f "$SCRIPTS/tests/nosecrets.test.ts" ]]; then
  echo "missing structural no-secrets test for generated clients" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "derive-client: bun not installed, skipping unit tests" >&2
  echo "OK (skipped unit tests)"
  exit 0
fi

if [[ -d "$SCRIPTS/node_modules" ]]; then
  ( cd "$SCRIPTS" && bunx tsc --noEmit )
else
  echo "derive-client: node_modules absent, skipping typecheck" >&2
  echo "derive-client: run 'cd $SCRIPTS && bun install' to enable it" >&2
fi

( cd "$SCRIPTS" && bun test )

echo "OK"
