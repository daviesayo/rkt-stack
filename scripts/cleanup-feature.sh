#!/usr/bin/env bash
#
# cleanup-feature.sh — Remove worktrees and branches after a feature is merged
#
# Usage (invoke via the rkt plugin path; scripts live in the plugin):
#   "${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-feature.sh" RKT-42

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <LINEAR-ISSUE-ID>"
  echo "Example: $0 WIT-42"
  exit 1
fi

ISSUE_ID="$1"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees"

DOMAINS=("database" "backend" "ios" "web")

# ── Prune git's internal worktree tracking first ─────────

git worktree prune 2>/dev/null

echo "Cleaning up worktrees for ${ISSUE_ID}"
echo "──────────────────────────────────────────────"

for domain in "${DOMAINS[@]}"; do
  TREE_PATH="${WORKTREE_DIR}/${ISSUE_ID}-${domain}"

  if [[ -d "$TREE_PATH" ]]; then
    BRANCH=$(git -C "$TREE_PATH" symbolic-ref --short HEAD 2>/dev/null || echo "unknown")

    # Try git worktree remove first (clean path)
    git worktree remove "$TREE_PATH" --force 2>/dev/null || {
      # If git doesn't track it, just rm the directory (orphan)
      rm -rf "$TREE_PATH"
    }
    echo "  [removed worktree] ${domain}"

    # Delete the branch if it still exists
    if [[ "$BRANCH" != "unknown" ]] && git rev-parse --verify "$BRANCH" &>/dev/null; then
      git branch -D "$BRANCH" 2>/dev/null || true
      echo "  [deleted branch]   ${BRANCH}"
    fi
  else
    echo "  [skip] ${domain} — no worktree found"
  fi
done

# ── Clean up empty .worktrees directory ──────────────────

if [[ -d "$WORKTREE_DIR" ]]; then
  NON_DS=$(find "$WORKTREE_DIR" -mindepth 1 -not -name '.DS_Store' | head -1)
  if [[ -z "$NON_DS" ]]; then
    rm -rf "$WORKTREE_DIR"
    echo ""
    echo "Removed empty .worktrees/ directory"
  fi
fi

# ── Pull latest from origin ──────────────────────────────

echo ""
if git pull --ff-only origin main 2>/dev/null; then
  echo "[synced] pulled latest from origin/main"
else
  echo "[skip] could not fast-forward from origin/main (may need manual merge)"
fi

echo ""
echo "Done. All worktrees and branches for ${ISSUE_ID} cleaned up."
