#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/render-template.sh"

tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT

# Create a template file with tokens
cat > "$tmpdir/input.tmpl" <<'EOF'
Project: {{PROJECT_NAME}}
Prefix: {{LINEAR_PREFIX}}
MemPalace: {{MEMPALACE_PREFIX}}-architect
Preset: {{PRESET}}
EOF

# Render with variables
VARS_JSON='{"PROJECT_NAME":"my-app","LINEAR_PREFIX":"MA","MEMPALACE_PREFIX":"my-app","PRESET":"full"}'
bash "$SCRIPT" "$tmpdir/input.tmpl" "$tmpdir/output.txt" "$VARS_JSON"

# Verify output
actual=$(cat "$tmpdir/output.txt")
expected="Project: my-app
Prefix: MA
MemPalace: my-app-architect
Preset: full"

[[ "$actual" == "$expected" ]] || { echo "FAIL: render mismatch"; echo "Got:"; echo "$actual"; echo "Expected:"; echo "$expected"; exit 1; }

# Test: unreplaced token triggers error
cat > "$tmpdir/bad.tmpl" <<'EOF'
{{MISSING_VAR}}
EOF
set +e
bash "$SCRIPT" "$tmpdir/bad.tmpl" "$tmpdir/bad.out" "$VARS_JSON" 2>/dev/null
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: should error on unreplaced token"; exit 1; }

echo "PASS: test-render-template.sh"
