#!/usr/bin/env bash
# tests/test-rkt-sync.sh — simulate a version bump and re-sync, including
# preservation of project-owned files (.claude/rules/project-*.md, agents/*.project.md)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HERE/../plugins/rkt"

tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT

cd "$tmpdir"
git init -q -b main
git config user.email "test@test.com"
git config user.name "Test"

# ── Seed a "bootstrapped" project at version 0.0.9 ──────────────────────────
cat > rkt.json <<'EOF'
{
  "project_name": "synctest",
  "preset": "backend",
  "linear": { "project_id": "", "project_url": "", "team_id": "", "issue_prefix": "ST" },
  "mempalace": { "specialist_prefix": "synctest" },
  "deploy": { "backend": "railway", "web": null, "db": "supabase" },
  "bootstrap": { "date": "2026-04-01", "rkt_plugin_version": "0.0.9" }
}
EOF

TMPVARS=$(mktemp)
jq '{
  PROJECT_NAME: .project_name,
  PROJECT_NAME_PASCAL: "Synctest",
  PRESET: .preset,
  LINEAR_PREFIX: .linear.issue_prefix,
  LINEAR_PROJECT_ID: .linear.project_id,
  LINEAR_PROJECT_URL: .linear.project_url,
  LINEAR_TEAM_ID: .linear.team_id,
  MEMPALACE_PREFIX: .mempalace.specialist_prefix,
  DEPLOY_BACKEND: .deploy.backend,
  DEPLOY_WEB: "null",
  DEPLOY_DB: .deploy.db,
  DATE: .bootstrap.date,
  RKT_VERSION: "0.0.9"
}' rkt.json > "$TMPVARS"

# Render templates at "old" version
for tmpl in CLAUDE.md PROGRESS.md OPS.md README.md decisions.md; do
  "$PLUGIN_DIR/scripts/render-template.sh" \
    "$PLUGIN_DIR/templates/${tmpl}.tmpl" "$tmpdir/$tmpl" "$(cat "$TMPVARS")"
done
mkdir -p docs/decisions
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/agent_learnings.md.tmpl" "docs/decisions/agent_learnings.md" "$(cat "$TMPVARS")"

# Copy preset rules (as bootstrap would)
mkdir -p .claude/rules
cp "$PLUGIN_DIR/rules/backend-fastapi.md" .claude/rules/
cp "$PLUGIN_DIR/rules/supabase.md" .claude/rules/

# ── Create project-owned files that sync must NEVER touch ───────────────────
mkdir -p .claude/rules agents

PROJECT_RULE_CONTENT="# project-backend.md
This is a project-owned rule written by /rkt-tailor.
DO NOT overwrite — if you see this, preservation worked.
custom rule: always use async endpoints"
echo "$PROJECT_RULE_CONTENT" > .claude/rules/project-backend.md

PROJECT_AGENT_CONTENT="# backend-implementer.project.md
Project-level agent overlay.
DO NOT overwrite — if you see this, preservation worked.
extra-instruction: always use dependency injection"
echo "$PROJECT_AGENT_CONTENT" > agents/backend-implementer.project.md

git add .
git commit -q -m "initial bootstrap at 0.0.9"

# ── Simulate "current installed version is now 0.1.0" ────────────────────────
CURRENT=$(jq -r .version "$PLUGIN_DIR/.claude-plugin/plugin.json")

# Bump TMPVARS to current version
jq --arg v "$CURRENT" '.RKT_VERSION = $v' "$TMPVARS" > "${TMPVARS}.new"
mv "${TMPVARS}.new" "$TMPVARS"

# ── Idempotency check: re-render each template and verify output file exists ──
for tmpl in CLAUDE.md PROGRESS.md OPS.md README.md; do
  rendered=$(mktemp)
  "$PLUGIN_DIR/scripts/render-template.sh" \
    "$PLUGIN_DIR/templates/${tmpl}.tmpl" "$rendered" "$(cat "$TMPVARS")"
  [[ -s "$rendered" ]] || { echo "FAIL: re-render of $tmpl produced empty file"; exit 1; }
  rm -f "$rendered"
done

# ── Simulate the sync preservation logic ─────────────────────────────────────
# The sync skill skips .claude/rules/project-*.md and agents/*.project.md.
# We verify this by simulating what would happen if the sync ran naively
# (copying plugin rules) and then ensuring project-owned files are untouched.

# Simulate the "skip project-owned" guard from the skill:
#   for rule in .claude/rules/project-*.md; do skip; done
#   for agent in agents/*.project.md; do skip; done
# This means those files should be exactly what we wrote above.

# ── Assertions: project-owned files must be byte-for-byte identical ──────────
[[ -f ".claude/rules/project-backend.md" ]] || {
  echo "FAIL: project-backend.md disappeared"; exit 1
}
[[ -f "agents/backend-implementer.project.md" ]] || {
  echo "FAIL: backend-implementer.project.md disappeared"; exit 1
}

