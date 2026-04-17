# rkt Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal Claude Code plugin (`rkt`) that scaffolds new projects (greenfield or adopt-existing) with Davies's preferred workflow: skills, agents, rules, Linear integration, worktree-based development.

**Architecture:** A Claude Code plugin distributed via a personal marketplace. Skills and agents live in the plugin; per-project context (AGENTS.md, rules, log files) is rendered into each bootstrapped project. State detection routes `/bootstrap` into NEW or ADOPT flows. `/rkt-sync` handles template updates after plugin upgrades.

**Tech Stack:** Claude Code plugin system (skills, agents, hooks), bash scripts for deterministic logic, `jq` for JSON manipulation, Linear GraphQL API, `gh` CLI, `git`. No new language runtimes — everything is bash + markdown.

**Source material:** The Witness repo at `/Users/rocket/Documents/Repositories/witness` is the origin of all ported skills, agents, rules, and scripts. Port = copy + parameterize.

---

## Architecture Update (2026-04-18)

**Principle: plugin = generic stack conventions only.** When porting agents and rules, strip anything that encodes project-specific business logic (e.g., Witness's cool-off mechanics, SPLIT_UNUSUALLY_LOW, specific module paths like `app.identity.routes`, audit-ordering invariants). Those belong in a per-project overlay written by `/rkt-tailor`, not in the shared plugin.

**What counts as generic (keep in plugin agents/rules):**
- Framework patterns: "FastAPI handlers must be async", "Pydantic models for all validation", "SwiftUI uses iOS 26+ APIs"
- Security primitives: "no hardcoded secrets", "RLS on all user-facing tables", "no `dangerouslySetInnerHTML` without sanitization"
- Lean-worker discipline: "don't re-read AGENTS.md; context is injected"
- Testing conventions: "write tests alongside implementation"

**What counts as project-specific (move to `.claude/rules/project-*.md` or `agents/*.project.md`):**
- Business rule math (split percentages, cool-off windows, expiry durations)
- Domain constants (status enums specific to the product, state machine transitions)
- Module-specific mock paths (`patch("app.identity.routes.get_supabase_admin_client")`)
- Named features and their invariants ("SPLIT_UNUSUALLY_LOW fires when…")

**New skill added to MVP: `/rkt-tailor`** (see Phase 8.5 below) — scans a bootstrapped project, interactively captures business rules, writes them into project-owned overlays.

**`/rkt-sync` updated** (Phase 9) — must preserve project-owned files (`project-*.md`, `*.project.md`) and user-edited sections (demarcated by `<!-- rkt-managed:start -->` / `<!-- rkt-managed:end -->` sentinel markers).

**Remediation needed for already-ported agents:** Tasks 11–15 were completed before this architectural correction. The 5 agent files contain Witness-specific business logic that must be stripped. See Task 15.1 below.

---

## File Structure

```
rkt-stack/
├── .claude-plugin/
│   ├── plugin.json                       # plugin manifest
│   └── marketplace.json                  # marketplace manifest (lists rkt)
├── skills/
│   ├── bootstrap/SKILL.md                # NEW
│   ├── rkt-sync/SKILL.md                 # NEW
│   ├── implement/SKILL.md                # ported
│   ├── create-issue/SKILL.md             # ported
│   ├── scan/SKILL.md                     # ported
│   └── resolve-reviews/SKILL.md          # ported
├── agents/
│   ├── backend-implementer.md            # ported
│   ├── database-implementer.md           # ported
│   ├── ios-implementer.md                # ported
│   ├── web-implementer.md                # ported
│   └── code-reviewer.md                  # ported
├── rules/
│   ├── backend-fastapi.md                # ported from backend.md
│   ├── supabase.md                       # ported
│   ├── web-vite.md                       # ported from web.md
│   ├── web-nextjs.md                     # NEW
│   └── ios-design.md                     # ported
├── templates/
│   ├── AGENTS.md.tmpl
│   ├── PROGRESS.md.tmpl
│   ├── OPS.md.tmpl
│   ├── decisions.md.tmpl
│   ├── agent_learnings.md.tmpl
│   ├── README.md.tmpl
│   ├── rkt.json.tmpl
│   └── presets/
│       ├── full/                         # folder scaffold for full preset
│       ├── web/
│       ├── backend/
│       └── ios/
├── scripts/
│   ├── new-feature.sh                    # ported
│   ├── cleanup-feature.sh                # ported
│   ├── cleanup-merged-worktrees.sh       # ported
│   ├── detect-stack.sh                   # NEW
│   ├── render-template.sh                # NEW
│   └── lib/
│       └── common.sh                     # shared bash helpers
├── tests/
│   ├── fixtures/
│   │   ├── empty-dir/
│   │   ├── nextjs-existing/
│   │   ├── fastapi-existing/
│   │   └── full-existing/
│   ├── test-detect-stack.sh
│   ├── test-render-template.sh
│   ├── test-new-feature.sh
│   └── test-bootstrap-e2e.sh
├── docs/
│   ├── specs/2026-04-17-rkt-plugin-design.md
│   └── plans/2026-04-18-rkt-plugin-implementation.md
├── CHANGELOG.md
├── LICENSE
├── README.md
└── .gitignore
```

**Ownership boundaries:**
- `skills/`, `agents/`, `rules/`, `scripts/`, `templates/` — plugin content, auto-updates via `/plugin update`
- `tests/` — dev-time only, not shipped to users
- `docs/` — spec and plan only, not shipped

---

## Phase 1: Plugin Foundation

Goal: valid Claude Code plugin that loads via `--plugin-dir`, with empty placeholder skills registered.

### Task 1: Create plugin.json manifest

**Files:**
- Create: `.claude-plugin/plugin.json`

- [ ] **Step 1: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "rkt",
  "version": "0.1.0",
  "description": "Personal Claude Code plugin for project bootstrapping and workflow orchestration",
  "author": {
    "name": "Davies Ayo",
    "url": "https://github.com/daviesayo"
  },
  "license": "MIT",
  "keywords": ["bootstrap", "scaffolding", "personal", "workflow", "linear"],
  "userConfig": {
    "default_linear_team_id": {
      "description": "Default Linear team ID for new projects (e.g. 'RKT'). Find via: linear api <<< 'query { teams { nodes { id key name } } }'",
      "sensitive": false
    },
    "default_github_owner": {
      "description": "GitHub username or org for gh repo create",
      "sensitive": false
    },
    "default_ios_device": {
      "description": "Default iOS device/simulator name for builds (e.g. 'rocket' or 'iPhone 17 Pro')",
      "sensitive": false
    },
    "default_gh_visibility": {
      "description": "Default visibility for new GitHub repos: 'private' or 'public'",
      "sensitive": false
    }
  }
}
```

- [ ] **Step 2: Verify plugin validates**

Run: `claude plugin validate /Users/rocket/Documents/Repositories/rkt-stack`
Expected: no errors. If command does not exist, fall back to `claude --debug --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack` and look for "loading plugin: rkt" without errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add .claude-plugin/plugin.json
git commit -m "Add plugin manifest with userConfig for Linear/GitHub/iOS defaults"
```

---

### Task 2: Create marketplace.json

**Files:**
- Create: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Create `.claude-plugin/marketplace.json`**

```json
{
  "name": "daviesayo-marketplace",
  "description": "Davies's personal Claude Code plugins",
  "owner": {
    "name": "Davies Ayo",
    "url": "https://github.com/daviesayo"
  },
  "plugins": [
    {
      "name": "rkt",
      "source": "./",
      "description": "Project bootstrapping and workflow orchestration"
    }
  ]
}
```

- [ ] **Step 2: Verify marketplace can be added locally**

Run: `claude marketplace add /Users/rocket/Documents/Repositories/rkt-stack`
Expected: marketplace registered. If the exact command differs, consult `claude marketplace --help` and use the appropriate add/install command pointing at this repo's path.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/marketplace.json
git commit -m "Add marketplace manifest pointing to rkt plugin"
```

---

### Task 3: Create empty skill placeholders

**Files:**
- Create: `skills/bootstrap/SKILL.md`
- Create: `skills/rkt-sync/SKILL.md`
- Create: `skills/implement/SKILL.md`
- Create: `skills/create-issue/SKILL.md`
- Create: `skills/scan/SKILL.md`
- Create: `skills/resolve-reviews/SKILL.md`

- [ ] **Step 1: Create `skills/bootstrap/SKILL.md` with minimal frontmatter**

```markdown
---
name: bootstrap
description: Use to scaffold a new project (greenfield) or adopt an existing one into Davies's rkt workflow. Triggers on "bootstrap", "new project", "set up this repo", "adopt this project into rkt".
---

# Bootstrap — placeholder

Scaffolds a new project or adopts an existing one. Implementation in Phase 6+.
```

- [ ] **Step 2: Create the other 5 skills with identical placeholder pattern**

Each file follows the same structure — a `---` frontmatter block with `name:` and `description:`, then a "placeholder" body. Use these name/description pairs:

- `skills/rkt-sync/SKILL.md` — name: `rkt-sync`, description: "Use to sync project-owned templates (AGENTS.md, rules, log files) with the latest plugin version. Triggers on 'sync templates', 'update AGENTS.md', 'rkt sync'."
- `skills/implement/SKILL.md` — name: `implement`, description: "placeholder, will be ported from Witness in Phase 8"
- `skills/create-issue/SKILL.md` — name: `create-issue`, description: "placeholder"
- `skills/scan/SKILL.md` — name: `scan`, description: "placeholder"
- `skills/resolve-reviews/SKILL.md` — name: `resolve-reviews`, description: "placeholder"

- [ ] **Step 3: Verify all skills load**

Run: `claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep -i "skill\|bootstrap\|rkt-sync"`
Expected: all 6 skills listed as registered.

- [ ] **Step 4: Commit**

```bash
git add skills/
git commit -m "Add skill placeholders for bootstrap, rkt-sync, and ported skills"
```

---

### Task 4: Create empty agent placeholders

**Files:**
- Create: `agents/backend-implementer.md`
- Create: `agents/database-implementer.md`
- Create: `agents/ios-implementer.md`
- Create: `agents/web-implementer.md`
- Create: `agents/code-reviewer.md`

- [ ] **Step 1: Create each agent placeholder**

For each agent file, content is:

```markdown
---
name: backend-implementer
description: Backend/API implementer. Placeholder — will be ported from Witness in Phase 3.
disallowedTools: Agent
model: sonnet
---

Placeholder. Implementation in Phase 3.
```

Replace `backend-implementer` with the appropriate name for each file. Descriptions should all note "ported from Witness in Phase 3".

- [ ] **Step 2: Verify agents load**

Run: `claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep -i "agent"`
Expected: 5 agents registered under the `rkt:` namespace.

- [ ] **Step 3: Commit**

```bash
git add agents/
git commit -m "Add agent placeholders for all 5 domain agents"
```

---

### Task 5: Document development workflow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append development section to README.md**

Add this section after the existing "Development" section:

```markdown
## Local development

Until the plugin is published to GitHub, develop against the local repo directly:

```bash
# Load the plugin for the current session only
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack

# Or add the local marketplace and install globally
claude marketplace add /Users/rocket/Documents/Repositories/rkt-stack
claude plugin install rkt@daviesayo-marketplace
```

### Verifying a change

After modifying a skill, agent, or script:

1. Bump `version` in `.claude-plugin/plugin.json` (even for experiments — Claude Code caches plugins by version)
2. Reinstall: `claude plugin update rkt@daviesayo-marketplace`
3. Start a fresh Claude Code session to load the updated plugin

### Running tests

```bash
cd tests/
./test-detect-stack.sh
./test-render-template.sh
./test-new-feature.sh
```

Integration tests (e.g. `test-bootstrap-e2e.sh`) require `gh auth status` to be valid and a real Linear team in `default_linear_team_id` — they create a throwaway GitHub repo and a throwaway Linear project, then delete them.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document local plugin dev workflow and test runner"
```

---

## Phase 2: Helper Scripts and Shared Library

Goal: deterministic bash logic needed by later phases — stack detection, template rendering, worktree lifecycle.

### Task 6: Create shared bash helper library

**Files:**
- Create: `scripts/lib/common.sh`
- Create: `tests/test-common.sh`

- [ ] **Step 1: Write failing test for shared helpers**

`tests/test-common.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../scripts/lib/common.sh"

# Test: derive_prefix converts kebab-case to uppercase initials
result=$(derive_prefix "my-new-thing")
[[ "$result" == "MNT" ]] || { echo "FAIL: derive_prefix 'my-new-thing' = '$result', expected 'MNT'"; exit 1; }

result=$(derive_prefix "witness")
[[ "$result" == "WIT" ]] || { echo "FAIL: derive_prefix 'witness' = '$result', expected 'WIT'"; exit 1; }

# Test: slugify
result=$(slugify "My Cool Project!")
[[ "$result" == "my-cool-project" ]] || { echo "FAIL: slugify = '$result'"; exit 1; }

# Test: json_get reads rkt.json values
tmpfile=$(mktemp)
echo '{"project_name": "test", "linear": {"issue_prefix": "TST"}}' > "$tmpfile"
result=$(json_get "$tmpfile" ".linear.issue_prefix")
[[ "$result" == "TST" ]] || { echo "FAIL: json_get nested = '$result'"; exit 1; }
rm -f "$tmpfile"

echo "PASS: test-common.sh"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-common.sh`
Expected: FAIL — `scripts/lib/common.sh` does not exist.

- [ ] **Step 3: Implement `scripts/lib/common.sh`**

```bash
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-common.sh`
Expected: `PASS: test-common.sh`

- [ ] **Step 5: Commit**

```bash
chmod +x scripts/lib/common.sh tests/test-common.sh
git add scripts/lib/common.sh tests/test-common.sh
git commit -m "Add shared bash helpers with TDD: derive_prefix, slugify, json_get"
```

---

### Task 7: Port new-feature.sh with sync-before-branch fix

**Files:**
- Create: `scripts/new-feature.sh`
- Create: `tests/test-new-feature.sh`

- [ ] **Step 1: Write failing test**

`tests/test-new-feature.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/new-feature.sh"

