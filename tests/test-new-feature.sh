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

# Test: docs is accepted as a domain (orchestrator-owned, see Issue 2 in 0.3.0)
bash "$SCRIPT" RKT-998 backfill-decisions docs >/dev/null 2>&1
[[ -d "$tmpdir/.worktrees/RKT-998-docs" ]] || { echo "FAIL: docs worktree not created"; exit 1; }

# Test: docs branch follows the [ISSUE-ID]/docs/[description] convention
cd "$tmpdir/.worktrees/RKT-998-docs"
actual_branch=$(git rev-parse --abbrev-ref HEAD)
[[ "$actual_branch" == "RKT-998/docs/backfill-decisions" ]] \
  || { echo "FAIL: docs branch is '$actual_branch', expected 'RKT-998/docs/backfill-decisions'"; exit 1; }
cd "$tmpdir"

# Test: invalid domain still rejected
set +e
out=$(bash "$SCRIPT" RKT-997 invalid-domain bogus 2>&1)
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: bogus domain should be rejected"; exit 1; }
echo "$out" | grep -q "unknown domain" || { echo "FAIL: bogus-domain error should mention 'unknown domain'"; exit 1; }

# Test: default invocation (no domains) creates only the 4 code domains, NOT docs.
# Docs is opt-in to avoid creating empty worktrees on every /implement run.
bash "$SCRIPT" RKT-996 default-test >/dev/null 2>&1
for d in database backend ios web; do
  [[ -d "$tmpdir/.worktrees/RKT-996-$d" ]] || { echo "FAIL: default invocation missing $d worktree"; exit 1; }
done
[[ ! -d "$tmpdir/.worktrees/RKT-996-docs" ]] || { echo "FAIL: default invocation should NOT create docs worktree"; exit 1; }

# Test: usage text mentions docs as a valid domain (regression catch — keeps the
# domain discoverable on `--help`-style invocations).
set +e
usage=$(bash "$SCRIPT" 2>&1)
set -e
echo "$usage" | grep -q "docs" || { echo "FAIL: usage text should mention 'docs' domain"; exit 1; }

echo "PASS: test-new-feature.sh"
