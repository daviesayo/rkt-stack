#!/usr/bin/env bash
# tests/test-bootstrap-adopt.sh — ADOPT mode integration test
#
# Simulates ADOPT by pre-populating a temp directory with Next.js signals
# and a pre-existing CLAUDE.md, then runs the skill's mechanics directly.
# Conflict resolution is simulated by always choosing "Keep mine" (we
# cannot call AskUserQuestion from shell).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HERE/.."

tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT

# ── Seed: existing Next.js project with a pre-existing CLAUDE.md ──────────────
cp -R "$HERE/fixtures/nextjs-existing/." "$tmpdir/"
cd "$tmpdir"
git init -q -b main
cat > CLAUDE.md <<'EOF'
# Existing CLAUDE.md
My own conventions live here. Preserve me.
EOF
git add .
git commit -q -m "initial"

# ── 1. Detection must suggest `web` and flag has_claude_md ───────────────────
DETECT=$(bash "$PLUGIN_DIR/scripts/detect-stack.sh" "$tmpdir")

[[ $(echo "$DETECT" | jq -r .suggested_preset) == "web" ]] \
  || { echo "FAIL: detect should suggest web (got $(echo "$DETECT" | jq -r .suggested_preset))"; exit 1; }

[[ $(echo "$DETECT" | jq -r .signals.has_claude_md) == "true" ]] \
  || { echo "FAIL: has_claude_md should be true"; exit 1; }

# ── 2. Simulate TMPVARS (what A2/A3 would produce) ───────────────────────────
TMPVARS=$(mktemp)
cat > "$TMPVARS" <<'EOF'
{
  "PROJECT_NAME": "nextjs-existing",
  "PROJECT_NAME_PASCAL": "NextjsExisting",
  "PRESET": "web",
  "LINEAR_PREFIX": "NE",
  "LINEAR_TEAM_ID": "placeholder",
  "LINEAR_PROJECT_ID": "",
  "LINEAR_PROJECT_URL": "",
  "MEMPALACE_PREFIX": "nextjs-existing",
  "GH_VISIBILITY": "skip",
  "DEPLOY_BACKEND": null,
  "DEPLOY_WEB": "vercel",
  "DEPLOY_DB": "supabase",
  "DATE": "2026-04-18",
  "RKT_VERSION": "0.1.0"
}
EOF

# ── 3. Additive scaffold (Step A4) — must NOT overwrite existing files ────────
SCAFFOLD="$PLUGIN_DIR/templates/presets/web"
(cd "$SCAFFOLD" && find . -type f ! -path "./.*") | while read -r rel; do
  dest="$tmpdir/${rel#./}"
  if [[ ! -e "$dest" ]]; then
    mkdir -p "$(dirname "$dest")"
    if grep -q '{{' "$SCAFFOLD/$rel" 2>/dev/null; then
      "$PLUGIN_DIR/scripts/render-template.sh" "$SCAFFOLD/$rel" "$dest" "$(cat "$TMPVARS")"
    else
      cp "$SCAFFOLD/$rel" "$dest"
    fi
  fi
  # Existing files are skipped — that's the whole point of ADOPT mode.
done

# Verify the fixture's package.json was NOT overwritten
grep -q "fake-next-app" "$tmpdir/package.json" \
  || { echo "FAIL: package.json was overwritten (should still contain 'fake-next-app')"; exit 1; }

# ── 4. Render global templates (Step A5) ─────────────────────────────────────
# CLAUDE.md conflict → simulate "Keep mine": skip rendering it.
# All other templates are absent, so create them.
for tmpl in PROGRESS.md OPS.md rkt.json; do
  "$PLUGIN_DIR/scripts/render-template.sh" \
    "$PLUGIN_DIR/templates/${tmpl}.tmpl" "$tmpdir/$tmpl" "$(cat "$TMPVARS")"
done

mkdir -p "$tmpdir/docs/decisions"
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/decisions.md.tmpl" "$tmpdir/decisions.md" "$(cat "$TMPVARS")"
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/agent_learnings.md.tmpl" \
  "$tmpdir/docs/decisions/agent_learnings.md" "$(cat "$TMPVARS")"

# CLAUDE.md conflict: "Keep mine" — existing file must still be intact
grep -q "My own conventions" "$tmpdir/CLAUDE.md" \
  || { echo "FAIL: CLAUDE.md was overwritten despite simulated 'Keep mine'"; exit 1; }

# ── 5. Copy rules (Step A5, rules section) ───────────────────────────────────
mkdir -p "$tmpdir/.claude/rules"
cp "$PLUGIN_DIR/rules/web-nextjs.md"  "$tmpdir/.claude/rules/"
cp "$PLUGIN_DIR/rules/supabase.md"    "$tmpdir/.claude/rules/"

# ── 6. Commit on existing history (Step A7) ───────────────────────────────────
cd "$tmpdir"
git add .
git commit -q -m "[rkt] test adoption"

# ── Assertions ────────────────────────────────────────────────────────────────

# Required files created
[[ -f "$tmpdir/rkt.json" ]] \
  || { echo "FAIL: rkt.json missing"; exit 1; }

[[ -f "$tmpdir/.claude/rules/web-nextjs.md" ]] \
  || { echo "FAIL: .claude/rules/web-nextjs.md missing"; exit 1; }

