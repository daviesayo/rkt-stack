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

# require_linear — guard for skills that depend on a linked Linear project.
# Reads rkt.json in the current working directory and verifies linear.project_id
# is set. Prints an actionable error and returns 1 if not. Returns 0 on success.
#
# Bootstrap explicitly supports a "Skip Linear" path that leaves project_id
# empty; without this guard, dependent skills (implement, create-issue, scan)
# pass --project-id "" to the linear CLI and either error opaquely or silently
# operate on the wrong scope.
require_linear() {
  if [[ ! -f "rkt.json" ]]; then
    cat >&2 <<EOF
Error: rkt.json not found in $(pwd).

This skill must run from the root of an rkt-bootstrapped project.
If this is a new project, run /rkt:bootstrap first.
EOF
    return 1
  fi

  local project_id
  project_id=$(jq -r '.linear.project_id // ""' rkt.json 2>/dev/null)

  if [[ -z "$project_id" || "$project_id" == "null" ]]; then
    cat >&2 <<EOF
Error: Linear is not configured for this project.

This skill needs a linked Linear project. Either:
  - Run /rkt:bootstrap and pick [Link existing] or [Create new] when prompted
  - Or edit rkt.json to set linear.project_id and linear.project_url

EOF
    return 1
  fi
}

# ensure_out_of_worktrees — if pwd is inside .worktrees/, cd to the main repo.
# Protects cleanup scripts from deleting the directory the caller is standing in.
ensure_out_of_worktrees() {
  local current="$(pwd)"
  if [[ "$current" == *"/.worktrees/"* ]]; then
    local main_worktree
    main_worktree=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree / { print $2; exit }')
    if [[ -z "$main_worktree" ]]; then
      fail "cwd is inside .worktrees/ but can't find the main worktree. cd to your repo root and retry."
    fi
    echo "[guard] cwd was inside a worktree — moving to main repo: $main_worktree"
    cd "$main_worktree"
  fi
}

# sync_main_with_origin — push local commits up, pull remote commits down.
# Exits non-zero and WARNS (not fails) if either step fails non-silently, so
# callers can decide. If no origin remote is set, returns 0 silently.
sync_main_with_origin() {
  git remote get-url origin >/dev/null 2>&1 || return 0

  echo "Syncing main with origin..."
  local push_out
  push_out=$(git push origin main 2>&1) || {
    echo "⚠️  WARNING: git push origin main failed:" >&2
    echo "$push_out" | sed 's/^/    /' >&2
    echo "⚠️  You may have unpushed commits that don't fast-forward, or push auth issues." >&2
    echo "⚠️  If you proceed, any unpushed commits will appear in this feature's PR." >&2
    return 1
  }

  local pull_out
  pull_out=$(git pull origin main --ff-only 2>&1) || {
    echo "⚠️  WARNING: git pull origin main --ff-only failed:" >&2
    echo "$pull_out" | sed 's/^/    /' >&2
    return 1
  }

  return 0
}
