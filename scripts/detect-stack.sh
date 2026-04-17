#!/usr/bin/env bash
# scripts/detect-stack.sh <target-dir>
# Scans target directory and emits JSON describing detected signals + suggested preset.

set -euo pipefail

TARGET="${1:-.}"
[[ -d "$TARGET" ]] || { echo "Usage: $0 <target-dir>" >&2; exit 1; }

has() {
  if [[ -n "${2:-}" ]]; then
    [[ -f "$TARGET/$1" ]] && grep -q "$2" "$TARGET/$1" 2>/dev/null
  else
    [[ -e "$TARGET/$1" ]]
  fi
}

has_glob() {
  compgen -G "$TARGET/$1" >/dev/null 2>&1
}

HAS_GIT="false"; has ".git" && HAS_GIT="true"
HAS_REMOTE="false"
if [[ "$HAS_GIT" == "true" ]]; then
  (cd "$TARGET" && git remote get-url origin >/dev/null 2>&1) && HAS_REMOTE="true"
fi

HAS_RKT_JSON="false"; has "rkt.json" && HAS_RKT_JSON="true"
HAS_AGENTS_MD="false"; has "AGENTS.md" && HAS_AGENTS_MD="true"

HAS_NEXTJS="false"
has "package.json" '"next"' && HAS_NEXTJS="true"

HAS_VITE="false"
has "package.json" '"vite"' && has "package.json" '"react"' && HAS_VITE="true"

HAS_FASTAPI="false"
has "pyproject.toml" "fastapi" && HAS_FASTAPI="true"
[[ "$HAS_FASTAPI" == "false" ]] && has "backend/pyproject.toml" "fastapi" && HAS_FASTAPI="true"

HAS_XCODEPROJ="false"
has_glob "*.xcodeproj" && HAS_XCODEPROJ="true"
[[ "$HAS_XCODEPROJ" == "false" ]] && has_glob "*.xcworkspace" && HAS_XCODEPROJ="true"
[[ "$HAS_XCODEPROJ" == "false" ]] && has_glob "ios/*.xcodeproj" && HAS_XCODEPROJ="true"
[[ "$HAS_XCODEPROJ" == "false" ]] && [[ -d "$TARGET/ios" ]] && HAS_XCODEPROJ="true"

HAS_SUPABASE="false"
[[ -d "$TARGET/supabase/migrations" ]] && HAS_SUPABASE="true"
[[ "$HAS_SUPABASE" == "false" ]] && [[ -d "$TARGET/backend/supabase/migrations" ]] && HAS_SUPABASE="true"

SUGGESTED="null"
component_count=0
[[ "$HAS_XCODEPROJ" == "true" ]] && ((component_count++)) || true
([[ "$HAS_NEXTJS" == "true" ]] || [[ "$HAS_VITE" == "true" ]]) && ((component_count++)) || true
[[ "$HAS_FASTAPI" == "true" ]] && ((component_count++)) || true

if [[ $component_count -ge 2 ]]; then
  SUGGESTED="full"
elif [[ "$HAS_XCODEPROJ" == "true" ]]; then
  SUGGESTED="ios"
elif [[ "$HAS_NEXTJS" == "true" ]] || [[ "$HAS_VITE" == "true" ]]; then
  SUGGESTED="web"
elif [[ "$HAS_FASTAPI" == "true" ]]; then
  SUGGESTED="backend"
fi

cat <<EOF
{
  "target": "$TARGET",
  "suggested_preset": $(if [[ "$SUGGESTED" == "null" ]]; then echo "null"; else echo "\"$SUGGESTED\""; fi),
  "signals": {
    "has_git": $HAS_GIT,
    "has_remote": $HAS_REMOTE,
    "has_rkt_json": $HAS_RKT_JSON,
    "has_agents_md": $HAS_AGENTS_MD,
    "has_nextjs": $HAS_NEXTJS,
    "has_vite": $HAS_VITE,
    "has_fastapi": $HAS_FASTAPI,
    "has_xcodeproj": $HAS_XCODEPROJ,
    "has_supabase": $HAS_SUPABASE
  }
}
EOF
