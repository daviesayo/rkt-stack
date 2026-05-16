---
name: bootstrap
description: Use to scaffold a new project (greenfield) or adopt an existing one into Davies's rkt workflow. Accepts optional args `[preset] [name]`. Triggers on "bootstrap this", "bootstrap ios", "new project", "set up this repo with rkt", "adopt this project", "apply rkt to this directory".
---

# Bootstrap

You scaffold a new project or adopt an existing one into Davies's rkt workflow.
You run in the target directory (the user has already `cd`'d there).

## Host portability

Before referencing bundled rkt files, resolve the plugin root:

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
```

In Claude Code, `CLAUDE_PLUGIN_ROOT` normally supplies this path. In Codex or
local development contexts, resolve `<installed-rkt-plugin-root>` to the real
rkt plugin package root, usually the directory containing `.codex-plugin/`,
`skills/`, `scripts/`, and `templates/`.

For interactive prompts, use the host's native structured question tool when
available; if the host lacks one, ask a concise direct question and wait.

**Two modes, chosen by state detection:**

- **NEW** — target directory is empty (or close to it). Greenfield scaffolding.
- **ADOPT** — target directory has existing code/.git. Non-destructive layering.
- **Already bootstrapped** — target directory has `rkt.json`. Short-circuit to `/rkt-sync`.

## Step 0: State detection

Before doing anything else, scan the target directory:

```bash
TARGET="$(pwd)"
DETECT_OUTPUT=$("${RKT_PLUGIN_ROOT}/scripts/detect-stack.sh" "$TARGET")
echo "$DETECT_OUTPUT"
```

Parse the JSON output:
- If `signals.has_rkt_json == true` → tell the user the project is already
  bootstrapped and suggest `/rkt-sync`. Stop here.
- If `signals.has_git == true` OR `signals.has_claude_md == true` OR `signals.has_agents_md == true` OR any
  stack signals fired → **ADOPT mode** (see Step A1 and beyond)
- Otherwise → **NEW mode** (see Step N1 and beyond)

Announce the chosen mode to the user before proceeding.

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

Do **not** auto-install — that's deferred. Use the host's native structured question tool with options
`[Proceed anyway]` and `[Cancel]` to ask whether to continue, noting which steps
will be skipped due to missing tools.

### Step N2: Gather config

Use the host's native structured question tool for every prompt — never use bash `read` or plain text
questions.

**Preset** (if not passed as arg):

Use the host's native structured question tool with:
- Question: "Which preset?"
- Options: `full`, `web`, `backend`, `ios`
- Multi-select: false

**Project name** (if not passed as arg):

Use the host's native structured question tool as a free-text prompt. Validate the response: it must
match `[a-z][a-z0-9-]*`. Derive `{{PROJECT_NAME_PASCAL}}` from it (e.g.
`my-new-thing` → `MyNewThing`) by title-casing each hyphen-separated segment
and joining without separators.

**Linear team** *(must run BEFORE the issue-prefix prompt — the team key
is the canonical source of truth for `LINEAR_PREFIX`, and asking the user
to type one only to override it later is bad UX):*

Query available teams:

```bash
linear api <<< 'query { teams { nodes { id key name } } }' | jq -r '.data.teams.nodes'
```

- If 1 team → auto-use it, no prompt needed
- If >1 team → use the host's native structured question tool with team names as options
- If 0 teams → stop with an actionable error: "No Linear teams found. Create a
  team at linear.app first, or re-run after setting up Linear."

Capture the chosen team's `key` field (e.g. `RKT`, `MCO`) as
`LINEAR_TEAM_KEY` — Linear identifies issues by team key, not by project
name, so this is what `/rkt:implement` will use to build branches and PR
titles (`${LINEAR_TEAM_KEY}-42/...`).

**Issue prefix**:

Default to `LINEAR_TEAM_KEY` from the previous step. Only fall back to the
project-name derivation (`derive_prefix` in
`${RKT_PLUGIN_ROOT}/scripts/lib/common.sh`) when Linear is unavailable
(`linear` CLI missing, or user explicitly skips Linear later). Present as
a confirmation:

> "Use Linear team key `RKT` as the issue prefix? This is what Linear's
> GitHub integration auto-links on, so it must match exactly."
>
> Use the host's native structured question tool with options: `[Accept RKT]`, `[Customize]`,
> `[Cancel]`.

If the user picks `[Customize]`, **warn loudly** that any prefix other than
the team key will break Linear ↔ GitHub auto-linking. The failure mode is
silent: a project named `wdyd` under team `RKT` would bootstrap with prefix
`WDYD`, and every subsequent `gh pr create --title "[WDYD-42] ..."` would
fail to auto-attach to the matching `RKT-42` Linear issue.

**GitHub repo**:

Use the host's native structured question tool with options: `[Create private]`, `[Create public]`,
`[Skip]`. Default to `${CLAUDE_PLUGIN_OPTION_DEFAULT_GH_VISIBILITY}` if that
env var is set.

**MemPalace specialist prefix**:

Use the host's native structured question tool with options: `[Use project name (slugified)]`,
`[Customize]`. Default is the project name slugified (same as PROJECT_NAME).

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
  "LINEAR_PROJECT_ID": "",
  "LINEAR_PROJECT_URL": "",
  "MEMPALACE_PREFIX": "...",
  "GH_VISIBILITY": "...",
  "DEPLOY_BACKEND": "...",
  "DEPLOY_WEB": "...",
  "DEPLOY_DB": "...",
  "DATE": "$(date +%Y-%m-%d)",
  "RKT_VERSION": "$(jq -r .version "${RKT_PLUGIN_ROOT}/.claude-plugin/plugin.json")"
}
EOF
```

Populate the `DEPLOY_*` fields per preset:
- `full`: `DEPLOY_BACKEND=railway`, `DEPLOY_WEB=vercel`, `DEPLOY_DB=supabase`
- `web`: `DEPLOY_BACKEND=null`, `DEPLOY_WEB=vercel`, `DEPLOY_DB=supabase`
- `backend`: `DEPLOY_BACKEND=railway`, `DEPLOY_WEB=null`, `DEPLOY_DB=supabase`
- `ios`: `DEPLOY_BACKEND=null`, `DEPLOY_WEB=null`, `DEPLOY_DB=null`

### Step N3: Scaffold folders

Copy the chosen preset's folder skeleton into the target directory:

```bash
PRESET=$(jq -r .PRESET "$TMPVARS")
SCAFFOLD="${RKT_PLUGIN_ROOT}/templates/presets/$PRESET"
cp -R "$SCAFFOLD/." "$TARGET/"
```

After copying, render tokens in each newly-copied file. Walk the target
directory and for every file containing `{{...}}` tokens, run
`render-template.sh` with the vars.

(Use `find` + `grep -l` to identify token-bearing files to avoid re-rendering
binary assets.)

```bash
find "$TARGET" -type f ! -path "*/.git/*" | while IFS= read -r f; do
  if grep -q '{{' "$f" 2>/dev/null; then
    tmp="$f.rendered"
    "${RKT_PLUGIN_ROOT}/scripts/render-template.sh" "$f" "$tmp" "$(cat "$TMPVARS")"
    mv "$tmp" "$f"
  fi
done
```

### Step N4: Render global templates

For each global template in `${RKT_PLUGIN_ROOT}/templates/` with a `.tmpl`
extension, render it into the target directory without the `.tmpl` suffix:

```bash
TEMPLATES="${RKT_PLUGIN_ROOT}/templates"
for tmpl in CLAUDE.md PROGRESS.md OPS.md README.md rkt.json; do
  "${RKT_PLUGIN_ROOT}/scripts/render-template.sh" \
    "$TEMPLATES/${tmpl}.tmpl" "$TARGET/$tmpl" "$(cat "$TMPVARS")"
done

# decisions.md and agent_learnings.md go in specific subfolders
mkdir -p "$TARGET/docs/decisions"
"${RKT_PLUGIN_ROOT}/scripts/render-template.sh" \
  "$TEMPLATES/decisions.md.tmpl" "$TARGET/decisions.md" "$(cat "$TMPVARS")"
"${RKT_PLUGIN_ROOT}/scripts/render-template.sh" \
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
  cp "${RKT_PLUGIN_ROOT}/rules/${rule}.md" "$TARGET/.claude/rules/${rule}.md"
done
```

### Step N5: git init + first commit

```bash
cd "$TARGET"
git init -b main
git add .
git commit -m "[bootstrap] Initialize $(jq -r .PROJECT_NAME "$TMPVARS") ($(jq -r .PRESET "$TMPVARS"))"
```

Report the commit SHA back to the user:

```bash
FIRST_SHA=$(git rev-parse --short HEAD)
echo "First commit: $FIRST_SHA"
```

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

After the remote is connected (whether just-created or pre-existing), sync
the canonical rkt label set onto it:

```bash
"${RKT_PLUGIN_ROOT}/scripts/sync-github-labels.sh"
```

The script is a no-op when no `origin` remote exists, so it's safe to call
unconditionally. This ensures the labels referenced by `/rkt:create-issue`
and `/rkt:implement` (`Feature`, `Bug`, `Improvement`, `Ops`, `Docs`,
`Backend`, `Database`, `iOS`, `Web`, `Blocked`) exist on the repo before any
agent tries `gh pr create --label …`.

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

- `CLAUDE.md` — agent conventions (already tailored to your preset)
- `rkt.json` — project config (Linear prefix, deploy targets, mempalace prefix)
- `PROGRESS.md` — update as you work
```

Substitute the actual values (PROJECT_NAME, PRESET, LINEAR_PROJECT_URL, github
URL, commit SHA) into the report before presenting it. If LINEAR_PROJECT_URL is
empty, display "failed — retry later". If GitHub was skipped, display "skipped".

---

## ADOPT mode

### Step A1: Preflight

Same as Step N1 — check that `git`, `gh`, `linear`, and `jq` are installed.
Warn on any that are missing with the same table and the host's native structured question tool offering
`[Proceed anyway]` or `[Cancel]`.

### Step A2: Detect stack and confirm preset

Re-use the detection output captured in Step 0:

```bash
SUGGESTED=$(echo "$DETECT_OUTPUT" | jq -r .suggested_preset)
```

Use the host's native structured question tool to confirm:

- If `SUGGESTED` is not `null`:
  - Question: "I detected `{{detected signals summary}}`. Apply `{{SUGGESTED}}` preset?"
  - Options: `[Yes, apply {{SUGGESTED}}]`, `[Different preset]`, `[Cancel]`
  - If the user picks `[Different preset]`, follow up with a second
    the host's native structured question tool offering the full preset menu: `full`, `web`,
    `backend`, `ios`.
- If `SUGGESTED` is `null` (no signals matched):
  - Question: "Couldn't auto-detect the stack. Which preset?"
  - Options: `full`, `web`, `backend`, `ios`, `[Cancel]`

Write the confirmed preset into `TMPVARS.PRESET` exactly as in NEW mode.

### Step A3: Gather remaining config

Prompts are the same as NEW Step N2, with these ADOPT-specific differences:

- **Project name:** default to the current directory basename (`basename "$(pwd)"`).
  Offer override via the host's native structured question tool with the basename pre-filled as the
  suggested value.
- **GitHub repo:** if `signals.has_remote == true` (detected in Step 0), default
  to `[Skip]` — the remote already exists. Otherwise offer the normal
  `[Create private]` / `[Create public]` / `[Skip]` menu.
- **Issue prefix:** **defer this prompt until Step A6** — the canonical source
  for the prefix is the Linear team key (whether linking an existing project or
  creating a new one). For ADOPT mode, asking before Linear is resolved would
  almost certainly produce a wrong answer. Set a placeholder in TMPVARS for now
  and overwrite in Step A6.
- **MemPalace prefix:** default to the project name (slugified). Offer override
  via the host's native structured question tool.
- **Linear:** handled separately in Step A6 — ADOPT has the "link existing"
  path that NEW mode does not.

Populate `TMPVARS` identically to NEW Step N2. Default `DEPLOY_*` fields by
preset using the same mapping as NEW Step N2.

### Step A4: Additive scaffold (fill gaps only)

For every file in `templates/presets/{PRESET}/`, compare against the target.
Create missing files; **never overwrite existing ones**. Never delete anything.

**Special case — Next.js `src/` directory layout.** When the target uses
`src/app/` (Next.js's "src directory" feature, surfaced as
`signals.nextjs_layout == "src"` from Step 0 detection), the preset's
root-level `app/` and `lib/` directories must NOT be scaffolded — they
would create a parallel route tree at the root and break the Next.js
build. Skip those preset paths and report each skip in Step A8.

```bash
PRESET=$(jq -r .PRESET "$TMPVARS")
SCAFFOLD="${RKT_PLUGIN_ROOT}/templates/presets/$PRESET"

# Track every path bootstrap creates so Step A7 can stage them surgically
# (initialize once per bootstrap; A4 and A5 both append to it).
STAGED_PATHS="${STAGED_PATHS:-$(mktemp)}"

# Decide whether to skip preset's root-level app/ and lib/ for src/-layout
# Next.js projects.
NEXTJS_LAYOUT=$(echo "$DETECT_OUTPUT" | jq -r '.signals.nextjs_layout // "none"')
SKIP_ROOT_APP_LIB="false"
if [[ "$PRESET" == "web" && "$NEXTJS_LAYOUT" == "src" ]]; then
  SKIP_ROOT_APP_LIB="true"
fi

(cd "$SCAFFOLD" && find . -type f ! -path "./.*") | while read -r rel; do
  rel_clean="${rel#./}"
  if [[ "$SKIP_ROOT_APP_LIB" == "true" ]]; then
    case "$rel_clean" in
      app/*|lib/*)
        echo "  [skip] $rel_clean — project uses src/ layout"
        continue
        ;;
    esac
  fi
  dest="$TARGET/$rel_clean"
  if [[ ! -e "$dest" ]]; then
    mkdir -p "$(dirname "$dest")"
    if grep -q '{{' "$SCAFFOLD/$rel" 2>/dev/null; then
      "${RKT_PLUGIN_ROOT}/scripts/render-template.sh" \
        "$SCAFFOLD/$rel" "$dest" "$(cat "$TMPVARS")"
    else
      cp "$SCAFFOLD/$rel" "$dest"
    fi
    echo "$rel_clean" >> "$STAGED_PATHS"
  fi
  # If file exists → skip. Step A5 handles global template conflicts.
done
```

This step only fills structural gaps in the project layout. It does **not**
handle CLAUDE.md, PROGRESS.md, OPS.md, rkt.json, or any other global template —
those are handled by Step A5 with per-file conflict resolution.

### Step A5: Render global templates with per-file conflict resolution

For each of the following files, render from template and compare to the
existing file (if any):

- `CLAUDE.md`
- `PROGRESS.md`
- `OPS.md`
- `README.md`
- `rkt.json`
- `decisions.md`
- `docs/decisions/agent_learnings.md`
- `.claude/rules/*.md` (the subset applicable to the chosen preset)

**Resolution logic per file:**

1. Render the template into a temp file.
2. If the destination does not exist → create it (move rendered temp into place).
3. If the destination is identical to the rendered output → skip silently.
4. If they differ → a conflict exists. Use the host's native structured question tool with these options:
   - `[Keep mine]` — leave the existing file untouched; discard the rendered copy
   - `[Replace]` — overwrite the existing file with the rendered version
   - `[Merge (3-way)]` — run `git merge-file` (or open `$EDITOR` with conflict
     markers); accept the result on save
   - `[Skip]` — same as Keep mine but flag the file in the Step A8 report

Process all templates before prompting, so the user sees one conflict question
per file rather than a batch dialog.

Track outcomes for Step A8:

```bash
# Outcomes accumulate per file:
# "created", "identical_skip", "replaced", "kept_mine", "merged", "skipped"
```

When a resolution results in the destination being **created**, **replaced**,
or **merged**, also append the destination path to `$STAGED_PATHS` (the same
file Step A4 initialized). Step A7 stages only the paths in this file —
files that were `kept_mine`, `identical_skip`, or `skipped` must NOT be
appended, since the user explicitly opted to leave them untouched.

**Preset → rules mapping** (same as NEW Step N4):

| Preset    | Rules copied                                    |
| :-------- | :---------------------------------------------- |
| `full`    | `backend-fastapi`, `supabase`, `web-vite`, `ios-design` |
| `web`     | `web-nextjs`, `supabase`                        |
| `backend` | `backend-fastapi`, `supabase`                   |
| `ios`     | `ios-design`                                    |

Rules are treated the same as other templates: create if absent, skip if
identical, prompt if different.

### Step A6: Linear — link existing or create new

Use the host's native structured question tool:

- Question: "Is there an existing Linear project for this repo?"
- Options: `[Link existing (paste URL)]`, `[Create new]`, `[Skip Linear]`

In all three branches, the **issue prefix in `TMPVARS.LINEAR_PREFIX` must be
set from the resolved Linear team key**, not from the project name. The team
key is what Linear's GitHub integration auto-links on; a mismatch produces a
silent failure (PRs don't attach to issues).

**If `[Link existing (paste URL)]`:**

- Follow up with a free-text prompt through the host's native structured question tool for the Linear project URL.
- Parse the project ID from the URL. Linear project URLs follow the form:
  `https://linear.app/<workspace>/project/<slug>-<uuid>`
- Fetch project details to confirm the project and extract team info:

  ```bash
  linear api --variable projectId="$PROJECT_ID" <<'GRAPHQL'
  query($projectId: String!) {
    project(id: $projectId) {
      id name url
      teams { nodes { id key } }
    }
  }
  GRAPHQL
  ```

- Store `LINEAR_PROJECT_ID`, `LINEAR_PROJECT_URL`, `LINEAR_TEAM_ID`, and
  `LINEAR_PREFIX` (from `team.key`) into `TMPVARS`.

**If `[Create new]`:**

- Pick the Linear team first (same prompt as NEW Step N2 — auto-use if 1
  team, the host's native structured question tool if multiple). Store `team.id` as `LINEAR_TEAM_ID`
  and **`team.key` as `LINEAR_PREFIX`** in `TMPVARS`.
- Run the same `projectCreate` GraphQL mutation as NEW Step N6 with the
  resolved `LINEAR_TEAM_ID`.
- Store `LINEAR_PROJECT_ID` and `LINEAR_PROJECT_URL` in `TMPVARS`.

**If `[Skip Linear]`:**

- Set `linear.project_id` and `linear.project_url` to empty strings in
  `rkt.json`. Skills degrade gracefully when these are absent (`require_linear`
  fails fast with an actionable error).
- For `LINEAR_PREFIX`, fall back to the `derive_prefix` heuristic on the git
  remote slug (preferred) or directory basename. Surface a follow-up
  the host's native structured question tool confirming the derived value with `[Accept]` / `[Customize]`
  options, and warn that linking Linear later via `/rkt-tailor` will likely
  rewrite this prefix to match the team key.

After Step A6 resolves, **re-render `CLAUDE.md` and `rkt.json`** with the
updated `TMPVARS` so the prefix tokens (`{{LINEAR_PREFIX}}`) reflect the
canonical value:

```bash
"${RKT_PLUGIN_ROOT}/scripts/render-template.sh" \
  "${RKT_PLUGIN_ROOT}/templates/rkt.json.tmpl" \
  "$TARGET/rkt.json" "$(cat "$TMPVARS")"

# CLAUDE.md only re-renders if the user accepted Replace/Merge in Step A5.
# If they kept their own CLAUDE.md, the warning in Step A8 covers prefix drift.
if grep -q "{{LINEAR_PREFIX}}" "$TARGET/CLAUDE.md" 2>/dev/null; then
  "${RKT_PLUGIN_ROOT}/scripts/render-template.sh" \
    "${RKT_PLUGIN_ROOT}/templates/CLAUDE.md.tmpl" \
    "$TARGET/CLAUDE.md" "$(cat "$TMPVARS")"
fi
```

### Step A7: Commit on existing history (surgical staging)

Stage **only** the paths that bootstrap itself created or modified — never
`git add .`. The list of paths lives in `$STAGED_PATHS`, populated by
Steps A4 and A5. Pre-existing dirty work on tracked files (an unrelated
in-flight feature, debug edits, etc.) must stay unstaged so it doesn't get
swallowed into the bootstrap commit with wrong attribution.

```bash
cd "$TARGET"

# Handle the rare ADOPT case where the target has no git history yet.
if [[ ! -d "$TARGET/.git" ]]; then
  git init -b main
fi

# Surface pre-existing modifications to tracked files. Surgical staging
# below won't include them, but the user should see what they are.
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  DIRTY=$(git diff HEAD --name-only 2>/dev/null | head -10 || true)
  if [[ -n "$DIRTY" ]]; then
    echo "⚠️  Pre-existing changes detected — these will NOT be staged into the bootstrap commit:"
    echo "$DIRTY" | sed 's/^/    /'
    echo "    (commit or stash them separately if you want them included)"
  fi
fi

# Surgical staging: stage only paths recorded by Step A4/A5.
if [[ -n "${STAGED_PATHS:-}" && -s "$STAGED_PATHS" ]]; then
  while IFS= read -r path; do
    [[ -e "$TARGET/$path" ]] && git add -- "$path"
  done < "$STAGED_PATHS"
fi

# Commit if anything got staged
if ! git diff --cached --quiet; then
  if [[ -n "$(git rev-list --all 2>/dev/null | head -1)" ]]; then
    MSG="[rkt] Add workflow tooling and project scaffolding"
  else
    MSG="[rkt] Initial commit with workflow tooling"
  fi
  git commit -m "$MSG"
  ADOPT_SHA=$(git rev-parse --short HEAD)
  echo "Commit: $ADOPT_SHA"
else
  echo "No changes staged — nothing to commit"
fi

# Sync the canonical rkt label set onto the GitHub remote (no-op if absent).
# Runs after the commit so any synced label changes don't try to enter the
# bootstrap commit.
"${RKT_PLUGIN_ROOT}/scripts/sync-github-labels.sh"
```

### Step A8: Report

Produce a summary that reflects what actually happened:

```markdown
## ✓ Applied `{{PRESET}}` preset to {{PROJECT_NAME}}

**Added:**
- {{list each newly-created file, e.g. `.claude/rules/web-nextjs.md`, `PROGRESS.md`, `rkt.json`}}

**Conflicts resolved:**
- {{file}}: {{outcome — replaced / kept mine / merged / skipped}}

**Skipped (already existed, identical):**
- {{file}}, {{file}}

**Linear:** {{created `https://...` / linked existing `https://...` / skipped}}

**GitHub:** {{existing remote preserved / skipped}}

**Commit:** {{ADOPT_SHA}}

### Next steps

- `/scan` — suggest Linear issues based on existing code
- `/create-issue` — file your first rkt-managed issue
- `/implement` — start work
```

Substitute all `{{...}}` placeholders with actual runtime values before
presenting the report.

---

### What NOT to auto-decide in ADOPT mode (always ask)

These four things must always be prompted via the host's native structured question tool — never inferred
and silently applied:

| Decision | Why |
| :------- | :--- |
| The preset | A mis-detected preset corrupts all subsequent scaffolding |
| MemPalace prefix | Must be unique across the user's projects |
| Linear: link vs. create | Linking the wrong project is hard to undo |
| Per-file conflict resolution | The user's existing files are authoritative |
