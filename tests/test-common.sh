#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/lib/common.sh"

# Test: derive_prefix converts kebab-case to uppercase initials
result=$(derive_prefix "my-new-thing")
[[ "$result" == "MNT" ]] || { echo "FAIL: derive_prefix 'my-new-thing' = '$result', expected 'MNT'"; exit 1; }

result=$(derive_prefix "witness")
[[ "$result" == "WIT" ]] || { echo "FAIL: derive_prefix 'witness' = '$result', expected 'WIT'"; exit 1; }

# Test: slugify
result=$(slugify "My Cool Project!")
[[ "$result" == "my-cool-project" ]] || { echo "FAIL: slugify = '$result'"; exit 1; }

# Test: json_get reads rkt.json values
tmpfile=$(mktemp)
echo '{"project_name": "test", "linear": {"issue_prefix": "TST"}}' > "$tmpfile"
result=$(json_get "$tmpfile" ".linear.issue_prefix")
[[ "$result" == "TST" ]] || { echo "FAIL: json_get nested = '$result'"; exit 1; }
rm -f "$tmpfile"

# ── Tests for require_linear ─────────────────────────────────────────────────
tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT
saved_pwd=$(pwd)

cd "$tmpdir"

# Case 1: no rkt.json → fails
set +e
(require_linear) 2>/dev/null
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: require_linear should fail when rkt.json is missing"; exit 1; }

# Case 2: rkt.json exists but project_id is empty string → fails
echo '{"linear": {"project_id": ""}}' > rkt.json
set +e
(require_linear) 2>/dev/null
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: require_linear should fail on empty project_id"; exit 1; }

# Case 3: rkt.json has JSON null project_id → fails
echo '{"linear": {"project_id": null}}' > rkt.json
set +e
(require_linear) 2>/dev/null
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: require_linear should fail on null project_id"; exit 1; }

# Case 4: rkt.json missing the linear object entirely → fails
echo '{"project_name": "test"}' > rkt.json
set +e
(require_linear) 2>/dev/null
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: require_linear should fail when linear object is absent"; exit 1; }

# Case 5: rkt.json has a populated project_id → succeeds
echo '{"linear": {"project_id": "abc-123-uuid"}}' > rkt.json
require_linear 2>/dev/null \
  || { echo "FAIL: require_linear should succeed on populated project_id"; exit 1; }

# Case 6: error message must mention /rkt:bootstrap so the user has an action
echo '{"linear": {"project_id": ""}}' > rkt.json
set +e
err=$(require_linear 2>&1 1>/dev/null)
set -e
echo "$err" | grep -q "/rkt:bootstrap" \
  || { echo "FAIL: require_linear error message should reference /rkt:bootstrap (got: $err)"; exit 1; }

# Case 7: malformed rkt.json fails with a distinct error, not "Linear not configured"
printf 'not-valid-json{' > rkt.json
set +e
err=$(require_linear 2>&1 1>/dev/null)
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: require_linear should fail on malformed rkt.json"; exit 1; }
echo "$err" | grep -q "invalid JSON" \
  || { echo "FAIL: malformed rkt.json should produce 'invalid JSON' error, not (got: $err)"; exit 1; }
# AND must NOT report the Linear-not-configured message (that would be misleading)
echo "$err" | grep -q "Linear is not configured" \
  && { echo "FAIL: malformed rkt.json was reported as 'Linear not configured' (misleading)"; exit 1; } \
  || true

cd "$saved_pwd"
echo "PASS: test-common.sh"