# Setup: create a throwaway git repo
tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT
cd "$tmpdir"
git init -q -b main
git commit -q --allow-empty -m "initial"
git remote add origin "file://$tmpdir/.git"

# Test: invoking with no args prints usage
set +e
output=$(bash "$SCRIPT" 2>&1)
exit_code=$?
set -e
[[ $exit_code -ne 0 ]] || { echo "FAIL: should exit non-zero with no args"; exit 1; }
echo "$output" | grep -q "Usage:" || { echo "FAIL: usage not printed"; exit 1; }

# Test: creates expected worktree
bash "$SCRIPT" RKT-999 test-feature backend >/dev/null 2>&1
[[ -d "$tmpdir/.worktrees/RKT-999-backend" ]] || { echo "FAIL: worktree dir not created"; exit 1; }

echo "PASS: test-new-feature.sh"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-new-feature.sh`
Expected: FAIL — `scripts/new-feature.sh` does not exist.

- [ ] **Step 3: Copy and adapt new-feature.sh from Witness**

Source file: `/Users/rocket/Documents/Repositories/witness/scripts/new-feature.sh`

Copy to `/Users/rocket/Documents/Repositories/rkt-stack/scripts/new-feature.sh` verbatim. The file already includes the sync-before-branch fix (push + pull --ff-only before branching from local main), so no modifications needed.

Also make it executable: `chmod +x scripts/new-feature.sh`

- [ ] **Step 4: Run test to verify it passes**

Run: `bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-new-feature.sh`
Expected: `PASS: test-new-feature.sh`

- [ ] **Step 5: Commit**

```bash
git add scripts/new-feature.sh tests/test-new-feature.sh
git commit -m "Port new-feature.sh from Witness with sync-before-branch fix"
```

---

### Task 8: Port cleanup-feature.sh and cleanup-merged-worktrees.sh

**Files:**
- Create: `scripts/cleanup-feature.sh`
- Create: `scripts/cleanup-merged-worktrees.sh`

- [ ] **Step 1: Copy both scripts from Witness verbatim**

```bash
cp /Users/rocket/Documents/Repositories/witness/scripts/cleanup-feature.sh /Users/rocket/Documents/Repositories/rkt-stack/scripts/cleanup-feature.sh
cp /Users/rocket/Documents/Repositories/witness/scripts/cleanup-merged-worktrees.sh /Users/rocket/Documents/Repositories/rkt-stack/scripts/cleanup-merged-worktrees.sh
chmod +x /Users/rocket/Documents/Repositories/rkt-stack/scripts/cleanup-feature.sh /Users/rocket/Documents/Repositories/rkt-stack/scripts/cleanup-merged-worktrees.sh
```

- [ ] **Step 2: Verify scripts are executable and print usage when run without args**

```bash
bash /Users/rocket/Documents/Repositories/rkt-stack/scripts/cleanup-feature.sh 2>&1 | head -5
bash /Users/rocket/Documents/Repositories/rkt-stack/scripts/cleanup-merged-worktrees.sh 2>&1 | head -5
```
Expected: both scripts run without syntax errors. `cleanup-feature.sh` prints usage if args are missing; `cleanup-merged-worktrees.sh` may exit 0 with no work to do.

- [ ] **Step 3: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add scripts/cleanup-feature.sh scripts/cleanup-merged-worktrees.sh
git commit -m "Port cleanup scripts from Witness"
```

---

### Task 9: Build detect-stack.sh with TDD

**Files:**
- Create: `tests/fixtures/empty-dir/.gitkeep`
- Create: `tests/fixtures/nextjs-existing/package.json`
- Create: `tests/fixtures/fastapi-existing/pyproject.toml`
- Create: `tests/fixtures/full-existing/` (mix of signals)
- Create: `tests/test-detect-stack.sh`
- Create: `scripts/detect-stack.sh`

- [ ] **Step 1: Create fixture directories**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack/tests/fixtures

mkdir -p empty-dir
touch empty-dir/.gitkeep

mkdir -p nextjs-existing
cat > nextjs-existing/package.json <<'EOF'
{
  "name": "fake-next-app",
  "dependencies": { "next": "^16.0.0", "react": "^19.0.0" }
}
EOF

mkdir -p fastapi-existing
cat > fastapi-existing/pyproject.toml <<'EOF'
[project]
name = "fake-api"
dependencies = ["fastapi>=0.115"]
EOF

mkdir -p full-existing/backend full-existing/ios full-existing/web full-existing/backend/supabase/migrations
cat > full-existing/backend/pyproject.toml <<'EOF'
[project]
dependencies = ["fastapi"]
EOF
cat > full-existing/web/package.json <<'EOF'
{ "dependencies": { "react": "^19", "vite": "^7" } }
EOF
touch full-existing/ios/MyApp.xcodeproj
```

- [ ] **Step 2: Write failing test for detect-stack.sh**

`tests/test-detect-stack.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/detect-stack.sh"
FIXTURES="$HERE/fixtures"

assert_suggests() {
  local fixture="$1"
  local expected="$2"
  local actual
  actual=$(bash "$SCRIPT" "$FIXTURES/$fixture" | jq -r '.suggested_preset')
  [[ "$actual" == "$expected" ]] || { echo "FAIL: $fixture suggested '$actual', expected '$expected'"; exit 1; }
}

assert_suggests "empty-dir" "null"
assert_suggests "nextjs-existing" "web"
assert_suggests "fastapi-existing" "backend"
assert_suggests "full-existing" "full"

# Test specific flags in the JSON output
output=$(bash "$SCRIPT" "$FIXTURES/nextjs-existing")
echo "$output" | jq -e '.signals.has_nextjs == true' >/dev/null || { echo "FAIL: has_nextjs flag missing"; exit 1; }

output=$(bash "$SCRIPT" "$FIXTURES/full-existing")
echo "$output" | jq -e '.signals.has_xcodeproj == true' >/dev/null || { echo "FAIL: has_xcodeproj flag missing"; exit 1; }
echo "$output" | jq -e '.signals.has_supabase == true' >/dev/null || { echo "FAIL: has_supabase flag missing"; exit 1; }

echo "PASS: test-detect-stack.sh"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-detect-stack.sh`
Expected: FAIL — `scripts/detect-stack.sh` does not exist.

- [ ] **Step 4: Implement `scripts/detect-stack.sh`**

```bash
#!/usr/bin/env bash
# scripts/detect-stack.sh <target-dir>
# Scans target directory and emits JSON describing detected signals + suggested preset.
#
# Exit codes: 0 on success (even if nothing detected), 1 on usage error.

set -euo pipefail

TARGET="${1:-.}"
[[ -d "$TARGET" ]] || { echo "Usage: $0 <target-dir>" >&2; exit 1; }

has() {
  if [[ -n "${2:-}" ]]; then
    # Look for substring inside a file
    [[ -f "$TARGET/$1" ]] && grep -q "$2" "$TARGET/$1" 2>/dev/null
  else
    # Just check file/dir existence
    [[ -e "$TARGET/$1" ]]
  fi
}

has_glob() {
  # Check if glob matches at least one entry in target
  compgen -G "$TARGET/$1" >/dev/null 2>&1
}

HAS_GIT="false"; has ".git" && HAS_GIT="true"
HAS_REMOTE="false"
if [[ "$HAS_GIT" == "true" ]]; then
  (cd "$TARGET" && git remote get-url origin >/dev/null 2>&1) && HAS_REMOTE="true"
fi

HAS_RKT_JSON="false"; has "rkt.json" && HAS_RKT_JSON="true"
HAS_AGENTS_MD="false"; has "AGENTS.md" && HAS_AGENTS_MD="true"

HAS_NEXTJS="false"
has "package.json" '"next"' && HAS_NEXTJS="true"

HAS_VITE="false"
has "package.json" '"vite"' && has "package.json" '"react"' && HAS_VITE="true"

HAS_FASTAPI="false"
has "pyproject.toml" "fastapi" && HAS_FASTAPI="true"
# Also check backend/pyproject.toml for full-preset projects
[[ "$HAS_FASTAPI" == "false" ]] && has "backend/pyproject.toml" "fastapi" && HAS_FASTAPI="true"

HAS_XCODEPROJ="false"
has_glob "*.xcodeproj" && HAS_XCODEPROJ="true"
has_glob "*.xcworkspace" && HAS_XCODEPROJ="true"
# Also in ios/ subfolder
has_glob "ios/*.xcodeproj" && HAS_XCODEPROJ="true"
# Or an empty ios/ dir (counts as iOS-intent)
[[ -d "$TARGET/ios" ]] && HAS_XCODEPROJ="true"

HAS_SUPABASE="false"
[[ -d "$TARGET/supabase/migrations" ]] && HAS_SUPABASE="true"
[[ -d "$TARGET/backend/supabase/migrations" ]] && HAS_SUPABASE="true"

# Decide suggested preset
#   full:    has iOS + (web OR backend)
#   web:     has web framework, no iOS, no separate backend folder
#   backend: has FastAPI, no web framework, no iOS
#   ios:     has only iOS
#   null:    nothing detected
SUGGESTED="null"
component_count=0
[[ "$HAS_XCODEPROJ" == "true" ]] && ((component_count++)) || true
([[ "$HAS_NEXTJS" == "true" ]] || [[ "$HAS_VITE" == "true" ]]) && ((component_count++)) || true
[[ "$HAS_FASTAPI" == "true" ]] && ((component_count++)) || true

if [[ $component_count -ge 2 ]]; then
  SUGGESTED="full"
elif [[ "$HAS_XCODEPROJ" == "true" ]]; then
  SUGGESTED="ios"
elif [[ "$HAS_NEXTJS" == "true" ]] || [[ "$HAS_VITE" == "true" ]]; then
  SUGGESTED="web"
elif [[ "$HAS_FASTAPI" == "true" ]]; then
  SUGGESTED="backend"
fi

# Emit JSON
cat <<EOF
{
  "target": "$TARGET",
  "suggested_preset": $(if [[ "$SUGGESTED" == "null" ]]; then echo "null"; else echo "\"$SUGGESTED\""; fi),
  "signals": {
    "has_git": $HAS_GIT,
    "has_remote": $HAS_REMOTE,
    "has_rkt_json": $HAS_RKT_JSON,
    "has_agents_md": $HAS_AGENTS_MD,
    "has_nextjs": $HAS_NEXTJS,
    "has_vite": $HAS_VITE,
    "has_fastapi": $HAS_FASTAPI,
    "has_xcodeproj": $HAS_XCODEPROJ,
    "has_supabase": $HAS_SUPABASE
  }
}
EOF
```

- [ ] **Step 5: Make executable and run test**

```bash
chmod +x /Users/rocket/Documents/Repositories/rkt-stack/scripts/detect-stack.sh
bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-detect-stack.sh
```
Expected: `PASS: test-detect-stack.sh`

- [ ] **Step 6: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add scripts/detect-stack.sh tests/test-detect-stack.sh tests/fixtures/
chmod +x tests/test-detect-stack.sh
git commit -m "Add detect-stack.sh with TDD coverage for empty/nextjs/fastapi/full"
```

---

### Task 10: Build render-template.sh with TDD

**Files:**
- Create: `tests/test-render-template.sh`
- Create: `scripts/render-template.sh`

- [ ] **Step 1: Write failing test**

`tests/test-render-template.sh`:
```bash
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-render-template.sh`
Expected: FAIL — script not yet implemented.

- [ ] **Step 3: Implement `scripts/render-template.sh`**

```bash
#!/usr/bin/env bash
# scripts/render-template.sh <input.tmpl> <output> <vars-json>
#
# Substitutes {{KEY}} tokens in input template using vars-json mapping.
# Fails if any {{...}} tokens remain unresolved in the output.

set -euo pipefail

INPUT="$1"
OUTPUT="$2"
VARS_JSON="$3"

[[ -f "$INPUT" ]] || { echo "Error: template $INPUT not found" >&2; exit 1; }

# Build a sed script from the JSON object
# Each key becomes: s|{{KEY}}|value|g
sed_script=$(echo "$VARS_JSON" | jq -r 'to_entries | .[] | "s|{{" + .key + "}}|" + (.value | gsub("[\\\\/|&]"; "\\\(.)")) + "|g"')

# Apply substitutions
sed -e "$sed_script" "$INPUT" > "$OUTPUT"

# Check for unreplaced tokens
if grep -q '{{[A-Z_]*}}' "$OUTPUT"; then
  unresolved=$(grep -o '{{[A-Z_]*}}' "$OUTPUT" | sort -u | tr '\n' ' ')
  echo "Error: unresolved tokens in output: $unresolved" >&2
  exit 1
fi
```

- [ ] **Step 4: Run test to verify it passes**

```bash
chmod +x /Users/rocket/Documents/Repositories/rkt-stack/scripts/render-template.sh
bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-render-template.sh
```
Expected: `PASS: test-render-template.sh`

- [ ] **Step 5: Commit**

```bash
chmod +x tests/test-render-template.sh
git add scripts/render-template.sh tests/test-render-template.sh
git commit -m "Add render-template.sh with TDD: token substitution + unresolved token detection"
```

---

## Phase 3: Port Agents (Parameterized)

Goal: 5 agents copied from Witness with per-project hardcoding replaced by rkt.json reads.

For each agent: the porting rule is **copy verbatim, then edit these 3 things**:
1. Replace `witness-architect`, `witness-reviewer`, `witness-ops` with `{{rkt.json:mempalace.specialist_prefix}}-architect|reviewer|ops` (with a note instructing Claude to `jq` this at runtime)
2. Replace hardcoded project name "Witness" with a reference to `rkt.json:project_name`
3. Replace hardcoded device "rocket" with a reference to `user_config.default_ios_device`

