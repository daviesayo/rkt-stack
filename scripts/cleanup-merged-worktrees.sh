#!/usr/bin/env bash
#
# cleanup-merged-worktrees.sh — Remove worktrees whose branches have been merged
#
# Handles three cases:
#   1. Git-tracked worktrees with merged branches → git worktree remove + branch delete
#   2. Orphan directories git forgot about → git worktree prune + rm directory
#   3. Worktrees with branches deleted on remote → detect [gone] branches, clean up
#
# Always pulls from origin as the final step to keep local main up to date.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

# Safety: never delete the worktree the caller is standing in.
ensure_out_of_worktrees

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees"
CLEANED=0

# ── Step 1: Prune git's internal worktree tracking ───────

git worktree prune 2>/dev/null

# ── Step 2: Clean git-tracked worktrees with merged branches ─

if [[ -d "$WORKTREE_DIR" ]]; then
  shopt -s nullglob
  TREES=("${WORKTREE_DIR}"/*)
  shopt -u nullglob

  for tree_path in "${TREES[@]}"; do
    [[ -d "$tree_path" ]] || continue

    BRANCH=$(git -C "$tree_path" symbolic-ref --short HEAD 2>/dev/null || echo "")

    if [[ -n "$BRANCH" ]]; then
      if git branch --merged main 2>/dev/null | grep -qw "$BRANCH"; then
        git worktree remove "$tree_path" --force 2>/dev/null || true
        git branch -d "$BRANCH" 2>/dev/null || true
        echo "  [cleaned] ${tree_path##*/} (${BRANCH} merged to main)"
        CLEANED=$((CLEANED + 1))
      fi
    fi
  done
fi

# ── Step 3: Remove orphan directories git no longer tracks ─

if [[ -d "$WORKTREE_DIR" ]]; then
  TRACKED_PATHS=$(git worktree list --porcelain 2>/dev/null | grep "^worktree " | sed 's/^worktree //')

  shopt -s nullglob
  REMAINING=("${WORKTREE_DIR}"/*)
  shopt -u nullglob

  for tree_path in "${REMAINING[@]}"; do
    [[ -d "$tree_path" ]] || continue

    if ! echo "$TRACKED_PATHS" | grep -qxF "$tree_path"; then
      BRANCH=$(git -C "$tree_path" symbolic-ref --short HEAD 2>/dev/null || echo "unknown")

      if [[ "$BRANCH" != "unknown" ]] && git rev-parse --verify "$BRANCH" &>/dev/null; then
        git branch -D "$BRANCH" 2>/dev/null || true
      fi

      rm -rf "$tree_path"
      echo "  [cleaned] ${tree_path##*/} (orphan directory, branch: ${BRANCH})"
      CLEANED=$((CLEANED + 1))
    fi
  done
fi

# ── Step 4: Clean branches marked as [gone] on remote ────

GONE_BRANCHES=$(git branch -vv 2>/dev/null | grep ': gone]' | awk '{print $1}' || true)
if [[ -n "$GONE_BRANCHES" ]]; then
  while IFS= read -r branch; do
    [[ -z "$branch" ]] && continue
    [[ "$branch" == "main" || "$branch" == "master" ]] && continue
    git branch -D "$branch" 2>/dev/null || true
    echo "  [cleaned] branch ${branch} (remote deleted)"
    CLEANED=$((CLEANED + 1))
  done <<< "$GONE_BRANCHES"
fi

# ── Step 5: Remove empty .worktrees directory ────────────

if [[ -d "$WORKTREE_DIR" ]]; then
  NON_DS=$(find "$WORKTREE_DIR" -mindepth 1 -not -name '.DS_Store' | head -1)
  if [[ -z "$NON_DS" ]]; then
    rm -rf "$WORKTREE_DIR"
  fi
fi

# ── Step 6: Pull from origin ────────────────────────────

if git pull --ff-only origin main 2>/dev/null; then
  echo "  [synced] pulled latest from origin/main"
else
  echo "  [skip] could not fast-forward from origin/main (may need manual merge)"
fi

# ── Report ───────────────────────────────────────────────

if [[ $CLEANED -gt 0 ]]; then
  echo "Cleaned up ${CLEANED} item(s)."
fi
