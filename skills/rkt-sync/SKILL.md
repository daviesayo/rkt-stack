---
name: rkt-sync
description: Use to sync project-owned templates (AGENTS.md, rules, PROGRESS.md etc.) with the latest rkt plugin version after a /plugin update. Triggers on "sync templates", "rkt sync", "update AGENTS.md", "pick up new rkt changes", "refresh my rules".
---

# rkt-sync

You update **plugin-managed** project files to match the currently-installed
rkt plugin version, preserving **project-owned** files and user-edited sections.

## What sync touches vs. never touches

**Plugin-managed (may be updated by sync, with user confirmation):**
- `AGENTS.md`
- `PROGRESS.md`, `OPS.md`, `README.md`
- `.claude/rules/backend-fastapi.md`, `supabase.md`, `web-vite.md`, `web-nextjs.md`, `ios-design.md` (only the rules shipped by the plugin and applicable to the project's preset)
- `rkt.json` (version field only — user-customized fields are preserved)

**Project-owned (NEVER touched by sync):**
- `.claude/rules/project-*.md` — written by `/rkt-tailor`; must never be overwritten
- `agents/*.project.md` — project-level agent overlays; must never be overwritten
- `decisions.md` — append-only; sync only creates if absent
- `docs/decisions/agent_learnings.md` — append-only; sync only creates if absent

**Sentinel-marked sections within plugin-managed files:** any content outside
`<!-- rkt-managed:start -->` … `<!-- rkt-managed:end -->` markers is treated as
user territory. Sync only replaces content inside these blocks when it differs
from the current template output.

You present diffs and let the user accept, reject, or merge on a per-file basis
via `AskUserQuestion`.

## Step 1: Verify project is bootstrapped

```bash
[[ -f rkt.json ]] || {
  echo "No rkt.json found. If this is a new project, run /bootstrap first."
  exit 1
}

PROJECT_VERSION=$(jq -r .bootstrap.rkt_plugin_version rkt.json)
CURRENT_VERSION=$(jq -r .version "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json")

echo "Project bootstrapped with rkt $PROJECT_VERSION"
echo "Currently installed: rkt $CURRENT_VERSION"
```

If `PROJECT_VERSION == CURRENT_VERSION` → tell the user:

> Already up to date — your project is pinned to rkt **{{CURRENT_VERSION}}**, which matches the installed version. Nothing to sync.

Then exit.

## Step 2: Show CHANGELOG between versions

If the plugin ships a CHANGELOG.md, surface the relevant entries:

```bash
CHANGELOG="${CLAUDE_PLUGIN_ROOT}/CHANGELOG.md"
if [[ -f "$CHANGELOG" ]]; then
  echo "## Changes since $PROJECT_VERSION"
  # Print lines between current version heading and project version heading
  awk "/^## $CURRENT_VERSION\$/,/^## $PROJECT_VERSION\$/" "$CHANGELOG" \
    | grep -v "^## $PROJECT_VERSION$" || true
fi
```

Present this to the user before any file changes so they know what's coming.

## Step 3: Load project config into TMPVARS

Same token structure as bootstrap, populated from the existing `rkt.json`:

```bash
TMPVARS=$(mktemp)
jq '{
  PROJECT_NAME: .project_name,
  PROJECT_NAME_PASCAL: (.project_name | split("-") | map(. | sub("^."; (.[:1] | ascii_upcase))) | join("")),
  PRESET: .preset,
  LINEAR_PREFIX: .linear.issue_prefix,
  LINEAR_PROJECT_ID: .linear.project_id,
  LINEAR_PROJECT_URL: .linear.project_url,
  LINEAR_TEAM_ID: .linear.team_id,
  MEMPALACE_PREFIX: .mempalace.specialist_prefix,
  DEPLOY_BACKEND: .deploy.backend,
  DEPLOY_WEB: (.deploy.web // "null"),
  DEPLOY_DB: .deploy.db,
  DATE: .bootstrap.date,
  RKT_VERSION: "'"$CURRENT_VERSION"'"
}' rkt.json > "$TMPVARS"
```

## Step 4: Per-file diff and resolve

For each plugin-managed template file, render the current template and compare
to the project copy. Never process `.claude/rules/project-*.md` or
`agents/*.project.md` — skip those unconditionally.

```bash
UPDATED=()
KEPT=()
CREATED=()
SKIPPED_PROJECT_OWNED=()

process_file() {
  local tmpl_name="$1"   # e.g. "AGENTS.md"
  local target="$2"       # e.g. "AGENTS.md" or "docs/decisions/agent_learnings.md"
  local append_only="${3:-false}"

  # Safety guard: never touch project-owned overlays
  if [[ "$target" == .claude/rules/project-*.md ]] || \
     [[ "$target" == agents/*.project.md ]]; then
    SKIPPED_PROJECT_OWNED+=("$target")
    return
  fi

  local rendered
  rendered=$(mktemp)
  "${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" \
    "${CLAUDE_PLUGIN_ROOT}/templates/${tmpl_name}.tmpl" "$rendered" "$(cat "$TMPVARS")"

  if [[ ! -e "$target" ]]; then
    # File absent — create it
    mkdir -p "$(dirname "$target")"
    cp "$rendered" "$target"
    CREATED+=("$target")
    rm -f "$rendered"
    return
  fi

  if [[ "$append_only" == "true" ]]; then
    # Append-only files: never overwrite existing content
    rm -f "$rendered"
    return
  fi

  if diff -q "$rendered" "$target" >/dev/null 2>&1; then
    # Already up to date
    rm -f "$rendered"
    return
  fi

  # Conflict — show diff, ask user
  echo ""
  echo "=== Diff for $target ==="
  diff -u "$target" "$rendered" | head -60 || true
  echo ""

  # AskUserQuestion: present options
  # [Accept update]    → cp "$rendered" "$target"
  # [Keep mine]        → keep existing, no change
  # [Show 3-way merge] → git merge-file or open in EDITOR

  rm -f "$rendered"
}

# Process global template files
process_file "AGENTS.md"    "AGENTS.md"
process_file "PROGRESS.md"  "PROGRESS.md"
process_file "OPS.md"       "OPS.md"
process_file "README.md"    "README.md"

# decisions.md and agent_learnings.md are append-only
process_file "decisions.md"        "decisions.md"                         "true"
process_file "agent_learnings.md"  "docs/decisions/agent_learnings.md"    "true"
```

### Sentinel block handling

For plugin-managed files that contain sentinel markers, only replace content
within `<!-- rkt-managed:start -->` … `<!-- rkt-managed:end -->` blocks.
Content outside these markers is treated as user-edited and left untouched.
This applies when a file exists with mixed managed/user content.

## Step 5: Per-rule diff and resolve

Determine which rules apply to the project's preset, then sync only those.
**Never process `.claude/rules/project-*.md`** — those are project-owned.

```bash
PRESET=$(jq -r .preset rkt.json)

# Map presets to rule files they use
declare -A PRESET_RULES
PRESET_RULES["backend"]="backend-fastapi.md supabase.md"
PRESET_RULES["web"]="web-vite.md"
PRESET_RULES["web-next"]="web-nextjs.md"
PRESET_RULES["ios"]="ios-design.md"
PRESET_RULES["fullstack"]="backend-fastapi.md supabase.md web-vite.md"
PRESET_RULES["fullstack-next"]="backend-fastapi.md supabase.md web-nextjs.md"

APPLICABLE_RULES="${PRESET_RULES[$PRESET]:-}"

for rule_file in $APPLICABLE_RULES; do
  local target=".claude/rules/$rule_file"

  # Explicit guard: skip any project-owned rule
  if [[ "$rule_file" == project-*.md ]]; then
    SKIPPED_PROJECT_OWNED+=("$target")
    continue
  fi

  local plugin_source="${CLAUDE_PLUGIN_ROOT}/rules/$rule_file"
  [[ -f "$plugin_source" ]] || continue

  if [[ ! -e "$target" ]]; then
    mkdir -p ".claude/rules"
    cp "$plugin_source" "$target"
    CREATED+=("$target")
    continue
  fi

  if diff -q "$plugin_source" "$target" >/dev/null 2>&1; then
    continue
  fi

  echo ""
  echo "=== Diff for $target ==="
  diff -u "$target" "$plugin_source" | head -60 || true
  echo ""

  # AskUserQuestion: [Accept update], [Keep mine], [Show 3-way merge]
done

# Explicitly skip any project-owned rules discovered in .claude/rules/
for project_rule in .claude/rules/project-*.md; do
  [[ -e "$project_rule" ]] && SKIPPED_PROJECT_OWNED+=("$project_rule")
done

# Explicitly skip any project-owned agent overlays
for project_agent in agents/*.project.md; do
  [[ -e "$project_agent" ]] && SKIPPED_PROJECT_OWNED+=("$project_agent")
done
```

## Step 6: Update rkt_plugin_version in rkt.json

```bash
jq --arg v "$CURRENT_VERSION" '.bootstrap.rkt_plugin_version = $v' rkt.json > rkt.json.new
mv rkt.json.new rkt.json
echo "Updated rkt.json → rkt_plugin_version = $CURRENT_VERSION"
```

## Step 7: Commit (optional)

Use `AskUserQuestion`:

- "Commit the synced templates?"
- Options: `[Yes, commit]`, `[Leave uncommitted for review]`

If yes:

```bash
git add AGENTS.md PROGRESS.md OPS.md README.md rkt.json decisions.md \
        docs/decisions/agent_learnings.md .claude/rules/
# Stage only plugin-managed rules — never stage project-*.md
git reset HEAD .claude/rules/project-*.md 2>/dev/null || true
git reset HEAD agents/*.project.md 2>/dev/null || true
git commit -m "[rkt-sync] Update templates to rkt $CURRENT_VERSION"
```

## Step 8: Report

Summarise what happened:

```markdown
## Synced to rkt {{CURRENT_VERSION}}

- **Created:** {{CREATED_LIST or "none"}}
- **Updated:** {{UPDATED_LIST or "none"}}
- **Kept (user chose):** {{KEPT_LIST or "none"}}
- **Unchanged:** {{UNCHANGED_LIST or "none"}}
- **Skipped (project-owned, never touched):** {{SKIPPED_LIST or "none"}}
- **Committed:** yes / no
```
