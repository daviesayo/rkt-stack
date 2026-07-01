# Linear Repo-Index + Scan/Bootstrap Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give rkt-bootstrapped repos a committed, agent-greppable `LINEAR.md`
backlog index (Linear-as-truth, regenerable cache), plus epic/milestone support
in `/scan` and richer Linear project setup in `/bootstrap`.

**Execution ordering (mandatory, NOT parallelizable across these):** Task 0 →
Task 1 → Task 2 create the shared scripts (`linear-list-issues.sh`,
`render-linear-index.sh`, `linear-index-normalize.jq`, `linear-index-pull.sh`)
that Tasks 3/4/5/6 consume. Do not run a later task in a parallel worktree before
its script dependency from Task 1/2 is committed. Tasks 4/5/6 (skill-markdown)
may run in any order after Task 2. Task 7 is last.

**Architecture:** A pure bash render script turns a Linear GraphQL JSON payload
into `LINEAR.md` deterministically. A new `/rkt:linear-sync` skill pulls the
payload (fully paginated, by project UUID) and drives the render + a dedicated
commit. Claude-only `SessionStart`/`Stop` hooks refresh/nudge, self-gated to
inert outside rkt Linear repos. `/scan`, `/bootstrap`, and `/create-issue` gain
hierarchy, enrichment, and index-refresh behavior respectively.

**Tech Stack:** Bash, `jq`, the `linear` CLI (v2.0.0) + `linear api` GraphQL,
`gh`, Claude Code plugin hooks, the repo's `tests/test-*.sh` harness.

## Global Constraints