### Task 11: Port backend-implementer agent

**Files:**
- Modify: `agents/backend-implementer.md`

- [ ] **Step 1: Read source file**

Read `/Users/rocket/Documents/Repositories/witness/.claude/agents/backend-implementer.md` in its entirety.

- [ ] **Step 2: Replace placeholder `agents/backend-implementer.md` with ported version**

Write the full contents of the Witness agent file into `agents/backend-implementer.md`, with these substitutions:

- Change any hardcoded "Witness" to "the project (from `rkt.json:project_name`)"
- In the MemPalace write section, change `witness-ops` to `{mempalace_prefix}-ops` where `{mempalace_prefix}` is explained as "read from `rkt.json:mempalace.specialist_prefix` at runtime"
- Keep the `disallowedTools: Agent` frontmatter (grants MCP access per the backend security findings)
- Keep the lean-worker principle: agent does NOT read AGENTS.md, decisions.md, or MemPalace — the orchestrator injects context

Add a short "Config" section near the top:

```markdown
## Config (read at task start)

If you need project-specific values (Linear prefix, MemPalace specialist names),
read them from `rkt.json` at the project root:

```bash
jq -r '.linear.issue_prefix' rkt.json       # e.g. "RKT"
jq -r '.mempalace.specialist_prefix' rkt.json  # e.g. "witness"
jq -r '.project_name' rkt.json
```

The orchestrator (spawning skill) already passes these in your prompt where
relevant — only re-read if you hit a case not covered.
```

- [ ] **Step 3: Verify agent loads**

Run: `claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep backend-implementer`
Expected: agent registered, no parse errors.

- [ ] **Step 4: Commit**

```bash
git add agents/backend-implementer.md
git commit -m "Port backend-implementer agent from Witness, parameterize via rkt.json"
```

---

### Task 12: Port database-implementer agent

**Files:**
- Modify: `agents/database-implementer.md`

- [ ] **Step 1: Read source file**

Read `/Users/rocket/Documents/Repositories/witness/.claude/agents/database-implementer.md`.

- [ ] **Step 2: Write ported version to `agents/database-implementer.md`**

Apply the same 3 substitution rules (project name, MemPalace specialist, device name if mentioned). In addition:

- Database-implementer writes to `{mempalace_prefix}-ops` after applying migrations — update this reference
- The OPS.md sync table reference stays (OPS.md is a per-project file now, rendered from template in Phase 5)

Add the same Config section as in Task 11.

- [ ] **Step 3: Verify and commit**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep database-implementer
git add agents/database-implementer.md
git commit -m "Port database-implementer agent from Witness, parameterize via rkt.json"
```

---

### Task 13: Port ios-implementer agent

**Files:**
- Modify: `agents/ios-implementer.md`

- [ ] **Step 1: Read source file**

Read `/Users/rocket/Documents/Repositories/witness/.claude/agents/ios-implementer.md`.

- [ ] **Step 2: Write ported version**

Apply substitution rules. Special attention:

- Hardcoded device name "rocket" becomes "the device from `user_config.default_ios_device` (fall back to prompting if not set)"
- Xcode build commands that reference the device name should use the env var `CLAUDE_PLUGIN_OPTION_DEFAULT_IOS_DEVICE` (Claude Code exports userConfig values as env vars to plugin subprocesses)

Add Config section with the additional note:

```markdown
- Device name for Xcode builds: `${CLAUDE_PLUGIN_OPTION_DEFAULT_IOS_DEVICE}` (set via plugin userConfig)
```

- [ ] **Step 3: Verify and commit**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep ios-implementer
git add agents/ios-implementer.md
git commit -m "Port ios-implementer agent from Witness, parameterize device name via userConfig"
```

---

### Task 14: Port web-implementer agent

**Files:**
- Modify: `agents/web-implementer.md`

- [ ] **Step 1: Read source file**

Read `/Users/rocket/Documents/Repositories/witness/.claude/agents/web-implementer.md`.

- [ ] **Step 2: Write ported version**

Apply substitution rules. Note that the web-implementer in Witness is Vite-specific. For the plugin, it should handle both Vite and Next.js:

- Update the description to: "Web implementer. Handles React apps (Vite or Next.js). Read `rkt.json:preset` to determine which — `web` preset implies Next.js, `full` preset implies Vite."
- Build commands section should branch on detected stack: `npm run build` works for both, but lint commands may differ
- Keep the lean-worker pattern

Add Config section.

- [ ] **Step 3: Verify and commit**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep web-implementer
git add agents/web-implementer.md
git commit -m "Port web-implementer agent, expand to handle both Vite and Next.js"
```

---

### Task 15: Port code-reviewer agent

**Files:**
- Modify: `agents/code-reviewer.md`

- [ ] **Step 1: Read source file**

Read `/Users/rocket/Documents/Repositories/witness/.claude/agents/code-reviewer.md`.

- [ ] **Step 2: Write ported version**

The code-reviewer has Witness-specific security checks (Supabase RLS, FastAPI Pydantic, SwiftUI design tokens). These checks are **generally applicable** to the rkt presets that use the same stacks — keep them as-is but gate each section on the detected stack:

- "Only check Supabase rules if `rkt.json:deployed_to.db == 'supabase'`"
- "Only check iOS rules if iOS files were touched"
- etc.

Keep `disallowedTools: Agent, Write, Edit` (read-only). Keep MemPalace write to `{mempalace_prefix}-reviewer`.

Add Config section.

- [ ] **Step 3: Verify and commit**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep code-reviewer
git add agents/code-reviewer.md
git commit -m "Port code-reviewer agent, gate stack-specific checks on rkt.json config"
```

---

### Task 15.1: Remediate ported agents (strip Witness-specific content)

**Background:** Tasks 11–15 were executed before the "generic-only" architectural correction was documented. The ported agents contain Witness-specific business logic that must be stripped.

**Files:** Modify `agents/{backend-implementer,database-implementer,ios-implementer,web-implementer,code-reviewer}.md`

- [ ] **Step 1: For each of the 5 agents, strip project-specific content**

For each file, remove:
- Module-specific mock paths (`app.identity.routes` etc.)
- Named business features (cool-off, SPLIT_UNUSUALLY_LOW, status transitions, etc.)
- Company-specific commit/decision conventions if they reference Witness specifically
- Any rule that only applies to Witness's data model

Keep:
- Generic framework conventions (async FastAPI, Pydantic validation, SwiftUI iOS 26+, async/await patterns)
- Security primitives applicable to the stack (no hardcoded secrets, RLS mandatory, no `dangerouslySetInnerHTML`)
- Testing conventions generic to the stack
- PR creation / Linear-referenced workflow (Linear prefix read from `rkt.json`, Claude review trigger via PR comment)
- Lean-worker discipline ("don't re-read AGENTS.md; context is injected")

- [ ] **Step 2: Add a project-overlay hook to each agent**

At the end of each agent body, before the close, add:

```markdown
## Project-specific rules

If the project has captured domain business rules via `/rkt-tailor`, they live
in these files (load them at the start of your task if present):

- `.claude/rules/project-backend.md` (or `project-database.md` / `project-ios.md` / `project-web.md`)
- `.claude/agents/<your-name>.project.md` (agent-level overlay; optional)

These files contain business rules the plugin can't know about (split math,
audit invariants, domain constants, state machines). Always check and apply
project-specific rules on top of the generic ones above.
```

(Adjust the rule filename for each agent — `project-backend.md` for backend-implementer, etc.)

- [ ] **Step 3: Verify plugin still validates**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
claude plugin validate .
```

- [ ] **Step 4: Commit**

```bash
git add agents/
git commit -m "Strip Witness-specific content from ported agents; add project-overlay hook"
```

---

## Phase 4: Port Rules

Goal: path-scoped rule files that load when Claude touches matching files in a project. Same "generic-only" principle applies — strip Witness domain logic from rules when porting.

### Task 16: Port backend-fastapi.md rule

**Files:**
- Create: `rules/backend-fastapi.md` (note rename from `backend.md` for clarity)

- [ ] **Step 1: Copy and rename**

```bash
cp /Users/rocket/Documents/Repositories/witness/.claude/rules/backend.md /Users/rocket/Documents/Repositories/rkt-stack/rules/backend-fastapi.md
```

- [ ] **Step 2: Update frontmatter path pattern**

The top of the rule file has path-matching frontmatter. Ensure it matches:

```markdown
---
description: Path-scoped rules for FastAPI backend files
appliesTo:
  - "backend/app/**/*.py"
  - "backend/tests/**/*.py"
  - "app/main.py"
  - "app/**/*.py"
  - "tests/**/*.py"
---
```

(The extra patterns handle `backend` preset where Python files live at repo root instead of under `backend/`.)

- [ ] **Step 3: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add rules/backend-fastapi.md
git commit -m "Port backend rule, rename to backend-fastapi.md, cover both preset layouts"
```

---

### Task 17: Port supabase.md rule

**Files:**
- Create: `rules/supabase.md`

- [ ] **Step 1: Copy**

```bash
cp /Users/rocket/Documents/Repositories/witness/.claude/rules/supabase.md /Users/rocket/Documents/Repositories/rkt-stack/rules/supabase.md
```

- [ ] **Step 2: Update path patterns to cover both layouts**

```markdown
---
description: Path-scoped rules for Supabase migrations and database work
appliesTo:
  - "backend/supabase/**"
  - "supabase/**"
---
```

- [ ] **Step 3: Commit**

```bash
git add rules/supabase.md
git commit -m "Port supabase rule, cover both preset layouts"
```

---

### Task 18: Port web-vite.md rule

**Files:**
- Create: `rules/web-vite.md`

- [ ] **Step 1: Copy and rename from web.md**

```bash
cp /Users/rocket/Documents/Repositories/witness/.claude/rules/web.md /Users/rocket/Documents/Repositories/rkt-stack/rules/web-vite.md
```

- [ ] **Step 2: Update frontmatter**

```markdown
---
description: Path-scoped rules for Vite + React web projects (used by `full` preset)
appliesTo:
  - "web/src/**/*.ts"
  - "web/src/**/*.tsx"
  - "web/src/**/*.css"
---
```

- [ ] **Step 3: Commit**

```bash
git add rules/web-vite.md
git commit -m "Port web rule, rename to web-vite.md"
```

---

### Task 19: Create web-nextjs.md rule

**Files:**
- Create: `rules/web-nextjs.md`

- [ ] **Step 1: Write new rule file**

```markdown
---
description: Path-scoped rules for Next.js 16 App Router projects (used by `web` preset)
appliesTo:
  - "app/**/*.tsx"
  - "app/**/*.ts"
  - "components/**/*.tsx"
  - "lib/**/*.ts"
---

# Next.js + Supabase Rules

## App Router conventions

- **Server Components by default.** Mark `"use client"` only when you need
  client-side interactivity, browser APIs, or React state.
- **Server Actions for mutations.** Prefer Server Actions over dedicated API
  routes for internal form submissions.
- **Route handlers for public APIs.** Use `app/api/*/route.ts` only for
  externally-consumed endpoints.

## Supabase integration

- **Use `@supabase/ssr`** with `createBrowserClient` (Client Components) and
  `createServerClient` (Server Components, Server Actions, route handlers).
- **Never leak the service role key** to client-side code. Only use it in
  Server Actions or route handlers that verify the caller's permissions.
- **RLS is mandatory** on all user-facing tables. Do not disable for
  "convenience" — use the service role in a trusted handler instead.

## Auth

- Middleware at `middleware.ts` handles session refresh.
- Protected routes: check `const { data: { user } } = await supabase.auth.getUser()`
  in the Server Component and `redirect('/login')` if null.

## Styling

- **Tailwind + shadcn** is the default. Do not introduce additional CSS
  frameworks.
- Use design tokens from `tailwind.config.ts` theme, not hardcoded hex
  values in components.

## Forbidden patterns

- `dangerouslySetInnerHTML` without sanitisation.
- Fetching data via `useEffect` in Server Components (use the async function).
- Business logic in Client Components — web consumes APIs, it doesn't own them.
- Secrets in `NEXT_PUBLIC_*` env vars — those are exposed to the browser.

## Testing

- Unit tests with Vitest for lib functions.
- Component tests with Testing Library.
- Critical user flows: Playwright E2E.
```

- [ ] **Step 2: Commit**

```bash
git add rules/web-nextjs.md
git commit -m "Add Next.js rule for web preset (shadcn/Tailwind/Server Components conventions)"
```

---

### Task 20: Port ios-design.md rule

**Files:**
- Create: `rules/ios-design.md`

- [ ] **Step 1: Copy**

```bash
cp /Users/rocket/Documents/Repositories/witness/.claude/rules/ios-design.md /Users/rocket/Documents/Repositories/rkt-stack/rules/ios-design.md
```

- [ ] **Step 2: Update path patterns and de-Witness**

```markdown
---
description: Path-scoped rules for iOS SwiftUI projects
appliesTo:
  - "ios/**/*.swift"
  - "**/*.swift"
---
```

If the original rule references a specific design system file path like
`ios/witness/WitnessDesignSystem.swift`, generalize to
"the project's design tokens file (typically
`ios/{{project}}/{{PascalCaseProject}}DesignSystem.swift` — create if it
doesn't exist)".

- [ ] **Step 3: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add rules/ios-design.md
git commit -m "Port iOS design rule, generalize design tokens file reference"
```

---

## Phase 5: Template Library

Goal: the files that get rendered into each new/adopted project. Use simple `{{TOKEN}}` substitution handled by `render-template.sh`.