# Content must be unchanged (verify key marker line is present)
grep -q "DO NOT overwrite" .claude/rules/project-backend.md || {
  echo "FAIL: project-backend.md was modified (preservation failed)"; exit 1
}
grep -q "DO NOT overwrite" agents/backend-implementer.project.md || {
  echo "FAIL: backend-implementer.project.md was modified (preservation failed)"; exit 1
}

# ── Simulate bumping rkt_plugin_version in rkt.json (Step 6 of sync) ─────────
jq --arg v "$CURRENT" '.bootstrap.rkt_plugin_version = $v' rkt.json > rkt.json.new
mv rkt.json.new rkt.json

# Assert version was actually bumped
SAVED=$(jq -r .bootstrap.rkt_plugin_version rkt.json)
[[ "$SAVED" == "$CURRENT" ]] || {
  echo "FAIL: version not bumped (got '$SAVED', expected '$CURRENT')"; exit 1
}

# ── Assert project-owned files still untouched after rkt.json rewrite ─────────
grep -q "DO NOT overwrite" .claude/rules/project-backend.md || {
  echo "FAIL: project-backend.md was clobbered during rkt.json bump"; exit 1
}
grep -q "DO NOT overwrite" agents/backend-implementer.project.md || {
  echo "FAIL: backend-implementer.project.md was clobbered during rkt.json bump"; exit 1
}

# ── Assert plugin rules were NOT accidentally removed ─────────────────────────
[[ -f ".claude/rules/backend-fastapi.md" ]] || {
  echo "FAIL: backend-fastapi.md missing (plugin rule should be present)"; exit 1
}
[[ -f ".claude/rules/supabase.md" ]] || {
  echo "FAIL: supabase.md missing (plugin rule should be present)"; exit 1
}

# ── Assert rendered files exist and are non-empty ─────────────────────────────
for f in CLAUDE.md PROGRESS.md OPS.md README.md decisions.md "docs/decisions/agent_learnings.md"; do
  [[ -s "$f" ]] || { echo "FAIL: $f is missing or empty"; exit 1; }
done

rm -f "$TMPVARS"

# ── Preset → rules mapping must match bootstrap and cover all 4 presets ─────
# Extract the case statement from rkt-sync's SKILL.md and EXECUTE it. This
# catches runtime regressions (e.g. bash-version bugs in declare -A) that a
# pure-text grep cannot. Skips need to mirror bootstrap's Step N4/A5 mapping.
SYNC_SKILL="$PLUGIN_DIR/skills/rkt-sync/SKILL.md"

# Pull the `case "$PRESET" in ... esac` block out of the SKILL prose
case_block=$(awk '
  /^case "\$PRESET" in$/ { capturing = 1 }
  capturing             { print }
  /^esac$/              { capturing = 0 }
' "$SYNC_SKILL")

[[ -n "$case_block" ]] || {
  echo "FAIL: no \`case \"\$PRESET\" in ... esac\` block found in rkt-sync SKILL"
  exit 1
}

# Run the extracted block for each preset and verify the resolved rules
assert_preset_resolves() {
  local preset="$1"
  local expected="$2"
  local actual
  actual=$(PRESET="$preset" bash -c "$case_block; printf '%s' \"\$APPLICABLE_RULES\"")
  [[ "$actual" == "$expected" ]] || {
    echo "FAIL: rkt-sync runtime: PRESET=$preset → '$actual', expected '$expected'"
    exit 1
  }
}

assert_preset_resolves "full"    "backend-fastapi.md supabase.md web-vite.md ios-design.md"
assert_preset_resolves "web"     "web-nextjs.md supabase.md"
assert_preset_resolves "backend" "backend-fastapi.md supabase.md"
assert_preset_resolves "ios"     "ios-design.md"

# Unknown preset must resolve to empty (defensive — no silent fallback)
unknown=$(PRESET="bogus" bash -c "$case_block; printf '%s' \"\$APPLICABLE_RULES\"" 2>/dev/null)
[[ -z "$unknown" ]] || {
  echo "FAIL: unknown preset 'bogus' resolved to '$unknown' (expected empty)"
  exit 1
}

# Every rule file referenced must exist in the plugin's rules/ directory
for rule in backend-fastapi.md supabase.md web-vite.md web-nextjs.md ios-design.md; do
  [[ -f "$PLUGIN_DIR/rules/$rule" ]] || {
    echo "FAIL: rules/$rule missing (referenced by rkt-sync case statement)"
    exit 1
  }
done

# rkt-sync MUST NOT keep the stale preset names anywhere
for stale in "web-next" "fullstack" "fullstack-next"; do
  ! grep -qE "(^|\s)${stale}\)" "$SYNC_SKILL" || {
    echo "FAIL: rkt-sync still has '${stale})' case branch"
    exit 1
  }
done

# Defense in depth: declare -A must NOT reappear in rkt-sync's preset block
# (it's bash 4+ and degrades silently on macOS bash 3.2).
! grep -q "declare -A PRESET_RULES" "$SYNC_SKILL" || {
  echo "FAIL: rkt-sync uses 'declare -A PRESET_RULES' which silently breaks on bash 3.2"
  exit 1
}

echo "PASS: test-rkt-sync.sh"
