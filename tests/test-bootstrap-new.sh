#!/usr/bin/env bash
# tests/test-bootstrap-new.sh — end-to-end test for NEW mode (Linear/GH skipped)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HERE/.."

tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT

cd "$tmpdir"

# Simulate what the skill does internally — call the scripts directly to
# verify the mechanics work, without requiring the full Claude session.

# 1. Detect state: should return null preset
detected=$(bash "$PLUGIN_DIR/scripts/detect-stack.sh" "$tmpdir")
[[ $(echo "$detected" | jq -r .suggested_preset) == "null" ]] || { echo "FAIL: empty dir should suggest null"; exit 1; }

# 2. Simulate Step N2 — write TMPVARS
TMPVARS=$(mktemp)
cat > "$TMPVARS" <<'EOF'
{
  "PROJECT_NAME": "test-proj",
  "PROJECT_NAME_PASCAL": "TestProj",
  "PRESET": "backend",
  "LINEAR_PREFIX": "TP",
  "LINEAR_TEAM_ID": "placeholder",
  "LINEAR_PROJECT_ID": "",
  "LINEAR_PROJECT_URL": "",
  "MEMPALACE_PREFIX": "testproj",
  "GH_VISIBILITY": "skip",
  "DEPLOY_BACKEND": "railway",
  "DEPLOY_WEB": "null",
  "DEPLOY_DB": "supabase",
  "DATE": "2026-04-18",
  "RKT_VERSION": "0.1.0"
}
EOF

# 3. Simulate Step N3 — copy scaffold
cp -R "$PLUGIN_DIR/templates/presets/backend/." "$tmpdir/"

# 4. Render scaffold files (files with {{tokens}})
find "$tmpdir" -type f ! -path "*/.git/*" | while IFS= read -r f; do
  if grep -q '{{' "$f" 2>/dev/null; then
    "$PLUGIN_DIR/scripts/render-template.sh" "$f" "$f.rendered" "$(cat "$TMPVARS")"
    mv "$f.rendered" "$f"
  fi
done

# 5. Render global templates
for tmpl in CLAUDE.md PROGRESS.md OPS.md README.md rkt.json; do
  "$PLUGIN_DIR/scripts/render-template.sh" \
    "$PLUGIN_DIR/templates/${tmpl}.tmpl" "$tmpdir/$tmpl" "$(cat "$TMPVARS")"
done
mkdir -p "$tmpdir/docs/decisions"
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/decisions.md.tmpl" "$tmpdir/decisions.md" "$(cat "$TMPVARS")"
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/agent_learnings.md.tmpl" "$tmpdir/docs/decisions/agent_learnings.md" "$(cat "$TMPVARS")"

# 6. Copy rules
mkdir -p "$tmpdir/.claude/rules"
cp "$PLUGIN_DIR/rules/backend-fastapi.md" "$tmpdir/.claude/rules/"
cp "$PLUGIN_DIR/rules/supabase.md" "$tmpdir/.claude/rules/"

# 7. git init
cd "$tmpdir"
git init -q -b main
git add .
git commit -q -m "test"

# Assertions
[[ -f "$tmpdir/rkt.json" ]] || { echo "FAIL: rkt.json missing"; exit 1; }
[[ -f "$tmpdir/CLAUDE.md" ]] || { echo "FAIL: CLAUDE.md missing"; exit 1; }
[[ -f "$tmpdir/PROGRESS.md" ]] || { echo "FAIL: PROGRESS.md missing"; exit 1; }
[[ -f "$tmpdir/decisions.md" ]] || { echo "FAIL: decisions.md missing"; exit 1; }
[[ -f "$tmpdir/docs/decisions/agent_learnings.md" ]] || { echo "FAIL: agent_learnings missing"; exit 1; }
[[ -f "$tmpdir/pyproject.toml" ]] || { echo "FAIL: pyproject.toml not copied"; exit 1; }
[[ -f "$tmpdir/app/main.py" ]] || { echo "FAIL: backend scaffold missing"; exit 1; }
[[ -f "$tmpdir/.claude/rules/backend-fastapi.md" ]] || { echo "FAIL: backend rule not copied"; exit 1; }
[[ -f "$tmpdir/.claude/rules/supabase.md" ]] || { echo "FAIL: supabase rule not copied"; exit 1; }

# rkt.json should have the right values
[[ $(jq -r .project_name "$tmpdir/rkt.json") == "test-proj" ]] || { echo "FAIL: rkt.json project_name wrong"; exit 1; }
[[ $(jq -r .preset "$tmpdir/rkt.json") == "backend" ]] || { echo "FAIL: rkt.json preset wrong"; exit 1; }

# No unrendered tokens anywhere
if grep -rE '\{\{[A-Z_]+\}\}' "$tmpdir" --include="*.md" --include="*.json" --include="*.py" --include="*.toml" 2>/dev/null; then
  echo "FAIL: unrendered tokens found"
  exit 1
fi

rm -f "$TMPVARS"
echo "PASS: test-bootstrap-new.sh"