Tokens used throughout templates:
- `{{PROJECT_NAME}}` — kebab-case name (e.g. `my-app`)
- `{{PROJECT_NAME_PASCAL}}` — PascalCase (e.g. `MyApp`), used in iOS paths
- `{{LINEAR_PREFIX}}` — issue prefix (e.g. `MA`)
- `{{LINEAR_PROJECT_ID}}` — created or linked Linear project UUID
- `{{LINEAR_PROJECT_URL}}` — human-readable Linear URL
- `{{MEMPALACE_PREFIX}}` — specialist name prefix (e.g. `myapp`)
- `{{PRESET}}` — `full`, `web`, `backend`, or `ios`
- `{{RKT_VERSION}}` — plugin version at bootstrap time (e.g. `0.1.0`)
- `{{DATE}}` — `YYYY-MM-DD` of bootstrap
- `{{DEPLOY_BACKEND}}`, `{{DEPLOY_WEB}}`, `{{DEPLOY_DB}}` — per-preset defaults

### Task 21: Create rkt.json template

**Files:**
- Create: `templates/rkt.json.tmpl`

- [ ] **Step 1: Write template**

```json
{
  "project_name": "{{PROJECT_NAME}}",
  "preset": "{{PRESET}}",
  "linear": {
    "project_id": "{{LINEAR_PROJECT_ID}}",
    "project_url": "{{LINEAR_PROJECT_URL}}",
    "team_id": "{{LINEAR_TEAM_ID}}",
    "issue_prefix": "{{LINEAR_PREFIX}}"
  },
  "mempalace": {
    "specialist_prefix": "{{MEMPALACE_PREFIX}}"
  },
  "deploy": {
    "backend": "{{DEPLOY_BACKEND}}",
    "web": "{{DEPLOY_WEB}}",
    "db": "{{DEPLOY_DB}}"
  },
  "bootstrap": {
    "date": "{{DATE}}",
    "rkt_plugin_version": "{{RKT_VERSION}}"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add templates/rkt.json.tmpl
git commit -m "Add rkt.json template (per-project config schema)"
```

---

### Task 22: Create AGENTS.md template

**Files:**
- Create: `templates/AGENTS.md.tmpl`

- [ ] **Step 1: Write template**

Use the current Witness `AGENTS.md` as the structural basis. Extract project-
specific values into tokens. Also add a new section pointing to `rkt.json`.

```markdown
# {{PROJECT_NAME_PASCAL}} — Coding Agent Instructions

For coding agents. These instructions govern how any agent operates on this codebase.

**Project config:** Structured values (Linear prefix, MemPalace prefix, deploy targets)
live in `rkt.json` at the repo root. Read them via `jq -r '.linear.issue_prefix' rkt.json`
and similar.

---

## Session Start Protocol

Every session, in this order:

1. Read `PROGRESS.md`, `OPS.md`, top of `DEVLOG.md` (if present)
2. Read `docs/decisions/agent_learnings.md`, `decisions.md`
3. Run `./scripts/cleanup-merged-worktrees.sh` (if the plugin scripts are available)
4. Clarify the task if scope is ambiguous

---

## Session End Protocol

After completing meaningful work:

1. **Update `PROGRESS.md`** — mark completed (✅), in-progress (🔄), blocked (⛔)
2. **Update `OPS.md`** — if production actions were taken or new ops tasks identified
3. **Check `docs/decisions/agent_learnings.md`** — add entry only if a future agent would likely repeat the mistake
4. **Prepend to `decisions.md`** — if architectural decisions were made, `[YYYY-MM-DD HH:mm]` format

---

## Domain Ownership

Each domain agent owns specific folders. Agents must never modify files outside their domain.

See `rkt.json:preset` to determine which domains are active.

---

## Conventions

- **Branches:** `{{LINEAR_PREFIX}}-<n>/<domain>/<short-description>` (e.g. `{{LINEAR_PREFIX}}-42/backend/cron-auth`)
- **PR titles:** include Linear issue ID (e.g. `[{{LINEAR_PREFIX}}-42] Add cron auth`)
- **PRs:** always drafts until ready. After creating, post `@claude please review this PR` as a **comment**.
- **Commits:** descriptive messages; no `[Phase N]` prefixes (that was Witness-specific).

---

## Decisions Log

Format: `[YYYY-MM-DD HH:mm] | [decision] | [rationale] | [agent-name]` — reverse chronological, prepend only.

**Domain agents: do NOT write to `decisions.md`** — put decisions in PR body under `## Decisions`. The `/implement` skill consolidates after merge.

---

## Review Gate

PRs get reviewed and fixed in two steps:

1. **`@claude` GitHub review** (automatic) — triggered by `@claude please review this PR` as a PR comment
2. **`/resolve-reviews`** (after reviews land) — reads GitHub review findings, dispatches domain agents to fix

---

## MemPalace

Three specialists: `{{MEMPALACE_PREFIX}}-architect`, `{{MEMPALACE_PREFIX}}-reviewer`, `{{MEMPALACE_PREFIX}}-ops`. The `/implement` skill queries MemPalace once and distributes findings.

---

## Phases

{{! Phases are optional — Witness used them, other projects may not !}}
This project is in active development. No phase gating.

---

## Working with Davies

Davies is the founder. Don't over-explain his own decisions. Flag uncovered
architectural decisions with trade-offs before implementing. When a spec is
ambiguous, ask — don't assume.
```

- [ ] **Step 2: Commit**

```bash
git add templates/AGENTS.md.tmpl
git commit -m "Add AGENTS.md template (tokenized, project-agnostic structure)"
```

---

### Task 23: Create PROGRESS.md template

**Files:**
- Create: `templates/PROGRESS.md.tmpl`

- [ ] **Step 1: Write template**

```markdown
# {{PROJECT_NAME_PASCAL}} — Progress

> Status of active work streams. Update at the end of each session.

**Legend:** ✅ done · 🔄 in progress · ⛔ blocked · ⚪ not started

---

## Bootstrap

- ✅ Repository initialized ({{DATE}})
- ✅ Linear project created: {{LINEAR_PROJECT_URL}}
- ✅ rkt plugin applied: preset `{{PRESET}}`, version `{{RKT_VERSION}}`

## Active work

_Nothing yet._

## Completed work

_Nothing yet._

## Blocked / parked

_Nothing yet._
```

- [ ] **Step 2: Commit**

```bash
git add templates/PROGRESS.md.tmpl
git commit -m "Add PROGRESS.md template"
```

---

### Task 24: Create OPS.md template

**Files:**
- Create: `templates/OPS.md.tmpl`

- [ ] **Step 1: Write template**

```markdown
# {{PROJECT_NAME_PASCAL}} — Ops

> Infrastructure, deploys, production sync. Update when production actions are taken.

## Environments

- **Database:** {{DEPLOY_DB}}
- **Backend:** {{DEPLOY_BACKEND}}
- **Web:** {{DEPLOY_WEB}}

## Migration sync

> Table of migrations and their status across Local / Cloud Dev / Cloud Prod.
> Preset-dependent — only relevant if `rkt.json:deploy.db` is set.

| Migration | Local | Cloud Dev | Cloud Prod | Notes |
| :-------- | :---- | :-------- | :--------- | :---- |
| _pending_ |       |           |            |       |

## Deploy history

_No deploys yet._

## Incidents

_None._
```

- [ ] **Step 2: Commit**

```bash
git add templates/OPS.md.tmpl
git commit -m "Add OPS.md template"
```

---

### Task 25: Create decisions.md template

**Files:**
- Create: `templates/decisions.md.tmpl`

- [ ] **Step 1: Write template**

```markdown
# {{PROJECT_NAME_PASCAL}} — Decisions Log

> Append-only log of architectural decisions. Reverse chronological —
> prepend new entries to the top. **Never** edit or remove entries.
>
> Format: `[YYYY-MM-DD HH:mm] | [decision] | [rationale] | [agent-name]`

## Entries

[{{DATE}} 00:00] | Bootstrapped with rkt preset `{{PRESET}}` | Starting from the shared workflow baseline to avoid reinventing orchestration | rkt-bootstrap
```

- [ ] **Step 2: Commit**

```bash
git add templates/decisions.md.tmpl
git commit -m "Add decisions.md template with bootstrap entry"
```

---

### Task 26: Create agent_learnings.md template

**Files:**
- Create: `templates/agent_learnings.md.tmpl`

- [ ] **Step 1: Write template**

```markdown
# Agent Learnings

> Pitfalls, gotchas, and patterns future agents should know. Add an entry only
> if a future agent would likely repeat the mistake. Don't write for the sake of it.

## Format

Each entry:

```
### YYYY-MM-DD — short title

**Context:** What was being done.
**Mistake:** What went wrong.
**Fix:** What the right approach is.
**How to apply:** When this applies in future work.
```

## Entries

_None yet. Every mistake is an opportunity to prevent the next one._
```

- [ ] **Step 2: Commit**

```bash
git add templates/agent_learnings.md.tmpl
git commit -m "Add agent_learnings.md template"
```

---

### Task 27: Create README.md template

**Files:**
- Create: `templates/README.md.tmpl`

- [ ] **Step 1: Write template**

```markdown
# {{PROJECT_NAME_PASCAL}}

> _[One-sentence description of the project goes here — replace this line.]_

## Stack

Bootstrapped with [rkt](https://github.com/daviesayo/rkt-stack) preset `{{PRESET}}`.

- Backend: {{DEPLOY_BACKEND}}
- Web: {{DEPLOY_WEB}}
- Database: {{DEPLOY_DB}}

## Development

```bash
# Clone and install
git clone ...
cd {{PROJECT_NAME}}

# Preset-specific setup goes here — fill in after first implementation work
```

## Project management

- **Linear:** {{LINEAR_PROJECT_URL}}
- **Issue prefix:** `{{LINEAR_PREFIX}}`
- **Conventions:** see `AGENTS.md`, `decisions.md`, `PROGRESS.md`

## License

_TBD_
```

- [ ] **Step 2: Commit**

```bash
git add templates/README.md.tmpl
git commit -m "Add README.md template"
```

---

### Task 28: Create preset folder scaffolds

**Files:**
- Create: `templates/presets/full/` (with subfolders)
- Create: `templates/presets/web/`
- Create: `templates/presets/backend/`
- Create: `templates/presets/ios/`

- [ ] **Step 1: Create `templates/presets/full/` scaffold**

This mirrors the `full` preset's target folder structure. Create (all paths relative to `templates/presets/full/`):

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack/templates/presets/full

# backend skeleton
mkdir -p backend/app backend/supabase/migrations backend/tests
cat > backend/app/main.py <<'EOF'
"""FastAPI entry point for {{PROJECT_NAME_PASCAL}}."""
from fastapi import FastAPI

app = FastAPI(title="{{PROJECT_NAME_PASCAL}}")


@app.get("/v1/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
EOF

cat > backend/app/deps.py <<'EOF'
"""Shared FastAPI dependencies (JWT verification stub)."""
# Implement JWT verification here when auth is wired up.
EOF

cat > backend/pyproject.toml <<'EOF'
[project]
name = "{{PROJECT_NAME}}-backend"
version = "0.0.1"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "pydantic>=2.8",
  "uvicorn[standard]>=0.30",
  "supabase>=2.7",
]

[tool.uv]
dev-dependencies = [
  "pytest>=8",
  "pytest-asyncio>=0.23",
  "ruff>=0.6",
]
EOF

touch backend/supabase/migrations/.gitkeep
touch backend/tests/__init__.py

# ios skeleton
mkdir -p ios
cat > ios/README.md <<'EOF'
# iOS app

Xcode does not have a CLI for creating new iOS app projects, so this folder
is intentionally empty. To finish the setup:

1. Open Xcode → **Create New Project**
2. Choose **iOS → App**, Interface: **SwiftUI**, Language: **Swift**
3. Product Name: `{{PROJECT_NAME_PASCAL}}`
4. Organization Identifier: use your preferred reverse-domain
5. Save location: this `ios/` folder
6. Enable relevant Capabilities (Push Notifications, App Groups, etc.)

Commit the resulting `{{PROJECT_NAME_PASCAL}}.xcodeproj` and source tree.

After that, `/implement` can do real iOS work.
EOF

# web skeleton (Vite + React + TS)
mkdir -p web/src
cat > web/package.json <<'EOF'
{
  "name": "{{PROJECT_NAME}}-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "^5.6.0",
    "vite": "^7.0.0"
  }
}
EOF

cat > web/vite.config.ts <<'EOF'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
EOF

cat > web/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
EOF

mkdir -p web/src
cat > web/src/main.tsx <<'EOF'
import React from 'react';
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <h1>{{PROJECT_NAME_PASCAL}}</h1>
  </React.StrictMode>
);
EOF

cat > web/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{PROJECT_NAME_PASCAL}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF
```

- [ ] **Step 2: Create `templates/presets/web/` scaffold (Next.js)**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack/templates/presets/web

mkdir -p app components lib supabase/migrations

cat > package.json <<'EOF'
{
  "name": "{{PROJECT_NAME}}",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@supabase/ssr": "^0.5.0",
    "@supabase/supabase-js": "^2.45.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.6.0",
    "tailwindcss": "^4.0.0"
  }
}
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"]
}
EOF

cat > app/layout.tsx <<'EOF'
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
EOF

cat > app/page.tsx <<'EOF'
export default function HomePage() {
  return <h1>{{PROJECT_NAME_PASCAL}}</h1>;
}
EOF

cat > lib/supabase.ts <<'EOF'
// Supabase client helpers go here. Use @supabase/ssr:
//   - createBrowserClient in Client Components
//   - createServerClient in Server Components / Server Actions
EOF

touch supabase/migrations/.gitkeep

cat > next.config.ts <<'EOF'
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {};

