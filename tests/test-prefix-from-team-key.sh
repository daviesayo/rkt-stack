#!/usr/bin/env bash
# tests/test-prefix-from-team-key.sh
#
# Regression test for the Linear-team-key-as-prefix contract (Issue 1 in the
# 0.3.0 wdyd-platform feedback). The actual team-key fetch is done by the
# Claude orchestrator following SKILL.md instructions — bash can't simulate
# that — so this test asserts:
#
#   1. The contract is written down in the right SKILL.md files (bootstrap NEW,
#      bootstrap ADOPT, implement verification, rkt-tailor repair). Future
#      edits that silently delete these instructions will fail this test.
#   2. When TMPVARS.LINEAR_PREFIX is set to a team-key value, it flows through
#      render-template.sh into rkt.json as the canonical issue_prefix.
#   3. CLAUDE.md's branch/PR-title examples use {{LINEAR_PREFIX}} (so they
#      render with the correct prefix and don't ship hardcoded WDYD-style
#      examples).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/../plugins/rkt" && pwd)"

# 1. Bootstrap NEW: team selection precedes prefix prompt.
grep -q "must run BEFORE the issue-prefix prompt" "$PLUGIN_DIR/skills/bootstrap/SKILL.md" \
  || { echo "FAIL: bootstrap NEW skill missing 'team before prefix' instruction"; exit 1; }
grep -q "Default to .LINEAR_TEAM_KEY" "$PLUGIN_DIR/skills/bootstrap/SKILL.md" \
  || { echo "FAIL: bootstrap NEW skill missing 'prefix defaults to team key' instruction"; exit 1; }

# 2. Bootstrap ADOPT: Step A6 'Create new' uses team.key for prefix.
grep -q "team.key. as .LINEAR_PREFIX" "$PLUGIN_DIR/skills/bootstrap/SKILL.md" \
  || { echo "FAIL: bootstrap ADOPT 'Create new' missing team-key-to-prefix instruction"; exit 1; }

# 3. /implement Step 0b verifies prefix matches team.key.
grep -q "Verify the issue prefix matches the Linear team key" "$PLUGIN_DIR/skills/implement/SKILL.md" \
  || { echo "FAIL: /implement skill missing prefix verification step"; exit 1; }
grep -q '"\$ACTUAL_KEY" != "\$PREFIX"' "$PLUGIN_DIR/skills/implement/SKILL.md" \
  || { echo "FAIL: /implement skill missing key-vs-prefix mismatch check"; exit 1; }

# 4. /rkt-tailor offers repair when prefix has drifted.
grep -q "Repair issue prefix if it drifted" "$PLUGIN_DIR/skills/rkt-tailor/SKILL.md" \
  || { echo "FAIL: /rkt-tailor skill missing prefix-drift repair step"; exit 1; }

# 5. End-to-end render: TMPVARS.LINEAR_PREFIX flows into rkt.json.issue_prefix.
tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT

TMPVARS=$(mktemp)
cat > "$TMPVARS" <<'EOF'
{
  "PROJECT_NAME": "wdyd-platform",
  "PROJECT_NAME_PASCAL": "WdydPlatform",
  "PRESET": "web",
  "LINEAR_PREFIX": "RKT",
  "LINEAR_TEAM_ID": "team-uuid",
  "LINEAR_PROJECT_ID": "project-uuid",
  "LINEAR_PROJECT_URL": "https://linear.app/rocket/project/wdyd-uuid",
  "MEMPALACE_PREFIX": "wdyd",
  "GH_VISIBILITY": "skip",
  "DEPLOY_BACKEND": "null",
  "DEPLOY_WEB": "vercel",
  "DEPLOY_DB": "supabase",
  "DATE": "2026-05-08",
  "RKT_VERSION": "0.3.0"
}
EOF

"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/rkt.json.tmpl" "$tmpdir/rkt.json" "$(cat "$TMPVARS")"

actual_prefix=$(jq -r .linear.issue_prefix "$tmpdir/rkt.json")
[[ "$actual_prefix" == "RKT" ]] \
  || { echo "FAIL: rendered rkt.json prefix is '$actual_prefix', expected 'RKT'"; exit 1; }

# Also exercise the wdyd-platform regression specifically: project_name 'wdyd-platform'
# combined with LINEAR_PREFIX 'RKT' must not produce 'WDYD' anywhere in rkt.json.
if grep -q "WDYD" "$tmpdir/rkt.json"; then
  echo "FAIL: rendered rkt.json leaked 'WDYD' (project-name-derived prefix)"; exit 1
fi

# 6. CLAUDE.md template uses {{LINEAR_PREFIX}} for branch/PR examples (not a
# hardcoded prefix). When rendered with LINEAR_PREFIX=RKT, the examples must
# read 'RKT-' not 'WDYD-' or 'MNT-'.
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/CLAUDE.md.tmpl" "$tmpdir/CLAUDE.md" "$(cat "$TMPVARS")"

grep -q "RKT-<n>/<domain>" "$tmpdir/CLAUDE.md" \
  || { echo "FAIL: rendered CLAUDE.md missing 'RKT-<n>/<domain>' branch example"; exit 1; }
if grep -q "WDYD-" "$tmpdir/CLAUDE.md"; then
  echo "FAIL: rendered CLAUDE.md leaked 'WDYD-' example"; exit 1
fi

rm -f "$TMPVARS"
echo "PASS: test-prefix-from-team-key.sh"
