#!/usr/bin/env bash
#
# sync-github-labels.sh — Sync the canonical rkt label set onto the current
# repository's GitHub remote. Idempotent (`gh label create --force`).
#
# Reads the manifest at ${RKT_PLUGIN_ROOT}/templates/github-labels.json
# (or ${CLAUDE_PLUGIN_ROOT} in Claude Code; falls back to repo-relative path
# when run from the plugin dev workspace).
#
# Skips silently and exits 0 when:
#   - no `origin` remote is configured (e.g. NEW bootstrap with [Skip] for GH)
#   - `gh` CLI is not installed (already warned during bootstrap preflight)
#
# Exits non-zero only when the manifest itself is missing or malformed.
#
# Usage:
#   "${RKT_PLUGIN_ROOT}/scripts/sync-github-labels.sh"
#   "${RKT_PLUGIN_ROOT}/scripts/sync-github-labels.sh" --quiet

set -euo pipefail

QUIET="false"
[[ "${1:-}" == "--quiet" ]] && QUIET="true"

log() { [[ "$QUIET" == "true" ]] || echo "$@"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}}"
MANIFEST="$PLUGIN_ROOT/templates/github-labels.json"

[[ -f "$MANIFEST" ]] || {
  echo "Error: label manifest not found at $MANIFEST" >&2
  exit 1
}

if ! jq empty "$MANIFEST" 2>/dev/null; then
  echo "Error: label manifest at $MANIFEST is not valid JSON" >&2
  exit 1
fi

# No remote → skip silently. Bootstrap NEW with [Skip Linear] / [Skip GH] hits
# this path; the script is wired in unconditionally so the caller doesn't have
# to gate the call.
if ! git remote get-url origin >/dev/null 2>&1; then
  log "[sync-github-labels] No origin remote — skipping."
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[sync-github-labels] Warning: gh CLI not installed — skipping." >&2
  exit 0
fi

synced=0
failed=0
while IFS=$'\t' read -r name color description; do
  if gh label create "$name" --color "$color" --description "$description" --force >/dev/null 2>&1; then
    log "  [synced] $name"
    synced=$((synced + 1))
  else
    echo "  [warn] could not sync label '$name' — check gh auth and repo permissions" >&2
    failed=$((failed + 1))
  fi
done < <(jq -r '.labels[] | [.name, .color, .description] | @tsv' "$MANIFEST")

log "[sync-github-labels] $synced synced, $failed failed."

# Non-zero only when every label failed (suggests a real auth / permission
# problem). Partial failures are warned-on but don't block bootstrap.
if [[ $synced -eq 0 && $failed -gt 0 ]]; then
  exit 1
fi