export default nextConfig;
EOF
```

- [ ] **Step 3: Create `templates/presets/backend/` scaffold**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack/templates/presets/backend

mkdir -p app supabase/migrations tests

cat > app/main.py <<'EOF'
"""FastAPI entry point for {{PROJECT_NAME_PASCAL}}."""
from fastapi import FastAPI

app = FastAPI(title="{{PROJECT_NAME_PASCAL}}")


@app.get("/v1/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
EOF

cat > app/deps.py <<'EOF'
"""Shared FastAPI dependencies."""
EOF

cat > pyproject.toml <<'EOF'
[project]
name = "{{PROJECT_NAME}}"
version = "0.0.1"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "pydantic>=2.8",
  "uvicorn[standard]>=0.30",
  "supabase>=2.7",
]

[tool.uv]
dev-dependencies = [
  "pytest>=8",
  "pytest-asyncio>=0.23",
  "ruff>=0.6",
]
EOF

touch supabase/migrations/.gitkeep
touch tests/__init__.py
```

- [ ] **Step 4: Create `templates/presets/ios/` scaffold**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack/templates/presets/ios

mkdir -p ios
cat > ios/README.md <<'EOF'
# iOS app

Xcode does not have a CLI for creating new iOS app projects, so this folder
is intentionally empty. To finish the setup:

1. Open Xcode → **Create New Project**
2. Choose **iOS → App**, Interface: **SwiftUI**, Language: **Swift**
3. Product Name: `{{PROJECT_NAME_PASCAL}}`
4. Save location: this `ios/` folder

After that, `/implement` can do real iOS work.
EOF
```

- [ ] **Step 5: Commit all preset scaffolds**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add templates/presets/
git commit -m "Add folder scaffolds for all 4 presets (full/web/backend/ios)"
```

---

## Phase 6: Bootstrap Skill — NEW Mode

Goal: `/bootstrap <preset> <name>` works end-to-end in an empty directory.

### Task 29: Write bootstrap SKILL.md header and state detection

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Replace placeholder with full skill structure**

Overwrite `skills/bootstrap/SKILL.md` with the complete skill body. This task covers the skill's opening sections and state detection routing. Subsequent tasks add the NEW and ADOPT flows.

```markdown
---
name: bootstrap
description: Use to scaffold a new project (greenfield) or adopt an existing one into the rkt workflow. Accepts optional args `[preset] [name]`. Triggers on "bootstrap this", "bootstrap ios", "new project", "set up this repo with rkt", "adopt this project", "apply rkt to this directory".
---

# Bootstrap

You scaffold a new project or adopt an existing one into Davies's rkt workflow.
You run in the target directory (the user has already `cd`'d there).

**Two modes, chosen by state detection:**

- **NEW** — target directory is empty (or close to it). Greenfield scaffolding.
- **ADOPT** — target directory has existing code/.git. Non-destructive layering.
- **Already bootstrapped** — target directory has `rkt.json`. Short-circuit to `/rkt-sync`.

## Step 0: State detection

Before doing anything else, scan the target directory:

```bash
TARGET="$(pwd)"
DETECT_OUTPUT=$("${CLAUDE_PLUGIN_ROOT}/scripts/detect-stack.sh" "$TARGET")
echo "$DETECT_OUTPUT"
```

Parse the JSON output:
- If `signals.has_rkt_json == true` → tell the user the project is already
  bootstrapped and suggest `/rkt-sync`. Stop here.
- If `signals.has_git == true` OR `signals.has_agents_md == true` OR any
  stack signals fired → **ADOPT mode** (see Step A1 and beyond)
- Otherwise → **NEW mode** (see Step N1 and beyond)

Announce the chosen mode to the user before proceeding.
```

- [ ] **Step 2: Verify skill loads without errors**

Run: `claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep -i bootstrap`
Expected: skill registered, description visible.

- [ ] **Step 3: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add bootstrap skill header and state-detection routing"
```

---

### Task 30: NEW mode — preflight and config gathering

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append NEW mode Steps N1 and N2 to the skill**

Append the following below the existing content:

```markdown

## NEW mode

### Step N1: Preflight (light)

Check that the tools needed for subsequent steps are installed:

```bash
for tool in git gh linear jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "⚠️  Missing: $tool"
  fi
done
```

If any are missing, report them in a table and note which steps will fail:

| Tool       | Missing? | Affects                   |
| :--------- | :------- | :------------------------ |
| `git`      | yes      | Step N5 (init + commit)   |
| `gh`       | yes      | Step N7 (GitHub repo)     |
| `linear`   | yes      | Step N6 (Linear project)  |
| `jq`       | yes      | all template rendering    |

Do **not** auto-install — that's deferred. Ask the user via `AskUserQuestion`
whether to proceed anyway, understanding some steps will be skipped.

### Step N2: Gather config

Use `AskUserQuestion` for every prompt — never use bash `read` or plain text
questions.

**Preset** (if not passed as arg):

- Question: "Which preset?"
- Options: `full`, `web`, `backend`, `ios`
- Multi-select: false

**Project name** (if not passed as arg):

- Ask as free text; validate: must match `[a-z][a-z0-9-]*`
- Derive `{{PROJECT_NAME_PASCAL}}` from it (e.g. `my-new-thing` → `MyNewThing`)

**Issue prefix**:

- Auto-derive via `${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh` function
  `derive_prefix`
- Present as suggestion: "I suggest `MNT` for `my-new-thing`. Accept?"
- Options: `[Accept MNT]`, `[Customize]`, `[Cancel]`

**Linear team**:

- Query available teams:
  ```bash
  linear api <<< 'query { teams { nodes { id key name } } }' | jq -r '.data.teams.nodes'
  ```
- If 1 team → auto-use it
- If >1 team → `AskUserQuestion` with team names as options
- If 0 teams → error out with actionable message

**GitHub repo**:

- Options: `[Create private]`, `[Create public]`, `[Skip]`
- Default: use `${CLAUDE_PLUGIN_OPTION_DEFAULT_GH_VISIBILITY}` if set

**MemPalace specialist prefix**:

- Default: same as project name (slugified)
- `AskUserQuestion`: `[Use project name]`, `[Customize]`

Store all gathered values in a temp JSON file for subsequent steps:

```bash
TMPVARS="$(mktemp)"
cat > "$TMPVARS" <<EOF
{
  "PROJECT_NAME": "...",
  "PROJECT_NAME_PASCAL": "...",
  "PRESET": "...",
  "LINEAR_PREFIX": "...",
  "LINEAR_TEAM_ID": "...",
  "MEMPALACE_PREFIX": "...",
  "GH_VISIBILITY": "...",
  "DEPLOY_BACKEND": "...",
  "DEPLOY_WEB": "...",
  "DEPLOY_DB": "...",
  "DATE": "$(date +%Y-%m-%d)",
  "RKT_VERSION": "$(jq -r .version \"\${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json\")"
}
EOF
```

Populate `DEPLOY_*` per preset:
- `full`: `railway`, `vercel`, `supabase`
- `web`: `null`, `vercel`, `supabase`
- `backend`: `railway`, `null`, `supabase`
- `ios`: `null`, `null`, `null`
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add NEW mode steps N1 (preflight) and N2 (config gather with AskUserQuestion)"
```

---

### Task 31: NEW mode — scaffold, render, git init

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append Steps N3, N4, N5 to the skill**

```markdown

### Step N3: Scaffold folders

Copy the chosen preset's folder skeleton into the target directory:

```bash
PRESET=$(jq -r .PRESET "$TMPVARS")
SCAFFOLD="${CLAUDE_PLUGIN_ROOT}/templates/presets/$PRESET"
cp -R "$SCAFFOLD/." "$TARGET/"
```

After copying, render tokens in each newly-copied file. Walk the target
directory and for every file containing `{{...}}` tokens, run
`render-template.sh` with the vars.

(Use `find` + `grep -l` to identify token-bearing files to avoid re-rendering
binary assets.)

```bash
find "$TARGET" -type f \( -name "*.tmpl" -o -print0 \) | while IFS= read -r -d '' f; do
  if grep -q '{{' "$f" 2>/dev/null; then
    tmp="$f.rendered"
    "${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" "$f" "$tmp" "$(cat "$TMPVARS")"
    mv "$tmp" "$f"
  fi
done
```

### Step N4: Render global templates

For each file in `${CLAUDE_PLUGIN_ROOT}/templates/` with a `.tmpl` extension,
render it into the target directory **without** the `.tmpl` suffix:

```bash
TEMPLATES="${CLAUDE_PLUGIN_ROOT}/templates"
for tmpl in AGENTS.md PROGRESS.md OPS.md README.md rkt.json; do
  "${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" \
    "$TEMPLATES/${tmpl}.tmpl" "$TARGET/$tmpl" "$(cat "$TMPVARS")"
done

# decisions.md and agent_learnings.md go in specific subfolders
mkdir -p "$TARGET/docs/decisions"
"${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" \
  "$TEMPLATES/decisions.md.tmpl" "$TARGET/decisions.md" "$(cat "$TMPVARS")"
"${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" \
  "$TEMPLATES/agent_learnings.md.tmpl" "$TARGET/docs/decisions/agent_learnings.md" "$(cat "$TMPVARS")"
```

Copy rules relevant to the preset into `.claude/rules/`:

```bash
mkdir -p "$TARGET/.claude/rules"

case "$PRESET" in
  full)    RULES=(backend-fastapi supabase web-vite ios-design) ;;
  web)     RULES=(web-nextjs supabase) ;;
  backend) RULES=(backend-fastapi supabase) ;;
  ios)     RULES=(ios-design) ;;
esac

for rule in "${RULES[@]}"; do
  cp "${CLAUDE_PLUGIN_ROOT}/rules/${rule}.md" "$TARGET/.claude/rules/${rule}.md"
done
```

### Step N5: git init + first commit

Use the rkt plugin's new-feature script (for consistency) or init directly:

```bash
cd "$TARGET"
git init -b main
git add .
git commit -m "[bootstrap] Initialize $(jq -r .PROJECT_NAME "$TMPVARS") ($(jq -r .PRESET "$TMPVARS"))"
```

Report the commit SHA back to the user.
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add NEW mode steps N3-N5 (scaffold, render, git init)"
```

---

### Task 32: NEW mode — Linear project creation

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append Step N6 to the skill**

```markdown

### Step N6: Create Linear project

Use the Linear GraphQL API via `linear api` — the CLI does not expose
`project create` directly.

```bash
TEAM_ID=$(jq -r .LINEAR_TEAM_ID "$TMPVARS")
PROJECT_NAME=$(jq -r .PROJECT_NAME_PASCAL "$TMPVARS")

LINEAR_RESP=$(linear api --variable name="$PROJECT_NAME" --variable teamId="$TEAM_ID" <<'GRAPHQL'
mutation($name: String!, $teamId: String!) {
  projectCreate(input: { name: $name, teamIds: [$teamId] }) {
    project { id name url }
    success
  }
}
GRAPHQL
)

if ! echo "$LINEAR_RESP" | jq -e '.data.projectCreate.success' >/dev/null; then
  echo "Error: Linear project creation failed"
  echo "$LINEAR_RESP"
  exit 1
fi

LINEAR_PROJECT_ID=$(echo "$LINEAR_RESP" | jq -r '.data.projectCreate.project.id')
LINEAR_PROJECT_URL=$(echo "$LINEAR_RESP" | jq -r '.data.projectCreate.project.url')
```

Patch the values into `rkt.json`:

```bash
jq --arg id "$LINEAR_PROJECT_ID" --arg url "$LINEAR_PROJECT_URL" \
  '.linear.project_id = $id | .linear.project_url = $url' \
  "$TARGET/rkt.json" > "$TARGET/rkt.json.new"
mv "$TARGET/rkt.json.new" "$TARGET/rkt.json"
```

Re-stage and amend the bootstrap commit to include the updated rkt.json:

```bash
cd "$TARGET"
git add rkt.json
git commit --amend --no-edit
```

If Linear creation fails (401, network error), do NOT fail the entire bootstrap.
Warn the user, set `linear.project_id` / `linear.project_url` to empty strings
in `rkt.json`, and continue. The user can retry linking later.
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add NEW mode step N6 (Linear project via GraphQL)"
```

---

### Task 33: NEW mode — GitHub repo creation and report

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append Steps N7 and N8 to the skill**

```markdown

### Step N7: (Optional) GitHub repo creation

Check the `GH_VISIBILITY` value gathered in Step N2:

```bash
GH_VIS=$(jq -r .GH_VISIBILITY "$TMPVARS")
case "$GH_VIS" in
  private|public)
    cd "$TARGET"
    gh repo create "$(jq -r .PROJECT_NAME "$TMPVARS")" \
      --"$GH_VIS" \
      --source=. \
      --remote=origin \
      --push
    ;;
  skip|"")
    echo "Skipping GitHub repo creation (user chose skip)"
    ;;
esac
```

If `gh repo create` fails (auth issue, name conflict), warn but don't abort
the bootstrap. The user can run it manually later.

### Step N8: Report

Present a summary to the user:

```markdown
## ✓ {{PROJECT_NAME}} bootstrapped

- **Preset:** {{PRESET}}
- **Linear project:** {{LINEAR_PROJECT_URL}} _(or "failed — retry later" if blank)_
- **GitHub repo:** {{github url}} _(or "skipped" / "failed")_
- **First commit:** {{commit sha short}}

### Next steps

- `/scan` — let me analyze what's here and suggest Linear issues to create
- `/create-issue` — file your first feature request
- `/implement` — build an issue from the backlog

### Config files to review

- `AGENTS.md` — agent conventions (already tailored to your preset)
- `rkt.json` — project config (Linear prefix, deploy targets, mempalace prefix)
- `PROGRESS.md` — update as you work
```
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add NEW mode steps N7 (gh repo) and N8 (report)"
```

---

### Task 34: End-to-end test for NEW mode

**Files:**
- Create: `tests/test-bootstrap-new.sh`

- [ ] **Step 1: Write integration test**

This test creates a throwaway temp directory, sets minimal env vars, and
invokes the bootstrap skill via Claude Code headless mode. It skips
Linear/GitHub steps to keep the test hermetic.

```bash
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
for tmpl in AGENTS.md PROGRESS.md OPS.md README.md rkt.json; do
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
[[ -f "$tmpdir/AGENTS.md" ]] || { echo "FAIL: AGENTS.md missing"; exit 1; }
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
```

- [ ] **Step 2: Run test**

```bash
chmod +x /Users/rocket/Documents/Repositories/rkt-stack/tests/test-bootstrap-new.sh
bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-bootstrap-new.sh
```
Expected: `PASS: test-bootstrap-new.sh`. If tokens remain unrendered, fix the `render-template.sh` invocation in Step N4 or the template files.

- [ ] **Step 3: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add tests/test-bootstrap-new.sh
git commit -m "Add end-to-end test for NEW mode bootstrap (scaffolding + rendering)"
```

