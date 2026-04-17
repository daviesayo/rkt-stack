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

echo "PASS: test-common.sh"
