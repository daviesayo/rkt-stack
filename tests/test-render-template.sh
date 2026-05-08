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

# Test: JSON null / number / boolean / string preserve their types in JSON output
cat > "$tmpdir/types.tmpl" <<'EOF'
{
  "name": "{{NAME}}",
  "count": "{{COUNT}}",
  "active": "{{ACTIVE}}",
  "missing": "{{MISSING}}"
}
EOF
TYPED_VARS='{"NAME":"hello","COUNT":42,"ACTIVE":true,"MISSING":null}'
bash "$SCRIPT" "$tmpdir/types.tmpl" "$tmpdir/types.out" "$TYPED_VARS"

# Output must be valid JSON
jq empty "$tmpdir/types.out" 2>/dev/null || { echo "FAIL: typed render produced invalid JSON"; cat "$tmpdir/types.out"; exit 1; }

# Each value must have the right JSON type
[[ $(jq -r '.name | type' "$tmpdir/types.out") == "string" ]] || { echo "FAIL: name type"; exit 1; }
[[ $(jq -r '.count | type' "$tmpdir/types.out") == "number" ]] || { echo "FAIL: count type ($(jq -r '.count | type' "$tmpdir/types.out"))"; exit 1; }
[[ $(jq -r '.active | type' "$tmpdir/types.out") == "boolean" ]] || { echo "FAIL: active type"; exit 1; }
[[ $(jq -r '.missing | type' "$tmpdir/types.out") == "null" ]] || { echo "FAIL: missing type"; exit 1; }

# Values themselves must be correct
[[ $(jq -r '.name' "$tmpdir/types.out") == "hello" ]] || { echo "FAIL: name value"; exit 1; }
[[ $(jq -r '.count' "$tmpdir/types.out") == "42" ]] || { echo "FAIL: count value"; exit 1; }
[[ $(jq -r '.active' "$tmpdir/types.out") == "true" ]] || { echo "FAIL: active value"; exit 1; }
[[ $(jq -r '.missing' "$tmpdir/types.out") == "null" ]] || { echo "FAIL: missing value"; exit 1; }

echo "PASS: test-render-template.sh"
