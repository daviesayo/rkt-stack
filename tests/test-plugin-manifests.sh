#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CLAUDE_MANIFEST="$ROOT/.claude-plugin/plugin.json"
CODEX_MANIFEST="$ROOT/.codex-plugin/plugin.json"
CODEX_MARKETPLACE="$ROOT/.agents/plugins/marketplace.json"

for file in "$CLAUDE_MANIFEST" "$CODEX_MANIFEST" "$CODEX_MARKETPLACE"; do
  jq empty "$file"
done

claude_name="$(jq -r '.name' "$CLAUDE_MANIFEST")"
codex_name="$(jq -r '.name' "$CODEX_MANIFEST")"
if [[ "$claude_name" != "$codex_name" ]]; then
  echo "Manifest names differ: Claude=$claude_name Codex=$codex_name" >&2
  exit 1
fi

claude_version="$(jq -r '.version' "$CLAUDE_MANIFEST")"
codex_version="$(jq -r '.version' "$CODEX_MANIFEST")"
if [[ "$claude_version" != "$codex_version" ]]; then
  echo "Manifest versions differ: Claude=$claude_version Codex=$codex_version" >&2
  exit 1
fi

codex_skill_path="$(jq -r '.skills' "$CODEX_MANIFEST")"
if [[ "$codex_skill_path" != "./skills/" ]]; then
  echo "Codex manifest should load skills from ./skills/, got $codex_skill_path" >&2
  exit 1
fi

marketplace_path="$(jq -r '.plugins[] | select(.name == "rkt") | .source.path' "$CODEX_MARKETPLACE")"
if [[ "$marketplace_path" != "./plugins/rkt" ]]; then
  echo "Codex marketplace should point at ./plugins/rkt, got $marketplace_path" >&2
  exit 1
fi

PLUGIN_WRAPPER="$ROOT/plugins/rkt"
for path in .codex-plugin .claude-plugin skills scripts templates rules agents; do
  if [[ ! -L "$PLUGIN_WRAPPER/$path" ]]; then
    echo "Codex plugin wrapper should symlink $path back to the repo root" >&2
    exit 1
  fi
done

echo "Plugin manifests are valid and in sync."
