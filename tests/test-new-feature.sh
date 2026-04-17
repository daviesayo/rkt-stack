#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/new-feature.sh"

# Setup: create a throwaway git repo
tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT
cd "$tmpdir"
git init -q -b main
git commit -q --allow-empty -m "initial"
git remote add origin "file://$tmpdir/.git"

# Test: invoking with no args prints usage
set +e
output=$(bash "$SCRIPT" 2>&1)
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: should exit non-zero with no args"; exit 1; }
echo "$output" | grep -q "Usage:" || { echo "FAIL: usage not printed"; exit 1; }

# Test: creates expected worktree
bash "$SCRIPT" RKT-999 test-feature backend >/dev/null 2>&1
[[ -d "$tmpdir/.worktrees/RKT-999-backend" ]] || { echo "FAIL: worktree dir not created"; exit 1; }

echo "PASS: test-new-feature.sh"
