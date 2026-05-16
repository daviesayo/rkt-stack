#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/plugins/rkt"

CLAUDE_MANIFEST="$PLUGIN_DIR/.claude-plugin/plugin.json"
CODEX_MANIFEST="$PLUGIN_DIR/.codex-plugin/plugin.json"
CODEX_MARKETPLACE="$ROOT/.agents/plugins/marketplace.json"
CLAUDE_MARKETPLACE="$ROOT/.claude-plugin/marketplace.json"

for file in "$CLAUDE_MANIFEST" "$CODEX_MANIFEST" "$CODEX_MARKETPLACE" "$CLAUDE_MARKETPLACE"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "Expected real manifest file at ${file#$ROOT/}" >&2
    exit 1
  fi
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

claude_source="$(jq -r '.plugins[] | select(.name == "rkt") | .source' "$CLAUDE_MARKETPLACE")"
if [[ "$claude_source" != "./plugins/rkt" ]]; then
  echo "Claude marketplace should point at ./plugins/rkt, got $claude_source" >&2
  exit 1
fi

for path in .codex-plugin .claude-plugin skills scripts templates rules agents README.md CHANGELOG.md LICENSE; do
  if [[ ! -e "$PLUGIN_DIR/$path" || -L "$PLUGIN_DIR/$path" ]]; then
    echo "Plugin package should contain a real $path at plugins/rkt/$path" >&2
    exit 1
  fi
done

skill_count=$(find "$PLUGIN_DIR/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')
if [[ "$skill_count" -lt 1 ]]; then
  echo "Plugin package should contain skill files under plugins/rkt/skills" >&2
  exit 1
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
cp -R "$PLUGIN_DIR" "$tmpdir/rkt"
jq empty "$tmpdir/rkt/.claude-plugin/plugin.json"
jq empty "$tmpdir/rkt/.codex-plugin/plugin.json"
[[ -d "$tmpdir/rkt/skills" ]] || { echo "Packaged plugin copy is missing skills/"; exit 1; }
[[ -f "$tmpdir/rkt/skills/bootstrap/SKILL.md" ]] || { echo "Packaged plugin copy is missing bootstrap skill"; exit 1; }

echo "Plugin manifests are valid and in sync."