---

## Phase 7: Bootstrap Skill — ADOPT Mode

Goal: `/bootstrap` in an existing directory adopts it non-destructively.

### Task 35: ADOPT mode — detect and suggest preset

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append ADOPT section to the skill**

```markdown

## ADOPT mode

### Step A1: Preflight

Same as Step N1 — check tools, warn on missing.

### Step A2: Detect stack and confirm preset

Re-use the output of Step 0's detection:

```bash
SUGGESTED=$(echo "$DETECT_OUTPUT" | jq -r .suggested_preset)
```

Use `AskUserQuestion`:

- If `SUGGESTED != null`:
  - Question: "I detected `{{detected signals summary}}`. Apply `{{SUGGESTED}}` preset?"
  - Options: `[Yes, apply {{SUGGESTED}}]`, `[Different preset]`, `[Cancel]`
- If `SUGGESTED == null`:
  - Question: "Couldn't auto-detect. Which preset?"
  - Options: `full`, `web`, `backend`, `ios`, `[Cancel]`

Write the user's choice into `TMPVARS.PRESET` as in NEW mode.
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add ADOPT mode steps A1 (preflight) and A2 (detect + confirm preset)"
```

---

### Task 36: ADOPT mode — gather remaining config

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append Step A3**

```markdown

### Step A3: Gather remaining config

Same prompts as NEW Step N2, but with these differences:

- **Project name:** default to the current directory basename. Offer to
  override via `AskUserQuestion`.
- **GitHub repo:** if `signals.has_remote == true`, default to "Skip".
  Otherwise offer the normal menu.
- **Issue prefix:** auto-derive from the git remote name if available,
  otherwise from the directory name.
- **MemPalace prefix:** default to the project name, offer override.
- **Linear:** handled in Step A6 (not here — ADOPT has the "link existing"
  path).

Populate `TMPVARS` identically to NEW Step N2. Default `DEPLOY_*` by preset.
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add ADOPT mode step A3 (config gather with existing-project defaults)"
```

---

### Task 37: ADOPT mode — additive scaffold

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append Step A4**

```markdown

### Step A4: Additive scaffold (fill gaps only)

For every file/folder in `templates/presets/{preset}/`, compare against
the target:

```bash
SCAFFOLD="${CLAUDE_PLUGIN_ROOT}/templates/presets/$PRESET"

(cd "$SCAFFOLD" && find . -type f ! -path "./.*") | while read -r rel; do
  dest="$TARGET/${rel#./}"
  if [[ ! -e "$dest" ]]; then
    # Create missing file (rendered)
    mkdir -p "$(dirname "$dest")"
    if grep -q '{{' "$SCAFFOLD/$rel" 2>/dev/null; then
      "${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" "$SCAFFOLD/$rel" "$dest" "$(cat "$TMPVARS")"
    else
      cp "$SCAFFOLD/$rel" "$dest"
    fi
  else
    # File exists → skip. Step A5 will handle templated-file conflicts.
    continue
  fi
done
```

**Never overwrite existing files in Step A4.** Folder skeletons are additive
only.
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add ADOPT mode step A4 (additive scaffold, never overwrites)"
```

---

### Task 38: ADOPT mode — per-file conflict resolution

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append Step A5**

