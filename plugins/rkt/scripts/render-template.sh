#!/usr/bin/env bash
# scripts/render-template.sh <input.tmpl> <output> <vars-json>
# Substitutes {{KEY}} tokens in input template using vars-json mapping.
# Fails if any {{...}} tokens remain unresolved in the output.

set -euo pipefail

INPUT="$1"
OUTPUT="$2"
VARS_JSON="$3"

[[ -f "$INPUT" ]] || { echo "Error: template $INPUT not found" >&2; exit 1; }

# Start with template content
cp "$INPUT" "$OUTPUT"

# Substitute each key using a temp file approach to avoid sed special-char issues
tmpfile=$(mktemp)
trap "rm -f $tmpfile" EXIT

while IFS= read -r line; do
  key=$(echo "$line" | jq -r '.key')
  type=$(echo "$line" | jq -r '.value | type')

  if [[ "$type" == "string" ]]; then
    # Strings keep the template's surrounding quotes (if any)
    value=$(echo "$line" | jq -r '.value')
    awk -v k="{{$key}}" -v v="$value" '{ gsub(k, v); print }' "$OUTPUT" > "$tmpfile"
    mv "$tmpfile" "$OUTPUT"
  else
    # null / number / boolean: emit as JSON literal, consuming surrounding quotes
    # in JSON contexts (e.g. "{{KEY}}" → null) and replacing bare {{KEY}} elsewhere.
    value=$(echo "$line" | jq -c '.value')
    awk -v k="\"{{$key}}\"" -v v="$value" '{ gsub(k, v); print }' "$OUTPUT" > "$tmpfile"
    mv "$tmpfile" "$OUTPUT"
    awk -v k="{{$key}}" -v v="$value" '{ gsub(k, v); print }' "$OUTPUT" > "$tmpfile"
    mv "$tmpfile" "$OUTPUT"
  fi
done < <(echo "$VARS_JSON" | jq -c 'to_entries[]')

# Check for unreplaced tokens
if grep -qE '\{\{[A-Z_]+\}\}' "$OUTPUT"; then
  unresolved=$(grep -oE '\{\{[A-Z_]+\}\}' "$OUTPUT" | sort -u | tr '\n' ' ')
  echo "Error: unresolved tokens in output: $unresolved" >&2
  exit 1
fi
