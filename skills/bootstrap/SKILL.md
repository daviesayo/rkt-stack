---
name: bootstrap
description: Use to scaffold a new project (greenfield) or adopt an existing one into Davies's rkt workflow. Accepts optional args `[preset] [name]`. Triggers on "bootstrap this", "bootstrap ios", "new project", "set up this repo with rkt", "adopt this project", "apply rkt to this directory".
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

Do **not** auto-install — that's deferred. Use `AskUserQuestion` with options
`[Proceed anyway]` and `[Cancel]` to ask whether to continue, noting which steps
will be skipped due to missing tools.

### Step N2: Gather config

Use `AskUserQuestion` for every prompt — never use bash `read` or plain text
questions.

**Preset** (if not passed as arg):

Use `AskUserQuestion` with:
- Question: "Which preset?"
- Options: `full`, `web`, `backend`, `ios`
- Multi-select: false

**Project name** (if not passed as arg):

Use `AskUserQuestion` as a free-text prompt. Validate the response: it must
match `[a-z][a-z0-9-]*`. Derive `{{PROJECT_NAME_PASCAL}}` from it (e.g.
`my-new-thing` → `MyNewThing`) by title-casing each hyphen-separated segment
and joining without separators.

**Issue prefix**:

Auto-derive via the `derive_prefix` function in
`${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh`. Present as a suggestion:
"I suggest `MNT` for `my-new-thing`. Accept?" Use `AskUserQuestion` with
options: `[Accept MNT]`, `[Customize]`, `[Cancel]`.

**Linear team**:

Query available teams:

```bash
linear api <<< 'query { teams { nodes { id key name } } }' | jq -r '.data.teams.nodes'
```

- If 1 team → auto-use it, no prompt needed
- If >1 team → use `AskUserQuestion` with team names as options
- If 0 teams → stop with an actionable error: "No Linear teams found. Create a
  team at linear.app first, or re-run after setting up Linear."

**GitHub repo**:

Use `AskUserQuestion` with options: `[Create private]`, `[Create public]`,
`[Skip]`. Default to `${CLAUDE_PLUGIN_OPTION_DEFAULT_GH_VISIBILITY}` if that
env var is set.

**MemPalace specialist prefix**:

Use `AskUserQuestion` with options: `[Use project name (slugified)]`,
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
  "RKT_VERSION": "$(jq -r .version "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json")"
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
SCAFFOLD="${CLAUDE_PLUGIN_ROOT}/templates/presets/$PRESET"
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
    "${CLAUDE_PLUGIN_ROOT}/scripts/render-template.sh" "$f" "$tmp" "$(cat "$TMPVARS")"
    mv "$tmp" "$f"
  fi
done
```

### Step N4: Render global templates

For each global template in `${CLAUDE_PLUGIN_ROOT}/templates/` with a `.tmpl`
extension, render it into the target directory without the `.tmpl` suffix:

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

Substitute the actual values (PROJECT_NAME, PRESET, LINEAR_PROJECT_URL, github
URL, commit SHA) into the report before presenting it. If LINEAR_PROJECT_URL is
empty, display "failed — retry later". If GitHub was skipped, display "skipped".
