#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/detect-stack.sh"
FIXTURES="$HERE/fixtures"

assert_suggests() {
  local fixture="$1"
  local expected="$2"
  local actual
  actual=$(bash "$SCRIPT" "$FIXTURES/$fixture" | jq -r '.suggested_preset')
  [[ "$actual" == "$expected" ]] || { echo "FAIL: $fixture suggested '$actual', expected '$expected'"; exit 1; }
}

assert_suggests "empty-dir" "null"
assert_suggests "nextjs-existing" "web"
assert_suggests "fastapi-existing" "backend"
assert_suggests "full-existing" "full"

# Test specific flags in the JSON output
output=$(bash "$SCRIPT" "$FIXTURES/nextjs-existing")
echo "$output" | jq -e '.signals.has_nextjs == true' >/dev/null || { echo "FAIL: has_nextjs flag missing"; exit 1; }

output=$(bash "$SCRIPT" "$FIXTURES/full-existing")
echo "$output" | jq -e '.signals.has_xcodeproj == true' >/dev/null || { echo "FAIL: has_xcodeproj flag missing"; exit 1; }
echo "$output" | jq -e '.signals.has_supabase == true' >/dev/null || { echo "FAIL: has_supabase flag missing"; exit 1; }

echo "PASS: test-detect-stack.sh"