- Package root is `plugins/rkt/`; do NOT recreate root-level `skills/`, `scripts/`, etc. (AGENTS.md "Package Shape").
- Skills/scripts resolve `RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"`; never reference `./scripts/` (AGENTS.md "Runtime Paths").
- No bash `read` for skill prompts — use the host's native structured question tool (AGENTS.md "Guardrails").
- Bump BOTH manifests (`plugins/rkt/.claude-plugin/plugin.json`, `plugins/rkt/.codex-plugin/plugin.json`) in lockstep; prepend a NEW dated version section to `plugins/rkt/CHANGELOG.md` matching its existing format (`## 0.x.0 — YYYY-MM-DD`, NOT an `[Unreleased]` heading — the file does not use one) (AGENTS.md "Making Changes").
- Tests idempotent: temp dirs, cleanup traps, stub `linear`/`gh` (AGENTS.md "Guardrails").
- Linear reads/writes go through `linear` CLI + `linear api` GraphQL, NOT the Linear MCP.
- **`linear api` invocation:** feed the GraphQL document on **stdin via a `<<'GRAPHQL'` heredoc**, exactly as the shipped `bootstrap/SKILL.md` Step N6 does (`linear api --variable k=v <<'GRAPHQL' … GRAPHQL`). Do NOT use `<<<` here-strings for multi-line queries and do NOT rely on a positional query argument. Bootstrap's heredoc form is the proven in-repo pattern — match it.
- **PR links** in the index come from each issue's **Linear attachments** (populated by Linear's native GitHub integration when a PR references the issue). There is NO separate `gh`-based backfill pass (the spec's C5 `gh` idea is intentionally dropped — Linear already has the link, so a second source would only add drift).
- Linear is authoritative; `LINEAR.md` is regenerable and never hand-edited.
- Verify every `linear api` GraphQL field name against the CLI's schema before use — do not ship guessed field names.
- All Linear failures are non-fatal: warn and continue (matches bootstrap's existing pattern).

**Linear CLI flag reality (verified, v2.0.0):** `linear issue list` has
`--project <name>` (NOT `--project-id`), `--milestone` (needs `--project`),
`--limit <n>` (default 50, `0`=unlimited). `linear issue create` has
`--project`, `--parent <RKT-N>`, `--milestone <name>`. The sync read path uses
`linear api` GraphQL by project UUID, not `issue list`.

**Glyph map (Linear state type → glyph):** `triage`→`🔺 Triage`,
`backlog`/`unstarted`→`📋 Todo`, `started`→`🔄 In Progress`,
`completed`→`✅ Done`, `canceled`→`🚫 Canceled`, unknown→`❔ <type>`.

---

## Task 0: Fix pre-existing `--project-id` bug across skills (prerequisite hygiene)

`--project-id` does NOT exist on CLI v2.0.0 (`issue list`/`issue create` expose
only `--project`). **Verified trap:** `rkt.json .project_name` is the kebab slug
(`{{PROJECT_NAME}}`, e.g. `my-thing`), but the Linear project's DISPLAY name is
`PROJECT_NAME_PASCAL` (`bootstrap/SKILL.md:266`, `projectCreate(name:$name)` with
`$name=PROJECT_NAME_PASCAL`). So a naive `--project "$PROJECT_NAME"` matches
nothing → dedup returns empty → duplicates on every run — WORSE than today's loud
error. Therefore listing/dedup keys off the **project UUID via GraphQL** (robust,
consistent with the new sync path), and creation uses the project's real display
name resolved once and cached in `rkt.json`.

**Files:**
- Create: `plugins/rkt/scripts/linear-list-issues.sh` (project UUID → paginated `identifier\ttitle\tstateType` TSV; shared dedup lister)
- Modify: `plugins/rkt/skills/create-issue/SKILL.md` (Step 0 config + Step 1 dedup + Step 4 create)
- Modify: `plugins/rkt/skills/scan/SKILL.md` (all dedup `issue list` calls + `issue create` + Common Mistakes)
- Modify: `plugins/rkt/skills/implement/SKILL.md` (any `--project-id`)
- Modify: `plugins/rkt/skills/bootstrap/SKILL.md` (persist `.linear.project_name` = Pascal display name at project create)
- Create: `tests/test-no-project-id-flag.sh` (grep-lint guard)

**Interfaces:**
- Consumes: `rkt.json .linear.project_id` (UUID). For create, `rkt.json
  .linear.project_name` (Linear display name; added by this task's bootstrap edit,
  backfilled for existing repos in Step 3).
- Produces: `linear-list-issues.sh` and CLI-correct skills; a regression lint.

- [ ] **Step 1: Write the failing lint test**

Create `tests/test-no-project-id-flag.sh`. The lint bans the literal flag ANYWHERE
(commands AND prose, so Common Mistakes rows must be reworded too — no lingering
mentions), and bans unlimited enumeration:
```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$HERE/../plugins/rkt/skills"
fail=0
# 1. No `--project-id` anywhere (flag does not exist; prose mentions confuse agents).
if grep -rn -- '--project-id' "$SKILLS"; then
  echo "FAIL: --project-id is not a valid linear CLI flag (use --project / GraphQL)"; fail=1
fi
# 2. Any `linear issue list` command line must carry an explicit --limit (0=unlimited).
#    Match command lines only (leading '$LINEAR issue list' or 'linear issue list'),
#    skip fenced prose by requiring the command token.
if grep -rEn '(linear|\$LINEAR) issue list' "$SKILLS" | grep -v -- '--limit'; then
  echo "FAIL: 'issue list' without --limit truncates at 50"; fail=1
fi
[ "$fail" -eq 0 ] && echo "PASS test-no-project-id-flag" || exit 1
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bash tests/test-no-project-id-flag.sh`
Expected: FAIL — enumerate EVERY hit now so Step 3 fixes all of them
(run `grep -rn -- '--project-id' plugins/rkt/skills` and record the full list,
including Common Mistakes rows in `scan` and `create-issue`).

- [ ] **Step 3: Build the shared lister + fix the skills**

Create `plugins/rkt/scripts/linear-list-issues.sh` (GraphQL-by-UUID, paginated):
```bash
#!/usr/bin/env bash
# Emit "identifier\ttitle\tstateType" for every issue in the project (UUID).
# Usage: linear-list-issues.sh   (reads .linear.project_id from ./rkt.json)
set -euo pipefail
pid=$(jq -r '.linear.project_id // ""' rkt.json)
[ -n "$pid" ] || { echo "no linear.project_id" >&2; exit 1; }
cursor=""
while :; do
  if [ -z "$cursor" ]; then
    resp=$(linear api --variable pid="$pid" <<'GRAPHQL'
query($pid:String!){project(id:$pid){issues(first:250){nodes{identifier title state{type}} pageInfo{hasNextPage endCursor}}}}
GRAPHQL
    )
  else
    resp=$(linear api --variable pid="$pid" --variable after="$cursor" <<'GRAPHQL'
query($pid:String!,$after:String){project(id:$pid){issues(first:250,after:$after){nodes{identifier title state{type}} pageInfo{hasNextPage endCursor}}}}
GRAPHQL
    )
  fi
  jq -e '.data.project != null' <<<"$resp" >/dev/null || { echo "project not found for id $pid" >&2; exit 1; }
  jq -r '.data.project.issues.nodes[] | [.identifier,.title,.state.type] | @tsv' <<<"$resp"
  [ "$(jq -r '.data.project.issues.pageInfo.hasNextPage' <<<"$resp")" = "true" ] || break
  cursor=$(jq -r '.data.project.issues.pageInfo.endCursor' <<<"$resp")
done
```
(`chmod +x`. Note the **first page omits `--variable after`** so `$after` is
GraphQL null — do NOT pass the literal string `"null"`.)

In each skill: replace `--project-id "$PROJECT_ID"` on `issue list`/dedup with a
call to `"${RKT_PLUGIN_ROOT}/scripts/linear-list-issues.sh"` (dedup greps its TSV
by title/`<!-- [scan:KEY] -->`). For `issue create`, replace `--project-id
"$(jq -r .linear.project_id rkt.json)"` with `--project "$LINEAR_PROJECT_NAME"`
where `LINEAR_PROJECT_NAME=$(jq -r '.linear.project_name // .project_name' rkt.json)`.
Reword EVERY `--project-id` prose/Common-Mistakes mention (scan + create-issue) to
the new guidance ("dedup via GraphQL-by-UUID; never name-match on the kebab slug").

Persist the display name for future repos — in `bootstrap/SKILL.md` Step N6 after
`projectCreate`, extend the rkt.json patch to also set `.linear.project_name` from
the created project's `.name`:
```bash
LINEAR_PROJECT_NAME=$(echo "$LINEAR_RESP" | jq -r '.data.projectCreate.project.name')
jq --arg n "$LINEAR_PROJECT_NAME" '.linear.project_name = $n' rkt.json > rkt.json.new && mv rkt.json.new rkt.json
```
For already-bootstrapped repos lacking `.linear.project_name`, the create fallback
`// .project_name` is wrong (kebab); so Step 3 also adds a one-time backfill note:
if `.linear.project_name` is absent, resolve it via
`linear api` `query($pid){project(id:$pid){name}}` and write it once.

- [ ] **Step 4: Run the lint test until it passes**

Run: `bash tests/test-no-project-id-flag.sh`
Expected: `PASS test-no-project-id-flag`.

- [ ] **Step 5: Commit**

```bash
chmod +x plugins/rkt/scripts/linear-list-issues.sh
git add plugins/rkt/scripts/linear-list-issues.sh plugins/rkt/skills/create-issue/SKILL.md plugins/rkt/skills/scan/SKILL.md plugins/rkt/skills/implement/SKILL.md plugins/rkt/skills/bootstrap/SKILL.md tests/test-no-project-id-flag.sh
git commit -m "fix(linear): replace non-existent --project-id with GraphQL-by-UUID dedup + display-name create"
```

---

## Task 1: Deterministic render script `render-linear-index.sh`

Pure function: reads a Linear GraphQL JSON payload (issues + milestones +
epics/parents + PR links) on stdin, writes `LINEAR.md` to stdout. No network. The
one thing everything else depends on; fully TDD-able with fixtures.

**Files:**
- Create: `plugins/rkt/scripts/render-linear-index.sh`
- Create: `tests/test-linear-index-render.sh`
- Create: `tests/fixtures/linear-index/basic.json`
- Create: `tests/fixtures/linear-index/expected-basic.md`
  (the >50-issue pagination fixture is generated in-test, not a committed file)

**Interfaces:**
- Consumes: a JSON object on stdin with shape (normalized, NOT raw GraphQL —
  the sync skill normalizes before piping):
  ```json
  {
    "project": {"name": "Demo", "url": "https://linear.app/x/project/demo-abc"},
    "syncedAt": "2026-07-01T14:03:00Z",
    "milestones": [{"id":"m1","name":"Phase 2 — Core API","targetDate":"2026-07-15"}],
    "issues": [
      {"id":"RKT-11","title":"Add charge endpoint","stateType":"completed",
       "labels":["Feature","Backend"],"milestoneId":"m1","parentId":"RKT-10",
       "isEpic":false,"pr":"42"}
    ]
  }
  ```
- Produces: `LINEAR.md` text on stdout. Deterministic ordering: milestones by
  (`targetDate` asc, nulls last, then `name`); within a milestone, epics by issue
  number, then that epic's children by issue number; a "No milestone" section
  last; issues with no epic listed directly under their milestone before epic
  groups. Epics themselves render as a `### Epic RKT-N — <title> (<status>)`
  heading; non-epic issues render as table rows. `syncedAt` and `project.url`
  go in the header/marker.

- [ ] **Step 1: Write the basic fixture input**

Create `tests/fixtures/linear-index/basic.json`:
```json
{
  "project": {"name": "Demo", "url": "https://linear.app/x/project/demo-abc"},
  "syncedAt": "2026-07-01T14:03:00Z",
  "milestones": [{"id":"m1","name":"Phase 2 — Core API","targetDate":"2026-07-15"}],
  "issues": [
    {"id":"RKT-10","title":"Payments","stateType":"started","labels":["Epic"],"milestoneId":"m1","parentId":null,"isEpic":true,"pr":null},
    {"id":"RKT-11","title":"Add charge endpoint","stateType":"completed","labels":["Feature","Backend"],"milestoneId":"m1","parentId":"RKT-10","isEpic":false,"pr":"42"},
    {"id":"RKT-12","title":"Webhook handler","stateType":"started","labels":["Feature","Backend"],"milestoneId":"m1","parentId":"RKT-10","isEpic":false,"pr":null},
    {"id":"RKT-30","title":"Fix null deref","stateType":"unstarted","labels":["Bug","iOS"],"milestoneId":null,"parentId":null,"isEpic":false,"pr":null}
  ]
}
```

- [ ] **Step 2: Write the expected output fixture**

Create `tests/fixtures/linear-index/expected-basic.md`:
```markdown
<!-- rkt:linear-index generated by /rkt:linear-sync — do not edit. synced: 2026-07-01T14:03:00Z -->
# Linear Backlog — Demo  ·  [open in Linear](https://linear.app/x/project/demo-abc)

## Milestone: Phase 2 — Core API  (target 2026-07-15)

### Epic RKT-10 — Payments  (🔄 In Progress)
| ID | Title | Status | Labels | PR |
|----|-------|--------|--------|----|
| RKT-11 | Add charge endpoint | ✅ Done | Feature·Backend | #42 |
| RKT-12 | Webhook handler | 🔄 In Progress | Feature·Backend | — |

## No milestone

| ID | Title | Status | Labels | PR |
|----|-------|--------|--------|----|
| RKT-30 | Fix null deref | 📋 Todo | Bug·iOS | — |
```

> Whitespace rule (regular): each section header (`## Milestone…` / `## No
> milestone`) is preceded by one blank line; each sub-block inside a section (the
> directs table, and each `### Epic` block) is also preceded by exactly one blank
> line; no blank line between a table header and its rows or between an epic
> heading and its table. The blank line after `## No milestone` is intentional
> and matches the `printf '\n'` before every directs table.

- [ ] **Step 3: Write the failing test**

Create `tests/test-linear-index-render.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../plugins/rkt/scripts/render-linear-index.sh"
FIX="$HERE/fixtures/linear-index"
fail() { echo "FAIL: $1"; exit 1; }

# 1. basic render matches expected byte-for-byte
out="$("$SCRIPT" < "$FIX/basic.json")"
if ! diff <(printf '%s\n' "$out") "$FIX/expected-basic.md" >/dev/null; then
  diff <(printf '%s\n' "$out") "$FIX/expected-basic.md" || true
  fail "basic render did not match expected"
fi

# 2. determinism: two renders identical
a="$("$SCRIPT" < "$FIX/basic.json")"; b="$("$SCRIPT" < "$FIX/basic.json")"
[ "$a" = "$b" ] || fail "render not deterministic"

echo "PASS test-linear-index-render"
```

- [ ] **Step 4: Run the test, verify it fails**

Run: `bash tests/test-linear-index-render.sh`
Expected: FAIL (script does not exist yet / no such file).

- [ ] **Step 5: Implement `render-linear-index.sh`**

Create `plugins/rkt/scripts/render-linear-index.sh`:
```bash
#!/usr/bin/env bash
# Render a normalized Linear payload (stdin JSON) into LINEAR.md (stdout).
# Pure function: no network, deterministic ordering.
set -euo pipefail

payload="$(cat)"

glyph() {
  case "$1" in
    triage) echo "🔺 Triage";; backlog|unstarted) echo "📋 Todo";;
    started) echo "🔄 In Progress";; completed) echo "✅ Done";;
    canceled) echo "🚫 Canceled";; *) echo "❔ $1";;
  esac
}

pname=$(jq -r '.project.name' <<<"$payload")
purl=$(jq -r '.project.url' <<<"$payload")
synced=$(jq -r '.syncedAt' <<<"$payload")

printf '<!-- rkt:linear-index generated by /rkt:linear-sync — do not edit. synced: %s -->\n' "$synced"
printf '# Linear Backlog — %s  ·  [open in Linear](%s)\n' "$pname" "$purl"

row() { # id title stateType labels(csv) pr
  local id="$1" title="$2" st="$3" labels="$4" pr="$5"
  local prcell="—"; [ -n "$pr" ] && [ "$pr" != "null" ] && prcell="#$pr"
  printf '| %s | %s | %s | %s | %s |\n' "$id" "$title" "$(glyph "$st")" "$labels" "$prcell"
}
tablehdr() { printf '| ID | Title | Status | Labels | PR |\n|----|-------|--------|--------|----|\n'; }

labels_of() { jq -r --arg id "$1" '.issues[]|select(.id==$id)|(.labels|join("·"))' <<<"$payload"; }

# Ordered milestone ids: targetDate asc (null last), then name
mids=$(jq -r '[.milestones[]]|sort_by((.targetDate//"9999-99-99"), .name)|.[].id' <<<"$payload")

num='(sub("^[A-Za-z0-9]+-";"")|tonumber? // 0)'   # generic prefix; tonumber? // 0 = never abort on odd ids

render_children() { # $1 = a valid jq boolean fragment, e.g. '.milestoneId=="m1"' or '.milestoneId==null'
  local mfilter="$1"
  # NOTE: $mfilter is interpolated into the jq PROGRAM text (valid jq), never
  # passed via --argjson (which would treat the expression as JSON and abort).
  # epic parents in this milestone, by issue number
  local epics
  epics=$(jq -r '[.issues[]|select(.isEpic==true)|select('"$mfilter"')]|sort_by(.id|'"$num"')|.[].id' <<<"$payload")
  # direct (non-epic, no parent) issues first
  local directs
  directs=$(jq -r '[.issues[]|select(.isEpic==false and .parentId==null)|select('"$mfilter"')]|sort_by(.id|'"$num"')|.[].id' <<<"$payload")
  if [ -n "$directs" ]; then
    printf '\n'; tablehdr
    while IFS= read -r id; do [ -z "$id" ] && continue
      local t s; t=$(jq -r --arg i "$id" '.issues[]|select(.id==$i)|.title' <<<"$payload")
      s=$(jq -r --arg i "$id" '.issues[]|select(.id==$i)|.stateType' <<<"$payload")
      local p; p=$(jq -r --arg i "$id" '.issues[]|select(.id==$i)|.pr' <<<"$payload")
      row "$id" "$t" "$s" "$(labels_of "$id")" "$p"
    done <<<"$directs"
  fi
  while IFS= read -r eid; do [ -z "$eid" ] && continue
    local et es; et=$(jq -r --arg i "$eid" '.issues[]|select(.id==$i)|.title' <<<"$payload")
    es=$(jq -r --arg i "$eid" '.issues[]|select(.id==$i)|.stateType' <<<"$payload")
    printf '\n### Epic %s — %s  (%s)\n' "$eid" "$et" "$(glyph "$es")"
    tablehdr
    local kids; kids=$(jq -r --arg e "$eid" '[.issues[]|select(.parentId==$e)]|sort_by(.id|'"$num"')|.[].id' <<<"$payload")
    while IFS= read -r kid; do [ -z "$kid" ] && continue
      local kt ks kp; kt=$(jq -r --arg i "$kid" '.issues[]|select(.id==$i)|.title' <<<"$payload")
      ks=$(jq -r --arg i "$kid" '.issues[]|select(.id==$i)|.stateType' <<<"$payload")
      kp=$(jq -r --arg i "$kid" '.issues[]|select(.id==$i)|.pr' <<<"$payload")
      row "$kid" "$kt" "$ks" "$(labels_of "$kid")" "$kp"
    done <<<"$kids"
  done <<<"$epics"
}

while IFS= read -r mid; do [ -z "$mid" ] && continue
  mname=$(jq -r --arg m "$mid" '.milestones[]|select(.id==$m)|.name' <<<"$payload")
  mdate=$(jq -r --arg m "$mid" '.milestones[]|select(.id==$m)|.targetDate//""' <<<"$payload")
  hdr="## Milestone: $mname"; [ -n "$mdate" ] && hdr="$hdr  (target $mdate)"
  printf '\n%s\n' "$hdr"
  render_children ".milestoneId==\"$mid\""
done <<<"$mids"

# No-milestone bucket
nm=$(jq -r '[.issues[]|select(.milestoneId==null)]|length' <<<"$payload")
if [ "$nm" -gt 0 ]; then
  printf '\n## No milestone\n'
  render_children ".milestoneId==null"
fi
```

Make executable: `chmod +x plugins/rkt/scripts/render-linear-index.sh`.

- [ ] **Step 6: Run the test, iterate until it passes**

Run: `bash tests/test-linear-index-render.sh`
Expected: `PASS test-linear-index-render`. If the diff differs, adjust spacing in
the script to match `expected-basic.md` exactly (whitespace is significant).

- [ ] **Step 7: Add the pagination-coverage test (fixture built in-test, not pasted)**

Do NOT hand-paste a 60-issue fixture. Generate it deterministically inside the
test with `jq` so it is reviewable and regenerable. Append to
`tests/test-linear-index-render.sh` before the final echo:
```bash
# 3. all 60 issues render (guards truncation) — fixture generated in-test
big="$(jq -n '{
  project:{name:"Big",url:"https://linear.app/x/project/big"},
  syncedAt:"2026-07-01T00:00:00Z", milestones:[],
  issues:[range(1;61) as $i | {id:("RKT-"+($i|tostring)),title:("Issue "+($i|tostring)),
          stateType:"unstarted",labels:["Bug"],milestoneId:null,parentId:null,isEpic:false,pr:null}]
}')"
count=$(printf '%s' "$big" | "$SCRIPT" | grep -c '^| RKT-')
[ "$count" -eq 60 ] || fail "expected 60 issue rows, got $count"

# 4. directs + epic under the SAME milestone (basic fixture only covers empty-directs).
mixed="$(jq -n '{
  project:{name:"Mix",url:"u"}, syncedAt:"2026-07-01T00:00:00Z",
  milestones:[{id:"m1",name:"P1",targetDate:null}],
  issues:[
    {id:"RKT-5",title:"Loose",stateType:"unstarted",labels:["Bug"],milestoneId:"m1",parentId:null,isEpic:false,pr:null},
    {id:"RKT-9",title:"Ep",stateType:"started",labels:["Epic"],milestoneId:"m1",parentId:null,isEpic:true,pr:null},
    {id:"RKT-10",title:"Child",stateType:"completed",labels:["Bug"],milestoneId:"m1",parentId:"RKT-9",isEpic:false,pr:null}
  ]}')"
mout="$(printf '%s' "$mixed" | "$SCRIPT")"
# direct row RKT-5 must appear BEFORE the "### Epic RKT-9" heading
dl=$(printf '%s\n' "$mout" | grep -n '^| RKT-5 ' | cut -d: -f1)
el=$(printf '%s\n' "$mout" | grep -n '^### Epic RKT-9' | cut -d: -f1)
[ -n "$dl" ] && [ -n "$el" ] && [ "$dl" -lt "$el" ] || fail "directs must render before epics under a milestone"
# milestone with null targetDate must NOT print a "(target …)" suffix
printf '%s\n' "$mout" | grep -q '^## Milestone: P1$' || fail "null targetDate should omit the target suffix"

# 5. unknown state type falls back to "❔ <type>" (never silently vanishes)
gout="$(echo '{"project":{"name":"x","url":"u"},"syncedAt":"s","milestones":[],"issues":[{"id":"RKT-1","title":"t","stateType":"weirdstate","labels":[],"milestoneId":null,"parentId":null,"isEpic":false,"pr":null}]}' | "$SCRIPT")"
printf '%s\n' "$gout" | grep -q '❔ weirdstate' || fail "unknown state type must fall back to ❔ <type>"
```

- [ ] **Step 8: Run tests, commit**

Run: `bash tests/test-linear-index-render.sh`
Expected: PASS.
```bash
git add plugins/rkt/scripts/render-linear-index.sh tests/test-linear-index-render.sh tests/fixtures/linear-index/
git commit -m "feat(linear-index): deterministic render script + tests"
```

---

## Task 2: `/rkt:linear-sync` skill (GraphQL pull + render + commit)

Wires the read path to Task 1. This task's testable deliverable is the skill file
plus a normalizer helper that converts raw Linear GraphQL into the Task-1 input
shape (the normalizer is the testable unit; the skill prose orchestrates).

**Files:**
- Create: `plugins/rkt/skills/linear-sync/SKILL.md`
- Create: `plugins/rkt/scripts/linear-index-pull.sh` (shared: paginated GraphQL pull → normalize → render `LINEAR.md`; NO commit)
- Create: `plugins/rkt/scripts/linear-index-normalize.jq` (raw GraphQL → Task-1 shape)
- Create: `tests/test-linear-index-normalize.sh`
- Create: `tests/fixtures/linear-index/raw-graphql.json`

**Interfaces:**
- Consumes: Task 1 `render-linear-index.sh`.
- Produces:
  - `linear-index-normalize.jq` transforming raw `data.project` GraphQL into
    `{project,syncedAt,milestones,issues}` (`--arg now <iso>` sets `syncedAt`).
  - `linear-index-pull.sh` — the **single shared implementation** of pull +
    normalize + render, writing `LINEAR.md` in cwd and NOT committing. Consumed by
    this skill (which adds the commit), by the Task 3 SessionStart hook, and by
    Task 6 `/create-issue`. Defined HERE so no later task forward-references it.
  - `linear-sync/SKILL.md` — orchestrates `require_linear` → `linear-index-pull.sh`
    → dedicated commit.

- [ ] **Step 1: Confirm the GraphQL shape against the CLI (blocking task-0)**

Using the proven heredoc-stdin form (as in `bootstrap/SKILL.md` Step N6):
```bash
linear api <<'GRAPHQL'
query { __type(name:"Issue") { fields { name } } }
GRAPHQL
linear api <<'GRAPHQL'
query { __type(name:"ProjectMilestone") { fields { name } } }
GRAPHQL
```
Expected: field names exist for `projectMilestone`/`milestone`, `parent`,
`state{type}`, `labels{nodes{name}}`, `attachments`/`links` (for PR). **Record
the exact names and reconcile them into the query (Step 6), the fixture (Step 2),
AND the normalizer (Step 4) together** — all three hard-code these names, so a
mismatch means editing three places. Do NOT proceed on guessed names.

- [ ] **Step 2: Write the raw GraphQL fixture + failing normalizer test**

Create `tests/fixtures/linear-index/raw-graphql.json` — a realistic
`{"data":{"project":{...}}}` payload with one milestone, one epic parent, two
children (one with a GitHub PR attachment url `https://github.com/o/r/pull/42`),
and one no-milestone issue.

Create `tests/test-linear-index-normalize.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
JQF="$HERE/../plugins/rkt/scripts/linear-index-normalize.jq"
FIX="$HERE/fixtures/linear-index/raw-graphql.json"
fail(){ echo "FAIL: $1"; exit 1; }

out=$(jq --arg now "2026-07-01T14:03:00Z" -f "$JQF" "$FIX")
[ "$(jq -r '.project.name' <<<"$out")" != "null" ] || fail "project name missing"
[ "$(jq '.issues|length' <<<"$out")" -eq 4 ] || fail "expected 4 issues"
[ "$(jq -r '.issues[]|select(.id=="RKT-11")|.pr' <<<"$out")" = "42" ] || fail "PR not extracted from attachment url"
[ "$(jq -r '.issues[]|select(.id=="RKT-10")|.isEpic' <<<"$out")" = "true" ] || fail "epic label not mapped to isEpic"
echo "PASS test-linear-index-normalize"
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `bash tests/test-linear-index-normalize.sh`
Expected: FAIL (no such jq file).

- [ ] **Step 4: Implement `linear-index-normalize.jq`**

Create `plugins/rkt/scripts/linear-index-normalize.jq`:
```jq
# Raw Linear GraphQL (.data.project) -> render-linear-index input shape.
# Usage: jq --arg now "<iso>" -f linear-index-normalize.jq raw.json
.data.project as $p
| {
    project: { name: $p.name, url: $p.url },
    syncedAt: $now,
    milestones: [ $p.projectMilestones.nodes[] | {id, name, targetDate} ],
    issues: [ $p.issues.nodes[] | {
        id: .identifier,
        title: .title,
        stateType: .state.type,
        labels: [ .labels.nodes[].name ],
        milestoneId: (.projectMilestone.id // null),
        parentId: (.parent.identifier // null),
        isEpic: ([ .labels.nodes[].name ] | index("Epic") != null),
        pr: ( [ .attachments.nodes[]?.url // empty
                | capture("github\\.com/.+/pull/(?<n>[0-9]+)").n ] | first // null )
      } ]
  }
```

- [ ] **Step 5: Run the test until it passes, commit checkpoint**

Run: `bash tests/test-linear-index-normalize.sh`
Expected: PASS. Adjust field paths to match the Step-1 introspection if needed.

- [ ] **Step 6: Create the shared `linear-index-pull.sh` (pull + normalize + render, no commit)**

Create `plugins/rkt/scripts/linear-index-pull.sh`. It runs in a repo cwd, reads
`rkt.json`, paginates the GraphQL query, normalizes, renders `LINEAR.md`, and
exits non-zero on hard failure WITHOUT touching an existing `LINEAR.md`:
```bash
#!/usr/bin/env bash
# Pull the project's Linear issues and (re)render ./LINEAR.md. No git actions.
# Exit 0 = LINEAR.md written/current; non-zero = failure (caller decides).
set -euo pipefail
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
[ -n "$RKT_PLUGIN_ROOT" ] || { echo "RKT_PLUGIN_ROOT unset" >&2; exit 1; }
[ -f rkt.json ] || { echo "no rkt.json" >&2; exit 1; }
pid=$(jq -r '.linear.project_id // ""' rkt.json)
[ -n "$pid" ] || { echo "no linear.project_id" >&2; exit 1; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cursor=""; : > "$tmp/nodes.jsonl"; meta=""
# Shared page fragment; first page omits `after` so $after is GraphQL null
# (never pass the literal string "null").
QUERY='query($pid: String!, $after: String) {
  project(id: $pid) {
    name url
    projectMilestones { nodes { id name targetDate } }
    issues(first: 250, after: $after) {
      nodes { identifier title state { type } labels { nodes { name } }
              projectMilestone { id } parent { identifier }
              attachments { nodes { url } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}'
while :; do
  if [ -z "$cursor" ]; then
    resp=$(printf '%s' "$QUERY" | linear api --variable pid="$pid") || { echo "linear api failed" >&2; exit 1; }
  else
    resp=$(printf '%s' "$QUERY" | linear api --variable pid="$pid" --variable after="$cursor") || { echo "linear api failed" >&2; exit 1; }
  fi
  # Guard: a bad UUID returns {"data":{"project":null}} with exit 0. Do NOT proceed
  # (else we would write a garbage index over a good one).
  jq -e '.data.project != null' <<<"$resp" >/dev/null || { echo "project not found for id $pid" >&2; exit 1; }
  [ -z "$meta" ] && meta=$(jq '{name:.data.project.name,url:.data.project.url,projectMilestones:.data.project.projectMilestones}' <<<"$resp")
  jq -c '.data.project.issues.nodes[]' <<<"$resp" >> "$tmp/nodes.jsonl"
  [ "$(jq -r '.data.project.issues.pageInfo.hasNextPage' <<<"$resp")" = "true" ] || break
  cursor=$(jq -r '.data.project.issues.pageInfo.endCursor' <<<"$resp")
done
# Reassemble a single {data:{project:{…}}} doc; render to a TEMP file, then
# atomically move over LINEAR.md ONLY on success — never truncate the committed
# index before a good render exists.
jq -s --argjson meta "$meta" '{data:{project:($meta+{issues:{nodes:.}})}}' "$tmp/nodes.jsonl" > "$tmp/raw.json"
jq --arg now "$(date -u +%FT%TZ)" -f "${RKT_PLUGIN_ROOT}/scripts/linear-index-normalize.jq" "$tmp/raw.json" > "$tmp/norm.json"
"${RKT_PLUGIN_ROOT}/scripts/render-linear-index.sh" < "$tmp/norm.json" > "$tmp/LINEAR.md"
[ -s "$tmp/LINEAR.md" ] || { echo "render produced empty output" >&2; exit 1; }
mv "$tmp/LINEAR.md" LINEAR.md
```
`chmod +x`. (No dedicated test here — it needs a live `linear`; its pure pieces,
`normalize.jq` and `render-linear-index.sh`, are tested in Task 1/this task. The
pull glue is exercised end-to-end in the smoke test, Step 8.)

- [ ] **Step 7: Write the `/rkt:linear-sync` skill file**

Create `plugins/rkt/skills/linear-sync/SKILL.md` with frontmatter (name:
`linear-sync`; description triggering on "sync linear", "refresh backlog index",
"update LINEAR.md", "rebuild the linear index") and body:
1. Resolve `RKT_PLUGIN_ROOT`; `source "${RKT_PLUGIN_ROOT}/scripts/lib/common.sh"; require_linear || exit 1`.
2. Run `"${RKT_PLUGIN_ROOT}/scripts/linear-index-pull.sh"`; on non-zero, warn,
   leave existing `LINEAR.md` untouched, stop (do not commit).
3. Commit ONLY `LINEAR.md` as its own atomic commit (`chore(linear): sync backlog
   index`) if `! git diff --quiet LINEAR.md`; else report "index already current"
   and commit nothing. Never `git add -A`.
Include a "Common Mistakes" table (no `--project-id`; the pull already paginates;
never hand-edit `LINEAR.md`; never stage unrelated files).

- [ ] **Step 8: Smoke-test end-to-end (live `linear`, if available) + commit**

If a configured rkt Linear repo is reachable, run `bash
plugins/rkt/scripts/linear-index-pull.sh` in it and eyeball `LINEAR.md`. Then:
```bash
chmod +x plugins/rkt/scripts/linear-index-pull.sh
claude plugin validate plugins/rkt   # expect: no errors
git add plugins/rkt/skills/linear-sync/SKILL.md plugins/rkt/scripts/linear-index-pull.sh plugins/rkt/scripts/linear-index-normalize.jq tests/test-linear-index-normalize.sh tests/fixtures/linear-index/raw-graphql.json
git commit -m "feat(linear-sync): add /rkt:linear-sync skill, shared pull, GraphQL normalizer"
```

---

## Task 3: Claude-only refresh hooks (SessionStart + Stop), self-gated

**Files:**
- Create: `plugins/rkt/hooks/hooks.json`
- Create: `plugins/rkt/hooks/linear-index-refresh.sh` (SessionStart)
- Create: `plugins/rkt/hooks/linear-index-nudge.sh` (Stop)
- Create: `tests/test-hooks-gating.sh`
- Modify: `plugins/rkt/.claude-plugin/plugin.json` (add `hooks` path if required by format)

**Interfaces:**
- Consumes: `/rkt:linear-sync` behavior (refresh hook calls the same GraphQL+render, throttled).
- Produces: two self-gating hook scripts. Gate = `rkt.json` exists AND
  `.linear.project_id` non-empty AND `command -v linear` — else `exit 0` silently.

- [ ] **Step 0: Verify hook wiring for BOTH tools (blocking gate) — record concrete answers**

Two questions, each needs a definite answer before writing code:
1. **Claude Code:** does a plugin auto-discover `hooks/hooks.json` at the plugin
   root, or must `plugin.json` reference it? Check current Claude Code plugin docs
   (use the claude-code-guide agent or official docs). Record: the exact
   `hooks.json` schema (event key names, `type`/`command` fields), whether
   `${CLAUDE_PLUGIN_ROOT}` is interpolated in the `command`, and **how the hook
   receives the project directory** (stdin JSON payload vs `$CLAUDE_PROJECT_DIR`
   env — this determines the gate in Step 3; do NOT assume cwd is the repo root).
   Write the confirmed answer into this step before proceeding, and make the
   `plugin.json` edit (if any) explicit.
2. **Codex:** does a plugin-packaged `hooks/hooks.json` load on Codex? If
   unconfirmed, keep hooks **Claude-only**: do NOT add a hooks key to
   `.codex-plugin/plugin.json`; note the limitation in skill/README.
Record both findings in the commit message.

- [ ] **Step 1: Write the gating test (failing)**

Create `tests/test-hooks-gating.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REFRESH="$HERE/../plugins/rkt/hooks/linear-index-refresh.sh"
NUDGE="$HERE/../plugins/rkt/hooks/linear-index-nudge.sh"
fail(){ echo "FAIL: $1"; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
stub="$tmp/bin"; mkdir -p "$stub"
# linear stub records if it was called (proves throttle skip / gate)
printf '#!/usr/bin/env bash\ntouch "%s/linear-called"\nexit 0\n' "$tmp" > "$stub/linear"; chmod +x "$stub/linear"
run() { CLAUDE_PROJECT_DIR="$tmp" PATH="$stub:$PATH" bash "$1" 2>&1; }  # hooks cd into CLAUDE_PROJECT_DIR

# (a) non-rkt dir (no rkt.json): silent exit 0
out=$(run "$REFRESH") || fail "refresh non-zero in non-rkt dir"; [ -z "$out" ] || fail "refresh output in non-rkt dir: $out"
out=$(run "$NUDGE")   || fail "nudge non-zero in non-rkt dir";   [ -z "$out" ] || fail "nudge output in non-rkt dir"

# (b) rkt dir, empty project_id: still silent exit 0, linear never called
echo '{"linear":{"project_id":""}}' > "$tmp/rkt.json"
out=$(run "$REFRESH") || fail "refresh non-zero with empty id"; [ -z "$out" ] || fail "refresh acted with empty id"
[ ! -e "$tmp/linear-called" ] || fail "refresh called linear with empty id"

# (c) configured + FRESH LINEAR.md → throttle skips the network (linear NOT called)
echo '{"linear":{"project_id":"abc","index_throttle_minutes":30}}' > "$tmp/rkt.json"
now=$(date -u +%FT%TZ)
printf '<!-- rkt:linear-index generated by /rkt:linear-sync — do not edit. synced: %s -->\n' "$now" > "$tmp/LINEAR.md"
rm -f "$tmp/linear-called"
run "$REFRESH" >/dev/null || fail "refresh non-zero on fresh index"
[ ! -e "$tmp/linear-called" ] || fail "throttle failed: linear called despite fresh index"

# (d) configured + MISSING LINEAR.md → nudge prints reminder
rm -f "$tmp/LINEAR.md"
out=$(run "$NUDGE") || fail "nudge non-zero when missing"
echo "$out" | grep -q "LINEAR.md missing" || fail "nudge did not warn on missing index"

# (e) configured + STALE LINEAR.md → refresh MUST attempt the pull (guards a
# hook that silently never refreshes). Point RKT_PLUGIN_ROOT at a stub pull that
# records invocation, so no network is needed.
stubroot="$tmp/root/scripts"; mkdir -p "$stubroot"
printf '#!/usr/bin/env bash\ntouch "%s/pull-called"\n' "$tmp" > "$stubroot/linear-index-pull.sh"; chmod +x "$stubroot/linear-index-pull.sh"
printf '<!-- rkt:linear-index generated by /rkt:linear-sync — do not edit. synced: 2020-01-01T00:00:00Z -->\n' > "$tmp/LINEAR.md"
rm -f "$tmp/pull-called"
CLAUDE_PROJECT_DIR="$tmp" RKT_PLUGIN_ROOT="$tmp/root" PATH="$stub:$PATH" bash "$REFRESH" >/dev/null || fail "refresh non-zero on stale index"
[ -e "$tmp/pull-called" ] || fail "refresh did not pull on stale index (dead hook)"
echo "PASS test-hooks-gating"
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bash tests/test-hooks-gating.sh`
Expected: FAIL (hook scripts do not exist).

- [ ] **Step 3: Implement the shared gate + both hooks**

Both hooks `cd` into the project dir first (per Step-0 finding: use
`$CLAUDE_PROJECT_DIR` if that is how Claude passes it; the scripts below take it
from `$CLAUDE_PROJECT_DIR` with a cwd fallback). `linear-index-pull.sh` already
exists from Task 2 — the hook just calls it; nothing is extracted or rewritten.

Create `plugins/rkt/hooks/linear-index-refresh.sh`:
```bash
#!/usr/bin/env bash
# SessionStart hook: throttled index refresh. Inert outside rkt Linear repos.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
[ -f rkt.json ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
pid=$(jq -r '.linear.project_id // ""' rkt.json 2>/dev/null || echo "")
[ -n "$pid" ] || exit 0
command -v linear >/dev/null 2>&1 || exit 0

throttle=$(jq -r '.linear.index_throttle_minutes // 30' rkt.json 2>/dev/null || echo 30)
if [ -f LINEAR.md ]; then
  synced=$(sed -n 's/.*synced: \([0-9T:-]*Z\).*/\1/p' LINEAR.md | head -1)
  if [ -n "$synced" ]; then
    # TZ=UTC is REQUIRED: macOS `date -j -f` parses as LOCAL time otherwise,
    # producing a timezone-sized age error vs the UTC `now` below.
    last=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$synced" +%s 2>/dev/null || TZ=UTC date -d "$synced" +%s 2>/dev/null || echo 0)
    now=$(date -u +%s); age=$(( (now - last) / 60 ))
    [ "$age" -lt "$throttle" ] && exit 0   # fresh enough — skip network
  fi
fi
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
[ -n "$RKT_PLUGIN_ROOT" ] || exit 0
export RKT_PLUGIN_ROOT
( "${RKT_PLUGIN_ROOT}/scripts/linear-index-pull.sh" > /dev/null 2>&1 ) || exit 0  # best-effort; never fail the session
exit 0
```

Create `plugins/rkt/hooks/linear-index-nudge.sh`:
```bash
#!/usr/bin/env bash
# Stop hook: no network. Nudge if LINEAR.md missing. Inert outside rkt Linear repos.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
[ -f rkt.json ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
pid=$(jq -r '.linear.project_id // ""' rkt.json 2>/dev/null || echo "")
[ -n "$pid" ] || exit 0
command -v linear >/dev/null 2>&1 || exit 0
if [ ! -f LINEAR.md ]; then
  echo "rkt: LINEAR.md missing — run /rkt:linear-sync to build the backlog index."
fi
exit 0
```

Create `plugins/rkt/hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/linear-index-refresh.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/linear-index-nudge.sh" } ] }
    ]
  }
}
```
Verify this matches the current Claude Code plugin hooks schema before writing
(check plugin docs — field names `type`/`command` and event keys). `chmod +x`
both scripts.

- [ ] **Step 4: Run the gating test until it passes**

Run: `bash tests/test-hooks-gating.sh`
Expected: `PASS test-hooks-gating`.

- [ ] **Step 5: Validate plugin + commit**

Run: `claude plugin validate plugins/rkt`
Expected: no errors (hooks.json recognized).
```bash
git add plugins/rkt/hooks/ tests/test-hooks-gating.sh
git add plugins/rkt/.claude-plugin/plugin.json 2>/dev/null || true   # only if Step 0 found an edit is needed
# (linear-index-pull.sh and the skill were created/committed in Task 2)
git commit -m "feat(linear-index): Claude-only SessionStart/Stop refresh hooks (self-gated)"
```
If Step 0 determined no `plugin.json` edit is needed (Claude auto-discovers
`hooks/hooks.json`), do NOT stage `plugin.json` — an unmodified file muddies the
commit.

---

## Task 4: `/scan` upgrade — propose+create milestones & epics

**Files:**
- Modify: `plugins/rkt/skills/scan/SKILL.md` (add hierarchy stage before issue creation)
- Modify: `plugins/rkt/skills/create-issue/SKILL.md` (accept `--parent`/`--milestone` passthrough + `Epic` label note)

**Interfaces:**
- Consumes: `linear api` GraphQL mutations `projectMilestoneCreate`/`Update`,
  `linear issue create --parent RKT-N --milestone "<name>"`.
- Produces: `rkt.json` cached maps `linear.milestones{}` (phase→id),
  `linear.epics{}` (slug→id) for idempotent reuse.

- [ ] **Step 1: Verify the milestone mutation shape**

Run (heredoc-stdin form, per Global Constraints):
```bash
linear api <<'GRAPHQL'
query { __type(name:"ProjectMilestoneCreateInput") { inputFields { name } } }
GRAPHQL
```
Expected: input fields incl. `name`, `projectId`, `targetDate`, `description`.
Record exact names; if the mutation/input name differs, adjust below.

- [ ] **Step 2: Add the hierarchy stage to `scan/SKILL.md`**

Insert a new step between the current "Present findings" (Step 5) and "Create
issues" (Step 6):
- Cluster findings into milestones (from `INDEX.md` phases, current+next only)
  and epics (by domain/feature area).
- Present the proposed hierarchy via the host's native structured question tool
  as a SEPARATE approval gate (list milestones create/reuse, epics create/reuse,
  and nesting). No `read`.
- On approval, for each new milestone: check `rkt.json .linear.milestones["<phase>"]`;
  if present reuse the id; else `linear api` `projectMilestoneCreate` and write
  the returned id back into `rkt.json` via `jq`.
- For each epic: check `.linear.epics["<slug>"]`; else `linear issue create
  --label Epic --project "$PROJECT_NAME" ...`, capture `RKT-N`, store in `rkt.json`.
- When filing findings, pass `--parent <epicId's RKT-N>` and `--milestone "<name>"`.
Include a "never create hierarchy without the gate" guardrail and an idempotency
note (reuse by cached id, name-match only as fallback). **No automated test for
this cache round-trip (skill-prose logic); verify in the smoke check by running
`/scan` twice on the same findings and confirming no duplicate milestones/epics
appear in Linear.**

- [ ] **Step 3: Update `create-issue/SKILL.md`**

In the Label Reference, add an `Epic` row noting it is a **Linear-only** label on
parent issues (not in the GitHub manifest). In Step 4, document optional
`--parent RKT-N` and `--milestone "<name>"` flags on `linear issue create` for
callers (scan) that nest issues.

- [ ] **Step 4: Smoke-check the docs render + commit**

Run: `claude plugin validate plugins/rkt`
Expected: no errors.
```bash
git add plugins/rkt/skills/scan/SKILL.md plugins/rkt/skills/create-issue/SKILL.md
git commit -m "feat(scan): propose+create milestones and epics with cached-id idempotency"
```

---

## Task 5: `/bootstrap` Linear project enrichment (Step N6/N7)

**Files:**
- Modify: `plugins/rkt/skills/bootstrap/SKILL.md` (Step N6 create + repo-link follow-up; A6 for adopt)

**Interfaces:**
- Consumes: verified `projectCreate`/`projectUpdate` field names.
- Produces: enriched Linear project (description, summary, links, icon/color) +
  optional seeded milestones from `INDEX.md`.

- [ ] **Step 1: Verify project mutation fields**

Run (heredoc-stdin form):
```bash
linear api <<'GRAPHQL'
query { c: __type(name:"ProjectCreateInput") { inputFields { name } }
        u: __type(name:"ProjectUpdateInput") { inputFields { name } } }
GRAPHQL
```
Expected: confirm `description`, `content`/`summary`, `icon`, `color`, and the
link mechanism (`ProjectUpdateInput` links vs a separate `attachmentCreate`).
Record the real field names. Do NOT ship guessed names.

- [ ] **Step 2: Enrich the N6 create mutation**

In `bootstrap/SKILL.md` Step N6, extend the `projectCreate` input to pass
`description` (overview markdown: what/preset/stack/phase list built from
`INDEX.md`) and the one-line summary field (per Step-1 finding). Keep the
existing failure-tolerant wrapper (warn, set empty, continue).

- [ ] **Step 3: Add repo-link + icon/color + milestone seeding**

After Step N7 (remote known), add a best-effort `projectUpdate` (or
`attachmentCreate`) attaching the git repo URL as a project link, plus
`icon`/`color` defaults. Add optional milestone seeding: for each `INDEX.md`
phase, `projectMilestoneCreate` and store ids in `rkt.json .linear.milestones{}`
(shared with Task 4). All wrapped in warn-and-continue.

- [ ] **Step 4: Mirror into A6 (adopt path)**

Apply the same enrichment in the ADOPT "create new" branch (Step A6).

- [ ] **Step 5: Validate + commit**

Run: `claude plugin validate plugins/rkt`
Expected: no errors.
```bash
git add plugins/rkt/skills/bootstrap/SKILL.md
git commit -m "feat(bootstrap): enrich Linear project (overview, repo link, milestones)"
```

---

## Task 6: `/create-issue` index refresh integration

**Files:**
- Modify: `plugins/rkt/skills/create-issue/SKILL.md` (Step 6: refresh index)

**Interfaces:**
- Consumes: `plugins/rkt/scripts/linear-index-pull.sh` (Task 3) or `/rkt:linear-sync`.
- Produces: fresh `LINEAR.md` after single-issue creation (best-effort).

- [ ] **Step 1: Add the refresh step**

In `create-issue/SKILL.md` after issue creation (Step 6 report), add: if
`LINEAR.md` exists and `linear.project_id` set, run the shared pull+render
(`linear-index-pull.sh`) to regenerate `LINEAR.md`, then note it in the report.
On any failure, skip silently (next sync heals). Do NOT hand-append rows — always
regenerate via the render script (single ordering source of truth).

- [ ] **Step 2: Validate + commit**

Run: `claude plugin validate plugins/rkt`
Expected: no errors.
```bash
git add plugins/rkt/skills/create-issue/SKILL.md
git commit -m "feat(create-issue): regenerate LINEAR.md after issue creation"
```

---

## Task 7: Cross-cutting — docs, templates, decisions, version bump

**Files:**
- Modify: `plugins/rkt/CHANGELOG.md`
- Modify: `plugins/rkt/.claude-plugin/plugin.json`, `plugins/rkt/.codex-plugin/plugin.json` (version lockstep)
- Modify: `plugins/rkt/README.md`
- Modify: `AGENTS.md` (repo) + project-facing AGENTS.md template if bootstrap ships one
- Modify: `decisions.md`

**Interfaces:**
- Consumes: all prior tasks (documents them).
- Produces: released, documented capability.

- [ ] **Step 1: AGENTS.md / templates — note LINEAR.md**

Add a line to the repo `AGENTS.md` "Session Start" list and any bootstrapped
project template: "`LINEAR.md` — local mirror of the Linear backlog; grep it
before querying Linear."

- [ ] **Step 2: README user docs**

Document `/rkt:linear-sync`, the `LINEAR.md` index (Linear-as-truth cache), the
scan epic/milestone flow, and that hooks are Claude-only (Codex = on-demand).

- [ ] **Step 3: decisions.md entry**

Append a dated entry: Linear-as-truth / regenerable-cache model, and the net-new
plugin hooks subsystem (self-gated, Claude-only v1).

- [ ] **Step 4: CHANGELOG + version lockstep**

Prepend a NEW dated version section to `plugins/rkt/CHANGELOG.md` matching the
existing format (`## 0.x.0 — YYYY-MM-DD`; the file does NOT use `[Unreleased]`).
Bump BOTH manifest versions by one minor. Verify: `jq -r .version
plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json`
returns the same value.

- [ ] **Step 5: Full test + validate + commit**

Run: `for t in tests/test-*.sh; do bash "$t" | tail -1; done`
Expected: every line `PASS ...`.
Run: `claude plugin validate plugins/rkt`
Expected: no errors.
```bash
git add plugins/rkt/CHANGELOG.md plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json plugins/rkt/README.md AGENTS.md decisions.md
git commit -m "docs+release: Linear repo-index feature, minor version bump"
```

---

## Requirement → Task Map

| Spec requirement | Task |
|---|---|
| C1 `LINEAR.md` deterministic render | Task 1 |
| C2 sync skill, GraphQL pull, pagination, dedicated commit | Task 2 |
| C2 refresh triggers (SessionStart/Stop, gating, Claude-only, Codex verify) | Task 3 |
| C3 scan epics+milestones, approval gate, cached-id idempotency | Task 4 |
| C4 bootstrap enrichment (overview/summary/links/icon/milestones) | Task 5 |
| C5 create-issue index refresh (regenerate, not append) | Task 6 |
| C5 PR ↔ issue backfill | Task 1 (render) + Task 2 (normalize attachment→PR) |
| Glyph map incl. triage/unknown fallback | Task 1 |
| Epic = Linear label, not GitHub manifest | Task 4 |
| rkt.json additive fields (throttle, milestones, epics) | Tasks 2/3/4/5 |
| Labels/decisions/AGENTS/README/CHANGELOG/version lockstep | Task 7 |
| Fix pre-existing `--project-id` bug + `--limit 0` (now in scope) | Task 0 |
