#!/usr/bin/env bash
# scripts/lib/common.sh — shared helpers for rkt scripts

# derive_prefix <kebab-case-name> → uppercase initials of each word
# my-new-thing → MNT
# witness → WIT (first 3 chars if single word)
derive_prefix() {
  local name="$1"
  local parts
  IFS='-' read -ra parts <<< "$name"

  if [[ ${#parts[@]} -eq 1 ]]; then
    # Single word: first 3 chars uppercased
    echo "${name:0:3}" | tr '[:lower:]' '[:upper:]'
  else
    # Multiple words: first letter of each, uppercased
    local prefix=""
    for part in "${parts[@]}"; do
      prefix="${prefix}${part:0:1}"
    done
    echo "$prefix" | tr '[:lower:]' '[:upper:]'
  fi
}

# slugify <any string> → kebab-case slug
slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# json_get <file> <jq-path> → value at path, exits 1 if missing
json_get() {
  local file="$1"
  local path="$2"
  local value
  value=$(jq -r "$path // empty" "$file")
  [[ -z "$value" ]] && { echo "json_get: missing value at $path in $file" >&2; return 1; }
  echo "$value"
}

# fail <message> — print to stderr and exit 1
fail() {
  echo "Error: $1" >&2
  exit 1
}
