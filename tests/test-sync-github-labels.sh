#!/usr/bin/env bash
# tests/test-sync-github-labels.sh
#
# Exercises the offline paths of scripts/sync-github-labels.sh and validates
# the canonical label manifest at templates/github-labels.json.
#
# We can't test the real `gh label create` call without network + auth, so the
# test covers: manifest well-formedness, "no remote" no-op, "missing manifest"
# error path, and "gh missing" graceful-skip path.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/sync-github-labels.sh"
MANIFEST="$PLUGIN_ROOT/templates/github-labels.json"

# 1. Manifest exists and is valid JSON.
[[ -f "$MANIFEST" ]] \
  || { echo "FAIL: manifest missing at $MANIFEST"; exit 1; }
jq empty "$MANIFEST" 2>/dev/null \
  || { echo "FAIL: manifest is not valid JSON"; exit 1; }

# 2. Manifest has at least the labels referenced by skills/agents.
required=(Feature Bug Improvement Ops Docs Backend Database iOS Web Blocked)
for lbl in "${required[@]}"; do
  jq -e --arg n "$lbl" '.labels | map(.name) | index($n)' "$MANIFEST" >/dev/null \
    || { echo "FAIL: manifest missing required label '$lbl'"; exit 1; }
done

# 3. Every entry has name, color, description (non-empty).
bad=$(jq -r '.labels[] | select(
  (.name // "") == "" or (.color // "") == "" or (.description // "") == ""
) | .name // "<unnamed>"' "$MANIFEST")
[[ -z "$bad" ]] \
  || { echo "FAIL: incomplete manifest entries: $bad"; exit 1; }

# 4. Color values are 6-char hex (no leading #).
bad=$(jq -r '.labels[] | select(.color | test("^[0-9a-fA-F]{6}$") | not) | .name' "$MANIFEST")
[[ -z "$bad" ]] \
  || { echo "FAIL: non-hex colors on: $bad"; exit 1; }

# 5. Script exits 0 with no-remote message when origin is absent.
tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT
cd "$tmpdir"
git init -q -b main
# No remote configured.
out=$(bash "$SCRIPT" 2>&1) \
  || { echo "FAIL: script should exit 0 when no origin remote"; exit 1; }
echo "$out" | grep -q "No origin remote" \
  || { echo "FAIL: expected 'No origin remote' in output, got: $out"; exit 1; }

# 6. --quiet suppresses the no-remote message.
out=$(bash "$SCRIPT" --quiet 2>&1) \
  || { echo "FAIL: --quiet exit non-zero"; exit 1; }
[[ -z "$out" ]] \
  || { echo "FAIL: --quiet should produce no output, got: $out"; exit 1; }

# 7. Missing manifest is a hard error.
fake_root=$(mktemp -d)
mkdir -p "$fake_root/scripts"
cp "$SCRIPT" "$fake_root/scripts/"
set +e
out=$(CLAUDE_PLUGIN_ROOT="$fake_root" bash "$fake_root/scripts/sync-github-labels.sh" 2>&1)
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] \
  || { echo "FAIL: missing manifest should exit non-zero"; exit 1; }
echo "$out" | grep -q "manifest not found" \
  || { echo "FAIL: missing-manifest error should mention 'manifest not found' (got: $out)"; exit 1; }
rm -rf "$fake_root"

# 8. gh missing → graceful skip with warning.
git remote add origin "file://$tmpdir/.git"
fake_path=$(mktemp -d)
# fake_path contains no `gh` binary, so command -v gh will fail
set +e
out=$(PATH="$fake_path:/usr/bin:/bin" bash "$SCRIPT" 2>&1)
exit_code=$?
set -e
[[ $exit_code -eq 0 ]] \
  || { echo "FAIL: missing gh should exit 0 (graceful skip)"; exit 1; }
echo "$out" | grep -q "gh CLI not installed" \
  || { echo "FAIL: missing-gh path should warn about gh CLI (got: $out)"; exit 1; }
rm -rf "$fake_path"

echo "PASS: test-sync-github-labels.sh"