[[ -f "$tmpdir/.claude/rules/supabase.md" ]] \
  || { echo "FAIL: .claude/rules/supabase.md missing"; exit 1; }

# rkt.json preset must be "web"
[[ $(jq -r .preset "$tmpdir/rkt.json") == "web" ]] \
  || { echo "FAIL: rkt.json preset wrong (got $(jq -r .preset "$tmpdir/rkt.json"))"; exit 1; }

# rkt.json project_name must match
[[ $(jq -r .project_name "$tmpdir/rkt.json") == "nextjs-existing" ]] \
  || { echo "FAIL: rkt.json project_name wrong (got $(jq -r .project_name "$tmpdir/rkt.json"))"; exit 1; }

# Cleanup
rm -f "$TMPVARS"

# ── Test 2: src/-layout fixture must NOT receive root app/ or lib/ ────────────
tmpdir2=$(mktemp -d)
trap "rm -rf $tmpdir $tmpdir2" EXIT

cp -R "$HERE/fixtures/nextjs-src-layout/." "$tmpdir2/"
cd "$tmpdir2"
git init -q -b main
git add .
git commit -q -m "initial"

DETECT2=$(bash "$PLUGIN_DIR/scripts/detect-stack.sh" "$tmpdir2")

[[ $(echo "$DETECT2" | jq -r .signals.nextjs_layout) == "src" ]] \
  || { echo "FAIL: nextjs_layout should be src for nextjs-src-layout fixture"; exit 1; }

TMPVARS2=$(mktemp)
cat > "$TMPVARS2" <<'EOF'
{
  "PROJECT_NAME": "nextjs-src-layout",
  "PROJECT_NAME_PASCAL": "NextjsSrcLayout",
  "PRESET": "web",
  "LINEAR_PREFIX": "NSL",
  "LINEAR_TEAM_ID": "placeholder",
  "LINEAR_PROJECT_ID": "",
  "LINEAR_PROJECT_URL": "",
  "MEMPALACE_PREFIX": "nextjs-src-layout",
  "GH_VISIBILITY": "skip",
  "DEPLOY_BACKEND": null,
  "DEPLOY_WEB": "vercel",
  "DEPLOY_DB": "supabase",
  "DATE": "2026-04-18",
  "RKT_VERSION": "0.1.3"
}
EOF

# Replicate Step A4's src/-layout skip logic
NEXTJS_LAYOUT=$(echo "$DETECT2" | jq -r '.signals.nextjs_layout // "none"')
SKIP_ROOT_APP_LIB="false"
if [[ $(jq -r .PRESET "$TMPVARS2") == "web" && "$NEXTJS_LAYOUT" == "src" ]]; then
  SKIP_ROOT_APP_LIB="true"
fi

SCAFFOLD2="$PLUGIN_DIR/templates/presets/web"
(cd "$SCAFFOLD2" && find . -type f ! -path "./.*") | while read -r rel; do
  rel_clean="${rel#./}"
  if [[ "$SKIP_ROOT_APP_LIB" == "true" ]]; then
    case "$rel_clean" in
      app/*|lib/*) continue ;;
    esac
  fi
  dest="$tmpdir2/$rel_clean"
  if [[ ! -e "$dest" ]]; then
    mkdir -p "$(dirname "$dest")"
    if grep -q '{{' "$SCAFFOLD2/$rel" 2>/dev/null; then
      "$PLUGIN_DIR/scripts/render-template.sh" "$SCAFFOLD2/$rel" "$dest" "$(cat "$TMPVARS2")"
    else
      cp "$SCAFFOLD2/$rel" "$dest"
    fi
  fi
done

# Root-level app/ and lib/ MUST NOT exist (they would conflict with src/app/)
[[ ! -e "$tmpdir2/app/page.tsx" ]] \
  || { echo "FAIL: $tmpdir2/app/page.tsx exists — preset's root app/ should have been skipped"; exit 1; }
[[ ! -e "$tmpdir2/app/layout.tsx" ]] \
  || { echo "FAIL: $tmpdir2/app/layout.tsx exists — preset's root app/ should have been skipped"; exit 1; }
[[ ! -e "$tmpdir2/lib/supabase.ts" ]] \
  || { echo "FAIL: $tmpdir2/lib/supabase.ts exists — preset's root lib/ should have been skipped"; exit 1; }

# Project's existing src/app/page.tsx must be preserved
grep -q "fixture: src layout" "$tmpdir2/src/app/page.tsx" \
  || { echo "FAIL: src/app/page.tsx was clobbered"; exit 1; }

# Other preset files (e.g. tsconfig.json, supabase migrations) should still be created
[[ -f "$tmpdir2/tsconfig.json" ]] \
  || { echo "FAIL: tsconfig.json should have been scaffolded"; exit 1; }

rm -f "$TMPVARS2"

# ── Verify rkt.json from Test 1 has DEPLOY_BACKEND as JSON null, not "null" ───
[[ $(jq -r '.deploy.backend | type' "$tmpdir/rkt.json") == "null" ]] \
  || { echo "FAIL: rkt.json deploy.backend should be JSON null, got $(jq -r '.deploy.backend | type' "$tmpdir/rkt.json")"; exit 1; }

echo "PASS: test-bootstrap-adopt.sh"