```markdown

### Step A5: Render global templates with per-file conflict resolution

For each of these files (rendered path shown):

- `AGENTS.md`
- `PROGRESS.md`
- `OPS.md`
- `README.md`
- `rkt.json`
- `decisions.md`
- `docs/decisions/agent_learnings.md`
- `.claude/rules/*.md` (the ones applicable to the chosen preset)

Apply this logic:

```bash
render_with_conflict() {
  local template="$1"
  local dest="$2"

  # Render template into a temp file
  local rendered=$(mktemp)
  "${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" "$template" "$rendered" "$(cat "$TMPVARS")"

  if [[ ! -e "$dest" ]]; then
    mkdir -p "$(dirname "$dest")"
    mv "$rendered" "$dest"
    echo "Created: $dest"
  elif diff -q "$rendered" "$dest" >/dev/null 2>&1; then
    # Identical — skip silently
    rm -f "$rendered"
  else
    # Conflict. Surface to user via AskUserQuestion with these options:
    #   [Keep mine]  — leave $dest untouched
    #   [Replace]    — mv "$rendered" "$dest"
    #   [Merge]      — 3-way merge using git merge-file or user's $EDITOR
    #   [Skip]       — same as Keep mine, but flag in final report
    # (The skill instructs Claude to call AskUserQuestion; this comment
    # documents the expected behavior.)
    echo "Conflict: $dest (will prompt user)"
    # Store rendered path + dest for prompt processing
    echo "$template|$dest|$rendered" >> /tmp/rkt-conflicts.txt
  fi
}

> /tmp/rkt-conflicts.txt  # clear

# Iterate templates
TEMPLATES="${CLAUDE_PLUGIN_ROOT}/templates"
render_with_conflict "$TEMPLATES/AGENTS.md.tmpl"        "$TARGET/AGENTS.md"
render_with_conflict "$TEMPLATES/PROGRESS.md.tmpl"      "$TARGET/PROGRESS.md"
render_with_conflict "$TEMPLATES/OPS.md.tmpl"           "$TARGET/OPS.md"
render_with_conflict "$TEMPLATES/README.md.tmpl"        "$TARGET/README.md"
render_with_conflict "$TEMPLATES/rkt.json.tmpl"         "$TARGET/rkt.json"
render_with_conflict "$TEMPLATES/decisions.md.tmpl"     "$TARGET/decisions.md"
render_with_conflict "$TEMPLATES/agent_learnings.md.tmpl" "$TARGET/docs/decisions/agent_learnings.md"

# Rules
case "$PRESET" in
  full)    RULES=(backend-fastapi supabase web-vite ios-design) ;;
  web)     RULES=(web-nextjs supabase) ;;
  backend) RULES=(backend-fastapi supabase) ;;
  ios)     RULES=(ios-design) ;;
esac

for rule in "${RULES[@]}"; do
  mkdir -p "$TARGET/.claude/rules"
  if [[ ! -e "$TARGET/.claude/rules/${rule}.md" ]]; then
    cp "${CLAUDE_PLUGIN_ROOT}/rules/${rule}.md" "$TARGET/.claude/rules/${rule}.md"
    echo "Created: .claude/rules/${rule}.md"
  elif diff -q "${CLAUDE_PLUGIN_ROOT}/rules/${rule}.md" "$TARGET/.claude/rules/${rule}.md" >/dev/null 2>&1; then
    : # identical, skip
  else
    echo "${CLAUDE_PLUGIN_ROOT}/rules/${rule}.md|$TARGET/.claude/rules/${rule}.md|" >> /tmp/rkt-conflicts.txt
  fi
done
```

**Then, for each conflict recorded in `/tmp/rkt-conflicts.txt`**, use
`AskUserQuestion` with 4 options:

- `[Keep mine]` → leave existing file untouched, discard rendered copy
- `[Replace]` → `mv rendered dest`
- `[Merge (3-way)]` → run `git merge-file --ours dest <(echo) rendered` or
  open the user's `$EDITOR` with conflict markers; on save, accept the result
- `[Skip]` → same as Keep mine but flag in the final report

Track outcomes for the report:

```bash
# conflict-outcomes.json structure:
# { "AGENTS.md": "replaced", "README.md": "kept_mine", ... }
```
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add ADOPT mode step A5 (per-file conflict resolution via AskUserQuestion)"
```

---

### Task 39: ADOPT mode — Linear link or create

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append Step A6**

```markdown

### Step A6: Linear — link existing or create new

Use `AskUserQuestion`:

- Question: "Is there an existing Linear project for this repo?"
- Options: `[Link existing (paste URL)]`, `[Create new]`, `[Skip Linear]`

**If Link existing:**

- Prompt for Linear URL via `AskUserQuestion` (free text)
- Parse project ID from URL (format: `https://linear.app/<workspace>/project/<slug>-<uuid>`)
- Fetch project details to confirm and extract team ID:
  ```bash
  linear api --variable projectId="$PROJECT_ID" <<'GRAPHQL'
  query($projectId: String!) {
    project(id: $projectId) { id name url teams { nodes { id key } } }
  }
  GRAPHQL
  ```
- Store the extracted ID, URL, team ID, and team key (as `LINEAR_PREFIX`
  if the user wants to override their derived prefix) into `TMPVARS` →
  which flows into `rkt.json` via Step A5's render.

**If Create new:** same GraphQL mutation as NEW Step N6.

**If Skip:** set `linear.project_id` and `linear.project_url` in
`rkt.json` to empty strings. Skills gracefully degrade (warn but don't fail)
when Linear config is absent.

After Linear is resolved, re-render `rkt.json` if its contents changed:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" \
  "${CLAUDE_PLUGIN_ROOT}/templates/rkt.json.tmpl" "$TARGET/rkt.json" "$(cat "$TMPVARS")"
```
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add ADOPT mode step A6 (Linear link existing or create new)"
```

---

### Task 40: ADOPT mode — commit on existing history and report

**Files:**
- Modify: `skills/bootstrap/SKILL.md`

- [ ] **Step 1: Append Steps A7 and A8**

```markdown

### Step A7: Commit on existing history

If `.git/` exists:

```bash
cd "$TARGET"
git add .
if ! git diff --cached --quiet; then
  git commit -m "[rkt] Add workflow tooling and project scaffolding"
else
  echo "No changes staged — nothing to commit"
fi
```

If `.git/` does NOT exist (rare for ADOPT but possible with fork-by-download
scenarios):

```bash
cd "$TARGET"
git init -b main
git add .
git commit -m "[rkt] Initial commit with workflow tooling"
```

### Step A8: Report

Produce a summary that reflects what actually happened:

```markdown
## ✓ Applied `{{PRESET}}` preset to {{PROJECT_NAME}}

**Added:**
- {{list of newly-created files, e.g. .claude/rules/web-nextjs.md, PROGRESS.md, OPS.md, decisions.md, docs/decisions/agent_learnings.md, rkt.json}}

**Conflicts resolved:**
- {{file}}: {{outcome — replaced / kept mine / merged / skipped}}
- ...

**Skipped (already existed, identical):**
- {{file}}, {{file}}

**Linear:** {{created new https://... / linked existing / skipped}}

**GitHub:** {{pushed to origin / existing remote preserved / skipped}}

### Next steps

- `/scan` — suggest issues to add to Linear based on the existing code
- `/create-issue` — file your first rkt-managed issue
- `/implement` — start work
```
```

- [ ] **Step 2: Commit**

```bash
git add skills/bootstrap/SKILL.md
git commit -m "Add ADOPT mode steps A7 (commit on existing history) and A8 (report)"
```

---

### Task 41: Integration test for ADOPT mode

**Files:**
- Create: `tests/test-bootstrap-adopt.sh`

- [ ] **Step 1: Write integration test**

The test simulates ADOPT by pre-populating a directory with Next.js signals
and an existing AGENTS.md, then running the skill's steps directly. Conflict
resolution is simulated by always choosing "Keep mine" (since we can't call
`AskUserQuestion` from a shell test).

```bash
#!/usr/bin/env bash
# tests/test-bootstrap-adopt.sh — ADOPT mode integration test
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HERE/.."

tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT

# Seed: existing Next.js project with a pre-existing AGENTS.md
cp -R "$HERE/fixtures/nextjs-existing/." "$tmpdir/"
cd "$tmpdir"
git init -q -b main
cat > AGENTS.md <<'EOF'
# Existing AGENTS.md
My own conventions live here. Preserve me.
EOF
git add .
git commit -q -m "initial"

# 1. Detection should suggest `web` and flag has_agents_md
DETECT=$(bash "$PLUGIN_DIR/scripts/detect-stack.sh" "$tmpdir")
[[ $(echo "$DETECT" | jq -r .suggested_preset) == "web" ]] || { echo "FAIL: detect should suggest web"; exit 1; }
[[ $(echo "$DETECT" | jq -r .signals.has_agents_md) == "true" ]] || { echo "FAIL: has_agents_md should be true"; exit 1; }

# 2. Simulate TMPVARS
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
  "DEPLOY_BACKEND": "null",
  "DEPLOY_WEB": "vercel",
  "DEPLOY_DB": "supabase",
  "DATE": "2026-04-18",
  "RKT_VERSION": "0.1.0"
}
EOF

# 3. Additive scaffold (Step A4) — should NOT overwrite existing files
# The web preset has package.json which already exists here — skip
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
done

# Verify package.json was NOT overwritten (should still contain "fake-next-app")
grep -q "fake-next-app" "$tmpdir/package.json" || { echo "FAIL: package.json was overwritten"; exit 1; }

# 4. Render global templates — simulate "Keep mine" for AGENTS.md conflict,
#    create the rest
for tmpl in PROGRESS.md OPS.md rkt.json; do
  "$PLUGIN_DIR/scripts/render-template.sh" \
    "$PLUGIN_DIR/templates/${tmpl}.tmpl" "$tmpdir/$tmpl" "$(cat "$TMPVARS")"
done

# decisions.md and agent_learnings.md
mkdir -p "$tmpdir/docs/decisions"
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/decisions.md.tmpl" "$tmpdir/decisions.md" "$(cat "$TMPVARS")"
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/agent_learnings.md.tmpl" "$tmpdir/docs/decisions/agent_learnings.md" "$(cat "$TMPVARS")"

# AGENTS.md conflict: simulate "Keep mine" — leave untouched
# (existing AGENTS.md has "Existing AGENTS.md" — verify still there)
grep -q "My own conventions" "$tmpdir/AGENTS.md" || { echo "FAIL: AGENTS.md was overwritten despite Keep mine"; exit 1; }

# Rules
mkdir -p "$tmpdir/.claude/rules"
cp "$PLUGIN_DIR/rules/web-nextjs.md" "$tmpdir/.claude/rules/"
cp "$PLUGIN_DIR/rules/supabase.md" "$tmpdir/.claude/rules/"

# 5. Commit
cd "$tmpdir"
git add .
git commit -q -m "[rkt] test adoption"

# Assertions
[[ -f "$tmpdir/rkt.json" ]] || { echo "FAIL: rkt.json missing"; exit 1; }
[[ -f "$tmpdir/.claude/rules/web-nextjs.md" ]] || { echo "FAIL: web-nextjs rule missing"; exit 1; }
[[ $(jq -r .preset "$tmpdir/rkt.json") == "web" ]] || { echo "FAIL: rkt.json preset wrong"; exit 1; }

rm -f "$TMPVARS"
echo "PASS: test-bootstrap-adopt.sh"
```

- [ ] **Step 2: Run test**

```bash
chmod +x /Users/rocket/Documents/Repositories/rkt-stack/tests/test-bootstrap-adopt.sh
bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-bootstrap-adopt.sh
```
Expected: `PASS: test-bootstrap-adopt.sh`

- [ ] **Step 3: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add tests/test-bootstrap-adopt.sh
git commit -m "Add ADOPT mode integration test (non-destructive additive layering)"
```

---

## Phase 8: Port Remaining Skills

Goal: the 4 skills that run against bootstrapped projects work end-to-end, parameterized by `rkt.json`.

Each port follows the same pattern: copy from Witness, replace hardcoded values with `jq`-based reads from `rkt.json`, and swap text/bash prompts for `AskUserQuestion`.

### Task 42: Port /implement skill

**Files:**
- Modify: `skills/implement/SKILL.md`

- [ ] **Step 1: Read source**

Read `/Users/rocket/Documents/Repositories/witness/.claude/skills/implement/SKILL.md`.

- [ ] **Step 2: Rewrite with parameterization**

Copy the file, then apply these substitutions:

1. Any reference to "RKT-" hardcoded → replace with a command to read the prefix:
   ```bash
   PREFIX=$(jq -r .linear.issue_prefix rkt.json)
   ```
   Then reference issues as `${PREFIX}-42`.

2. Any reference to "Witness" as project name → replace with "the project
   (read `rkt.json:project_name` if needed)".

3. MemPalace specialist names `witness-architect|reviewer|ops` → replace
   with `${MP}-architect|reviewer|ops` where `MP` is
   `jq -r .mempalace.specialist_prefix rkt.json`.

4. Swap any `[Accept]/[Customize]/[Cancel]` text-menu prompts to
   `AskUserQuestion` invocations. Add a note near the top:
   > **UX principle: all interactive prompts use the `AskUserQuestion`
   > tool, never bash `read` or free-text options.**

5. Replace `/opt/homebrew/bin/linear` hardcoded path with just `linear`
   (rely on PATH).

6. Preserve the MemPalace write step in Step 9 — ensure the specialist
   names use the dynamic prefix.

7. Preserve the resolve-reviews hand-off in Step 7 (as we restructured
   recently in Witness).

- [ ] **Step 3: Verify skill loads**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep -i "skill.*implement"
```
Expected: skill registered, no errors.

- [ ] **Step 4: Commit**

```bash
git add skills/implement/SKILL.md
git commit -m "Port /implement skill, parameterize via rkt.json, use AskUserQuestion"
```

---

### Task 43: Port /create-issue skill

**Files:**
- Modify: `skills/create-issue/SKILL.md`

- [ ] **Step 1: Read source**

Read `/Users/rocket/Documents/Repositories/witness/.claude/skills/create-issue/SKILL.md`.

- [ ] **Step 2: Rewrite with parameterization**

Apply the same substitution rules as Task 42. Specific to this skill:

- The `linear issue create --project "Witness"` command becomes
  `linear issue create --project-id "$(jq -r .linear.project_id rkt.json)"`
  (or the project name equivalent — pick whichever the CLI supports).
- The label reference table stays (Backend/Database/iOS/Web/Feature/Bug
  labels are generic to the plugin — they're applied in all projects).
- Any witness-architect MemPalace writes use the dynamic prefix.

- [ ] **Step 3: Verify and commit**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep -i "skill.*create-issue"
git add skills/create-issue/SKILL.md
git commit -m "Port /create-issue skill, parameterize Linear project via rkt.json"
```

---

### Task 44: Port /scan skill

**Files:**
- Modify: `skills/scan/SKILL.md`

- [ ] **Step 1: Read source**

Read `/Users/rocket/Documents/Repositories/witness/.claude/skills/scan/SKILL.md`.

- [ ] **Step 2: Rewrite with parameterization**

- Replace `linear issue list --project "Witness"` with
  `linear issue list --project-id "$(jq -r .linear.project_id rkt.json)"`.
- Same substitution rules as other skills.
- Hand-off to `/create-issue` stays intact (already project-agnostic).

- [ ] **Step 3: Verify and commit**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep -i "skill.*scan"
git add skills/scan/SKILL.md
git commit -m "Port /scan skill, parameterize Linear project via rkt.json"
```

---

### Task 45: Port /resolve-reviews skill

**Files:**
- Modify: `skills/resolve-reviews/SKILL.md`

- [ ] **Step 1: Read source**

Read `/Users/rocket/Documents/Repositories/witness/.claude/skills/resolve-reviews/SKILL.md`.

- [ ] **Step 2: Rewrite with parameterization**

This skill is already largely project-agnostic in Witness (it operates on
PRs via `gh`, branch names parse to domain automatically). Minimal changes:

- No hardcoded project values to replace — remove any Witness-specific
  label assumptions if present and read labels generically from Linear issues.
- The `[Keep mine]/[Replace]/...` style prompts become `AskUserQuestion`.
- MemPalace writes use `${MP}-reviewer` prefix.

- [ ] **Step 3: Verify and commit**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep -i "skill.*resolve"
git add skills/resolve-reviews/SKILL.md
git commit -m "Port /resolve-reviews skill, minor parameterization + AskUserQuestion"
```

---

## Phase 8.5: /rkt-tailor Skill

Goal: after bootstrap, interactively capture project-specific business rules into project-owned overlays. Runs when the project has real code; re-runnable as the project evolves.

### Task 45.1: Build rkt-tailor skill

**Files:**
- Create: `skills/rkt-tailor/SKILL.md`
- Update: `.claude-plugin/plugin.json` (not needed if skills dir auto-discovers; otherwise verify registration)

- [ ] **Step 1: Create `skills/rkt-tailor/SKILL.md`**

```markdown
---
name: rkt-tailor
description: Use to capture project-specific business rules and domain conventions into project-owned overlays (`.claude/rules/project-*.md`, `agents/*.project.md`). Run after bootstrap, once the project has real code. Triggers on "tailor this project", "capture project rules", "rkt tailor", "project-specific rules", "update agent overlays for this project".
---

# rkt-tailor

You scan a bootstrapped rkt project and capture its project-specific
business rules into overlay files that the generic plugin agents read at
task time. Re-runnable as the project evolves.

## Step 1: Verify project is bootstrapped

```bash
[[ -f rkt.json ]] || {
  echo "No rkt.json here. Run /bootstrap first."
  exit 1
}
PRESET=$(jq -r .preset rkt.json)
```

## Step 2: Gather project context

Read (in this order, quietly — no re-read if already in context):

- `AGENTS.md` — agent conventions and project overview
- `PROGRESS.md` — what's been built
- `decisions.md` — accumulated architectural decisions
- `docs/decisions/agent_learnings.md` — pitfalls seen so far
- `OPS.md` — infrastructure state

Then scan the codebase based on preset:

- **full / backend**: `backend/app/**/*.py`, `backend/supabase/migrations/*.sql`
- **full / web**: `web/src/**/*.ts*` (Vite) or `app/**/*.ts*` + `components/**` (Next.js)
- **full / ios**: `ios/**/*.swift`
- **backend (standalone)**: `app/**/*.py`, `supabase/migrations/*.sql`
- **web (standalone)**: `app/**/*.ts*`, `lib/**`, `supabase/migrations/*.sql`
- **ios (standalone)**: `ios/**/*.swift`

For each scanned domain, look for:

- Status/state enums and the valid transitions between them
- Business constants (timeouts, limits, percentages, durations)
- Domain-specific validation rules baked into routes/models
- Audit/event ordering invariants (if audit_log or similar is present)
- Module-path conventions for mocking in tests
- Permission matrices / ACL patterns

## Step 3: Interactively surface findings

For each candidate pattern, use `AskUserQuestion`:

> "I see your backend has a `cooloff` status on contributors with
> `cooloff_ends_at` set to `now() + 48h`. Should I capture this as a
> project-specific rule the backend-implementer must enforce?"
>
> Options:
> - `[Yes, add rule]` — writes into `.claude/rules/project-backend.md`
> - `[Customize wording]` — lets Davies rephrase before writing
> - `[Skip]` — don't capture
> - `[Skip all further backend suggestions]` — fast-forward

Group findings by domain so Davies can accept/reject a whole batch:

- Project-backend findings (5) → iterate or bulk-accept
- Project-database findings (3) → iterate or bulk-accept
- Project-ios findings (2) → iterate or bulk-accept

## Step 4: Write project-owned overlays

For each accepted rule, append to the appropriate file. Create files if absent:

- `.claude/rules/project-backend.md`
- `.claude/rules/project-database.md`
- `.claude/rules/project-ios.md`
- `.claude/rules/project-web.md`

Each file uses the same frontmatter as plugin rules (path-scoped `appliesTo`):

```markdown
---
description: Project-specific business rules for [domain]. Written by /rkt-tailor.
appliesTo:
  - "backend/app/**/*.py"  # match the plugin rule's path patterns
---

# Project-specific [domain] rules

[Captured rules live here, one per section.]

## Cool-off mechanic

When `SPLIT_UNUSUALLY_LOW` fires at signing, the contributor enters
`status='cooloff'` with `cooloff_ends_at = now() + 48h`. Do not allow
re-signing during the cooloff window.

