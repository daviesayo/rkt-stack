#!/usr/bin/env bash
#
# new-feature.sh — Create git worktrees for parallel domain agent work
#
# Usage (invoke via the rkt plugin path; scripts live in the plugin, not your project):
#   "${CLAUDE_PLUGIN_ROOT}/scripts/new-feature.sh" RKT-42 biometric-signing database backend
#   "${CLAUDE_PLUGIN_ROOT}/scripts/new-feature.sh" RKT-42 biometric-signing              # all domains
#
# Creates a worktree per domain agent under .worktrees/, each on its own branch.
# Branch naming follows Linear convention: [ISSUE-ID]/[domain]/[description]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

# If called from inside a worktree (e.g. Claude cd'd in to do manual work),
# return to the main repo before creating new worktrees.
ensure_out_of_worktrees

# ── Args ──────────────────────────────────────────────────

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <LINEAR-ISSUE-ID> <short-description> [domain1 domain2 ...]"
  echo ""
  echo "Domains: database, backend, ios, web (default: all)"
  echo ""
  echo "Examples:"
  echo "  $0 RKT-42 biometric-signing backend ios    # only backend + ios"
  echo "  $0 RKT-42 biometric-signing                # all 4 domains"
  exit 1
fi

ISSUE_ID="$1"
DESCRIPTION="$2"
shift 2

# Sanitise description: lowercase, hyphens only
DESCRIPTION=$(echo "$DESCRIPTION" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')

# ── Resolve domains ──────────────────────────────────────

ALL_DOMAINS=("database" "backend" "ios" "web")

if [[ $# -gt 0 ]]; then
  DOMAINS=("$@")
  # Validate each domain
  for domain in "${DOMAINS[@]}"; do
    valid=false
    for allowed in "${ALL_DOMAINS[@]}"; do
      [[ "$domain" == "$allowed" ]] && valid=true && break
    done
    if [[ "$valid" == "false" ]]; then
      echo "Error: unknown domain '${domain}'. Valid domains: ${ALL_DOMAINS[*]}"
      exit 1
    fi
  done
else
  DOMAINS=("${ALL_DOMAINS[@]}")
fi

# ── Config ────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees"

# Sync local main with origin before branching — pushes unpushed commits up and
# pulls remote commits down so the feature branch base matches origin/main. Any
# unpushed commits would otherwise appear in the feature's PR diff.
if ! sync_main_with_origin; then
  echo ""
  echo "⚠️  Proceeding with a possibly out-of-sync main. Review sync warnings above before merging the PR this branch produces."
  echo ""
fi
BASE_BRANCH="main"

# ── Ensure .worktrees/ is gitignored ─────────────────────

if ! grep -qxF '.worktrees/' "${REPO_ROOT}/.gitignore" 2>/dev/null; then
  echo "" >> "${REPO_ROOT}/.gitignore"
  echo "# Agent worktrees" >> "${REPO_ROOT}/.gitignore"
  echo ".worktrees/" >> "${REPO_ROOT}/.gitignore"
  echo "Added .worktrees/ to .gitignore"
fi

# ── Create worktrees ─────────────────────────────────────

mkdir -p "$WORKTREE_DIR"

echo ""
echo "Creating worktrees for ${ISSUE_ID} (${DESCRIPTION})"
echo "Domains: ${DOMAINS[*]}"
echo "Base branch: ${BASE_BRANCH}"
echo "──────────────────────────────────────────────"

for domain in "${DOMAINS[@]}"; do
  BRANCH="${ISSUE_ID}/${domain}/${DESCRIPTION}"
  TREE_PATH="${WORKTREE_DIR}/${ISSUE_ID}-${domain}"

  if [[ -d "$TREE_PATH" ]]; then
    echo "  [skip] ${domain} — worktree already exists at ${TREE_PATH}"
    continue
  fi

  # Create worktree with new branch based on current HEAD
  git worktree add -b "$BRANCH" "$TREE_PATH" "$BASE_BRANCH" 2>/dev/null

  echo "  [created] ${domain}"
  echo "            branch:   ${BRANCH}"
  echo "            worktree: ${TREE_PATH}"
done

# ── Summary ──────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────────────"
echo "Summary"
echo "──────────────────────────────────────────────"
echo ""
printf "  %-12s %-45s %s\n" "DOMAIN" "BRANCH" "AGENT"
printf "  %-12s %-45s %s\n" "──────" "──────" "─────"
for domain in "${DOMAINS[@]}"; do
  BRANCH="${ISSUE_ID}/${domain}/${DESCRIPTION}"
  printf "  %-12s %-45s %s\n" "$domain" "$BRANCH" "${domain}-implementer"
done
echo ""
echo "To spawn an agent in a worktree:"
echo "  cd ${WORKTREE_DIR}/${ISSUE_ID}-<domain>"
echo "  claude --agent <domain>-implementer"
echo ""
echo "To clean up after merge:"
echo "  \"\${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-feature.sh\" ${ISSUE_ID}"
echo ""