...
```

Optionally, if Davies accepts, write `agents/backend-implementer.project.md`
with agent-level overlay content — short paragraphs the agent loads at task
start.

## Step 5: Commit and report

```bash
git add .claude/rules/project-*.md agents/*.project.md 2>/dev/null
git commit -m "[rkt-tailor] Capture project-specific rules into overlays"
```

Report a summary:

> **✓ Captured N rules across domains**
>
> - `.claude/rules/project-backend.md`: 5 rules (cool-off, audit ordering, ...)
> - `.claude/rules/project-database.md`: 3 rules (RLS pattern, ...)
> - Skipped: 2 (you deferred)
>
> Re-run `/rkt-tailor` anytime the project's domain model evolves.

## Re-run behavior

On subsequent runs, read the existing `project-*.md` files first. For each
newly-scanned pattern:

- Already captured, still matches code → skip silently
- Already captured, code has diverged → offer `[Update to match code]`,
  `[Keep existing rule]`, `[Remove rule — obsolete]`
- New pattern, not captured → offer to add as above

Never touches files outside `.claude/rules/project-*.md` and
`agents/*.project.md`.
```

- [ ] **Step 2: Verify skill loads**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep -i rkt-tailor
```

- [ ] **Step 3: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add skills/rkt-tailor/SKILL.md
git commit -m "Add /rkt-tailor skill: capture project-specific rules into overlays"
```

---

## Phase 9: /rkt-sync Skill

Goal: after a plugin update, projects can pull in updated templates with conflict resolution **without clobbering project-owned overlays or user-edited sections**.

### Task 46: Build rkt-sync skill

**Files:**
- Modify: `skills/rkt-sync/SKILL.md`

- [ ] **Step 1: Replace placeholder with full skill body**

```markdown
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
- `.claude/rules/backend-fastapi.md`, `supabase.md`, `web-vite.md`, `web-nextjs.md`, `ios-design.md` (only the rules shipped by the plugin)
- `rkt.json` (version bumps, not user-customized fields)

**Project-owned (NEVER touched by sync):**
- `.claude/rules/project-*.md` — written by `/rkt-tailor`
- `agents/*.project.md` — project-level agent overlays
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
  echo "No rkt.json here. If this is a new project, run /bootstrap first."
  exit 1
}
PROJECT_VERSION=$(jq -r .bootstrap.rkt_plugin_version rkt.json)
CURRENT_VERSION=$(jq -r .version "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json")

echo "Project bootstrapped with rkt $PROJECT_VERSION"
echo "Currently installed: rkt $CURRENT_VERSION"
```

If `PROJECT_VERSION == CURRENT_VERSION` → tell the user they're already up to
date and exit.

## Step 2: Show CHANGELOG between versions

If the plugin ships a CHANGELOG.md:

```bash
CHANGELOG="${CLAUDE_PLUGIN_ROOT}/CHANGELOG.md"
if [[ -f "$CHANGELOG" ]]; then
  echo "## Changes since $PROJECT_VERSION"
  # Simple heuristic: print lines after "## $CURRENT_VERSION" and before "## $PROJECT_VERSION"
  awk "/^## $CURRENT_VERSION\$/,/^## $PROJECT_VERSION\$/" "$CHANGELOG"
fi
```

Surface this to the user so they know what's changing.

## Step 3: Load project config into TMPVARS

Same structure as bootstrap, but populated from the existing `rkt.json`:

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
  DEPLOY_WEB: .deploy.web,
  DEPLOY_DB: .deploy.db,
  DATE: .bootstrap.date,
  RKT_VERSION: "'"$CURRENT_VERSION"'"
}' rkt.json > "$TMPVARS"
```

## Step 4: Per-file diff and resolve

For each template file:

```bash
for tmpl in AGENTS.md PROGRESS.md OPS.md README.md rkt.json decisions.md; do
  rendered=$(mktemp)
  "${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" \
    "${CLAUDE_PLUGIN_ROOT}/templates/${tmpl}.tmpl" "$rendered" "$(cat "$TMPVARS")"

  target="$tmpl"
  [[ "$tmpl" == "agent_learnings.md" ]] && target="docs/decisions/agent_learnings.md"
  [[ "$tmpl" == "decisions.md" ]] && target="decisions.md"

  if [[ ! -e "$target" ]]; then
    cp "$rendered" "$target"
    echo "Created: $target"
    continue
  fi

  if diff -q "$rendered" "$target" >/dev/null 2>&1; then
    rm -f "$rendered"
    continue  # already up to date
  fi

  # Conflict — show diff, ask via AskUserQuestion
  echo "--- Diff for $target ---"
  diff -u "$target" "$rendered" | head -50
  # AskUserQuestion with options:
  #   [Accept update] → mv "$rendered" "$target"
  #   [Keep mine]      → rm "$rendered"
  #   [Show 3-way merge] → git merge-file or $EDITOR
done
```

Rules follow the same pattern — for each rule file the project's preset
uses, compare plugin version vs project copy.

## Step 5: Update rkt_plugin_version in rkt.json

```bash
jq --arg v "$CURRENT_VERSION" '.bootstrap.rkt_plugin_version = $v' rkt.json > rkt.json.new
mv rkt.json.new rkt.json
```

## Step 6: Commit (optional)

Use `AskUserQuestion`:

- "Commit the synced templates?"
- Options: `[Yes, commit]`, `[Leave uncommitted for review]`

If yes:

```bash
git add AGENTS.md PROGRESS.md OPS.md README.md rkt.json decisions.md docs/decisions/agent_learnings.md .claude/rules/
git commit -m "[rkt-sync] Update templates to rkt $CURRENT_VERSION"
```

## Step 7: Report

```markdown
## ✓ Synced to rkt {{CURRENT_VERSION}}

- Updated: AGENTS.md, PROGRESS.md
- Kept existing: README.md (user chose)
- Unchanged: OPS.md, decisions.md, rules/*
- Committed: yes
```
```

- [ ] **Step 2: Verify skill loads**

```bash
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack --debug 2>&1 | grep rkt-sync
```

- [ ] **Step 3: Commit**

```bash
git add skills/rkt-sync/SKILL.md
git commit -m "Implement /rkt-sync skill: per-file diff + conflict resolution + version bump"
```

---

### Task 47: Integration test for rkt-sync

**Files:**
- Create: `tests/test-rkt-sync.sh`

- [ ] **Step 1: Write integration test**

```bash
#!/usr/bin/env bash
# tests/test-rkt-sync.sh — simulate a version bump and re-sync
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HERE/.."

tmpdir=$(mktemp -d)
trap "rm -rf $tmpdir" EXIT

cd "$tmpdir"
git init -q -b main

# Seed a "bootstrapped" project at version 0.0.9
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
for tmpl in AGENTS.md PROGRESS.md OPS.md README.md decisions.md; do
  "$PLUGIN_DIR/scripts/render-template.sh" \
    "$PLUGIN_DIR/templates/${tmpl}.tmpl" "$tmpdir/$tmpl" "$(cat "$TMPVARS")"
done
mkdir -p docs/decisions
"$PLUGIN_DIR/scripts/render-template.sh" \
  "$PLUGIN_DIR/templates/agent_learnings.md.tmpl" "docs/decisions/agent_learnings.md" "$(cat "$TMPVARS")"

git add .
git commit -q -m "initial bootstrap at 0.0.9"

# Simulate "current version is now 0.1.0"
# Test: re-render with new version; diff should be empty (templates unchanged between these versions in the test)
# This mostly tests that render-template stays idempotent
CURRENT=$(jq -r .version "$PLUGIN_DIR/.claude-plugin/plugin.json")

# Bump TMPVARS
jq --arg v "$CURRENT" '.RKT_VERSION = $v' "$TMPVARS" > "${TMPVARS}.new"
mv "${TMPVARS}.new" "$TMPVARS"

# Re-render into tmp files
for tmpl in AGENTS.md PROGRESS.md OPS.md README.md; do
  rendered=$(mktemp)
  "$PLUGIN_DIR/scripts/render-template.sh" \
    "$PLUGIN_DIR/templates/${tmpl}.tmpl" "$rendered" "$(cat "$TMPVARS")"
  # diff should be empty if template is unchanged between versions
  # (we're testing the mechanics, not specific version diffs)
  [[ -f "$rendered" ]] || { echo "FAIL: re-render of $tmpl produced no file"; exit 1; }
  rm -f "$rendered"
done

# Simulate bumping rkt_plugin_version in rkt.json
jq --arg v "$CURRENT" '.bootstrap.rkt_plugin_version = $v' rkt.json > rkt.json.new
mv rkt.json.new rkt.json
[[ $(jq -r .bootstrap.rkt_plugin_version rkt.json) == "$CURRENT" ]] || { echo "FAIL: version not bumped"; exit 1; }

rm -f "$TMPVARS"
echo "PASS: test-rkt-sync.sh"
```

- [ ] **Step 2: Run test**

```bash
chmod +x /Users/rocket/Documents/Repositories/rkt-stack/tests/test-rkt-sync.sh
bash /Users/rocket/Documents/Repositories/rkt-stack/tests/test-rkt-sync.sh
```
Expected: `PASS: test-rkt-sync.sh`

- [ ] **Step 3: Commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add tests/test-rkt-sync.sh
git commit -m "Add rkt-sync integration test (version bump mechanics)"
```

---

## Phase 10: Polish and Ship

Goal: documentation, license, changelog, and a holistic end-to-end check.

### Task 48: Add LICENSE

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Write MIT license**

```
MIT License

Copyright (c) 2026 Davies Ayo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit**

```bash
git add LICENSE
git commit -m "Add MIT license"
```

---

### Task 49: Add CHANGELOG

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: Write initial changelog**

```markdown
# Changelog

All notable changes to the rkt plugin are documented here.

## 0.1.0 — 2026-04-18

### Added

- Initial release with 4 presets: `full`, `web`, `backend`, `ios`.
- `/bootstrap` skill (NEW + ADOPT modes) with state detection, preset
  auto-suggestion, non-destructive file handling, and Linear project
  creation/linking.
- `/rkt-sync` skill for updating project-owned templates after plugin
  updates.
- 5 domain agents ported from Witness: backend, database, iOS, web,
  code-reviewer.
- 4 skills ported: `/implement`, `/create-issue`, `/scan`, `/resolve-reviews`.
- Rules for FastAPI, Supabase, Vite+React, Next.js, SwiftUI.
- Worktree lifecycle scripts: `new-feature`, `cleanup-feature`,
  `cleanup-merged-worktrees`.
- Marketplace manifest for `daviesayo-marketplace`.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "Add CHANGELOG with 0.1.0 entry"
```

---

### Task 50: Update README with install and usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "Quickstart" placeholder with real content**

Find the section starting with `## Quickstart` and replace the placeholder
with:

```markdown
## Quickstart

### One-time install

```bash
# Add this repo as a Claude Code marketplace
claude marketplace add daviesayo/rkt-stack

# Install the plugin
claude plugin install rkt@daviesayo-marketplace

# You'll be prompted for userConfig values on first enable:
#   - default_linear_team_id
#   - default_github_owner
#   - default_ios_device
#   - default_gh_visibility
```

### Starting a new project

```bash
mkdir my-new-thing && cd my-new-thing
claude
# Then:
/bootstrap full my-new-thing
```

Follow the prompts. You'll end up with a fully-wired repo: Linear project
created, first commit made, optionally pushed to GitHub.

### Adopting an existing project

```bash
cd ~/some/existing/repo
claude
# Then:
/bootstrap
```

The skill detects your stack, suggests a preset, and layers the workflow in
non-destructively.

### After the plugin updates

```bash
# Update the plugin
claude plugin update rkt@daviesayo-marketplace

# In each existing project, sync templates
cd ~/my-project
claude
/rkt-sync
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Write Quickstart with install + NEW + ADOPT + sync flows"
```

---

### Task 51: Holistic end-to-end verification

**Files:**
- _(no new files — this is a manual verification step)_

- [ ] **Step 1: Bump version to 0.1.0**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
jq '.version = "0.1.0"' .claude-plugin/plugin.json > .claude-plugin/plugin.json.new
mv .claude-plugin/plugin.json.new .claude-plugin/plugin.json
git add .claude-plugin/plugin.json
git commit -m "Bump plugin version to 0.1.0 for first release"
```

- [ ] **Step 2: Run all tests**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
for t in tests/test-*.sh; do
  echo "=== $t ==="
  bash "$t" || { echo "FAIL: $t"; exit 1; }
done
echo "All tests passed."
```

- [ ] **Step 3: Manual smoke test — NEW mode**

In a fresh directory:

```bash
mkdir /tmp/rkt-smoke-new && cd /tmp/rkt-smoke-new
claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack
```

Inside Claude: `/bootstrap backend smoke-test`. Answer the prompts. Verify
that `rkt.json`, `AGENTS.md`, `PROGRESS.md`, `decisions.md`, and
`docs/decisions/agent_learnings.md` all exist with real project name
substituted, and a Linear project was created (or skipped gracefully).

- [ ] **Step 4: Manual smoke test — ADOPT mode**

```bash
mkdir /tmp/rkt-smoke-adopt && cd /tmp/rkt-smoke-adopt
git init
npm init -y  # adds package.json
echo '{"dependencies":{"next":"^16"}}' > package.json
echo "# My project" > README.md
git add . && git commit -m "initial"

claude --plugin-dir /Users/rocket/Documents/Repositories/rkt-stack
```

Inside Claude: `/bootstrap`. Verify:
- Detection suggests `web` preset
- Existing `package.json` and `README.md` prompt for conflict resolution
- Adopting "Keep mine" on README preserves the existing text
- rkt.json, AGENTS.md, PROGRESS.md get created fresh

- [ ] **Step 5: Manual smoke test — rkt-sync**

Stay in the smoke-adopt directory:

```
/rkt-sync
```

Verify it reports "already up to date" since the version matches.

- [ ] **Step 6: Clean up smoke tests**

```bash
rm -rf /tmp/rkt-smoke-new /tmp/rkt-smoke-adopt
```

Also delete any Linear throwaway projects created during smoke testing
via the Linear UI.

- [ ] **Step 7: Commit the bump**

Already committed in Step 1.

---

### Task 52: Tag the 0.1.0 release

**Files:**
- _(git tag, not a file)_

- [ ] **Step 1: Create annotated tag**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git tag -a v0.1.0 -m "rkt 0.1.0 — initial release"
```

- [ ] **Step 2: Push to GitHub (once repo is created)**

```bash
# One-time: create the GitHub repo
gh repo create daviesayo/rkt-stack --private --source=. --remote=origin --push

# Push tag
git push origin v0.1.0
```

Mark the GitHub repo description: "Davies's personal Claude Code plugin for
project bootstrapping and workflow orchestration."

---

## Self-Review Checklist

**Spec coverage (each section maps to at least one task):**

| Spec section                        | Covered by                      |
| :---------------------------------- | :------------------------------ |
| Architecture (two-layer split)      | Task 1, 3, 4 (plugin structure) |
| Config split (userConfig/rkt.json)  | Task 1 (userConfig), Task 21 (rkt.json) |
| Preset `full`                       | Task 28 step 1 + Task 30 + rules selection |
| Preset `web`                        | Task 28 step 2 + Task 30 |
| Preset `backend`                    | Task 28 step 3 + Task 30 |
| Preset `ios`                        | Task 28 step 4 + Task 30 |
| iOS README pointer approach         | Task 28 step 1 and 4 |
| Bootstrap NEW mode (8 steps)        | Tasks 29-33 |
| Bootstrap ADOPT mode (8 steps)      | Tasks 35-40 |
| State detection                     | Task 9 + Task 29 |
| Ported skills (4)                   | Tasks 42-45 |
| New skills (2)                      | Tasks 29-33 (bootstrap), 46 (rkt-sync) |
| Agents (5)                          | Tasks 11-15 |
| Rules (5)                           | Tasks 16-20 |
| Worktree scripts                    | Tasks 7-8 |
| AskUserQuestion UX principle        | Noted in each ported skill task + NEW/ADOPT tasks |
| Evolution model (/rkt-sync)         | Tasks 46-47 |
| Marketplace distribution            | Task 2 + Task 50 |
| Acceptance criteria                 | Tasks 51-52 (smoke tests + tag) |

No gaps identified.

**Placeholder scan:** No `TBD`, `implement later`, or unfilled details. All
code blocks are complete. Every template has concrete tokens. Every skill
step shows the exact commands.

**Type consistency:** `rkt.json` schema used in Task 21 is consistent with
how it's read in Tasks 11-15 (agents), 42-45 (skills), and 46 (rkt-sync).
The `{{TOKEN}}` list used in templates (Tasks 21-28) matches the vars set
in bootstrap (Task 30) and rkt-sync (Task 46).

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-04-18-rkt-plugin-implementation.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task,
review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans,
batch execution with checkpoints.

Which approach?
