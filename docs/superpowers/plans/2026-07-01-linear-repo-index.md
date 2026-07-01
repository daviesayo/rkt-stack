# Linear Repo-Index + Scan/Bootstrap Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give rkt-bootstrapped repos a committed, agent-greppable `LINEAR.md`
backlog index (Linear-as-truth, regenerable cache), plus epic/milestone support
in `/scan` and richer Linear project setup in `/bootstrap`.

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
- Bump BOTH manifests (`plugins/rkt/.claude-plugin/plugin.json`, `plugins/rkt/.codex-plugin/plugin.json`) in lockstep; prepend a `plugins/rkt/CHANGELOG.md` `[Unreleased]` entry (AGENTS.md "Making Changes").
- Tests idempotent: temp dirs, cleanup traps, stub `linear`/`gh` (AGENTS.md "Guardrails").
- Linear reads/writes go through `linear` CLI + `linear api` GraphQL, NOT the Linear MCP.
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

## Task 1: Deterministic render script `render-linear-index.sh`

Pure function: reads a Linear GraphQL JSON payload (issues + milestones +
epics/parents + PR links) on stdin, writes `LINEAR.md` to stdout. No network. The
one thing everything else depends on; fully TDD-able with fixtures.

**Files:**
- Create: `plugins/rkt/scripts/render-linear-index.sh`
- Create: `tests/test-linear-index-render.sh`
- Create: `tests/fixtures/linear-index/basic.json`
- Create: `tests/fixtures/linear-index/expected-basic.md`
- Create: `tests/fixtures/linear-index/paginated-60.json` (>50 issues)

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

render_children() { # milestoneFilterExpr
  local mfilter="$1"
  # epic parents in this milestone, by issue number
  local epics
  epics=$(jq -r --argjson mf "$mfilter" '[.issues[]|select(.isEpic==true)|select('"$mfilter"')]|sort_by(.id|ltrimstr("RKT-")|tonumber)|.[].id' <<<"$payload")
  # direct (non-epic, no parent) issues first
  local directs
  directs=$(jq -r '[.issues[]|select(.isEpic==false and .parentId==null)|select('"$mfilter"')]|sort_by(.id|ltrimstr("RKT-")|tonumber)|.[].id' <<<"$payload")
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
    local kids; kids=$(jq -r --arg e "$eid" '[.issues[]|select(.parentId==$e)]|sort_by(.id|ltrimstr("RKT-")|tonumber)|.[].id' <<<"$payload")
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

- [ ] **Step 7: Add the pagination-coverage test**

Create `tests/fixtures/linear-index/paginated-60.json` with 60 issues
(`RKT-1`..`RKT-60`, no milestone, no epic — generate with a one-off `jq`/loop and
paste the result). Append to `tests/test-linear-index-render.sh` before the final
echo:
```bash
# 3. all 60 issues render (guards truncation)
count=$("$SCRIPT" < "$FIX/paginated-60.json" | grep -c '^| RKT-')
[ "$count" -eq 60 ] || fail "expected 60 issue rows, got $count"
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
- Create: `plugins/rkt/scripts/linear-index-normalize.jq` (raw GraphQL → Task-1 shape)
- Create: `tests/test-linear-index-normalize.sh`
- Create: `tests/fixtures/linear-index/raw-graphql.json`

**Interfaces:**
- Consumes: Task 1 `render-linear-index.sh`.
- Produces: the GraphQL query text (in SKILL.md) and `linear-index-normalize.jq`
  transforming raw `data.project` GraphQL into `{project,syncedAt,milestones,issues}`.
  The skill sets `syncedAt` by piping `--arg now "$(date -u +%FT%TZ)"`.

- [ ] **Step 1: Confirm the GraphQL shape against the CLI (task-0 verification)**

Run: `linear api <<< 'query{__type(name:"ProjectMilestone"){fields{name}}}'`
and `linear api <<< 'query{__type(name:"Issue"){fields{name}}}'`
Expected: field names exist for `milestone`, `parent`, `state{type}`,
`labels{nodes{name}}`, `attachments`/`links` (for PR). Record the exact field
names; if they differ from the query below, adjust the query in Step 3. Do NOT
proceed on guessed names.

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

- [ ] **Step 6: Write the skill file**

Create `plugins/rkt/skills/linear-sync/SKILL.md` with frontmatter (name:
`linear-sync`, description triggering on "sync linear", "refresh backlog index",
"update LINEAR.md", "rebuild the linear index") and body covering:
1. Resolve `RKT_PLUGIN_ROOT`; `source .../lib/common.sh; require_linear || exit 1`.
2. Read `PROJECT_ID`/`PROJECT_NAME` from `rkt.json`.
3. Run the paginated GraphQL query (loop on `pageInfo.hasNextPage`/`endCursor`,
   accumulate `issues.nodes`) via `linear api`, writing raw JSON to a temp file.
   Include the exact query (project by `id`, `issues(first:250,after:$cursor){nodes{identifier title state{type} labels{nodes{name}} projectMilestone{id} parent{identifier} attachments{nodes{url}}} pageInfo{hasNextPage endCursor}} projectMilestones{nodes{id name targetDate}} name url`).
4. Normalize: `jq --arg now "$(date -u +%FT%TZ)" -f "${RKT_PLUGIN_ROOT}/scripts/linear-index-normalize.jq" raw.json > norm.json`.
5. Render: `"${RKT_PLUGIN_ROOT}/scripts/render-linear-index.sh" < norm.json > LINEAR.md`.
6. Commit ONLY `LINEAR.md` as its own atomic commit (`chore(linear): sync
   backlog index`) if `git diff --quiet LINEAR.md` is false; otherwise report
   "index already current" and commit nothing. Never `git add -A`.
7. On any Linear failure: warn, leave existing `LINEAR.md` untouched, exit 0.
Include a "Common Mistakes" table mirroring the other skills (no `--project-id`,
must paginate, never hand-edit `LINEAR.md`, never stage unrelated files).

- [ ] **Step 7: Register the skill + commit**

Verify the skill is discovered: `claude plugin validate plugins/rkt`
Expected: no errors.
```bash
git add plugins/rkt/skills/linear-sync/SKILL.md plugins/rkt/scripts/linear-index-normalize.jq tests/test-linear-index-normalize.sh tests/fixtures/linear-index/raw-graphql.json
git commit -m "feat(linear-sync): add /rkt:linear-sync skill + GraphQL normalizer"
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

- [ ] **Step 0: Verify Codex plugin-hook loading (blocking gate)**

Check official Codex plugin docs for whether a plugin-packaged `hooks/hooks.json`
with `SessionStart`/`Stop` is auto-loaded. If unconfirmed, keep hooks
**Claude-only**: do NOT add a hooks key to `.codex-plugin/plugin.json`; note the
limitation in the skill/README. Record the finding in the commit message.

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
stub="$tmp/bin"; mkdir -p "$stub"; printf '#!/usr/bin/env bash\nexit 0\n' > "$stub/linear"; chmod +x "$stub/linear"

# (a) non-rkt dir: silent exit 0, no output
out=$(cd "$tmp" && PATH="$stub:$PATH" bash "$REFRESH" 2>&1) || fail "refresh non-zero in non-rkt dir"
[ -z "$out" ] || fail "refresh emitted output in non-rkt dir: $out"
out=$(cd "$tmp" && PATH="$stub:$PATH" bash "$NUDGE" 2>&1) || fail "nudge non-zero in non-rkt dir"
[ -z "$out" ] || fail "nudge emitted output in non-rkt dir"

# (b) rkt dir with empty project_id: still silent exit 0
echo '{"linear":{"project_id":""}}' > "$tmp/rkt.json"
out=$(cd "$tmp" && PATH="$stub:$PATH" bash "$REFRESH" 2>&1) || fail "refresh non-zero with empty id"
[ -z "$out" ] || fail "refresh acted with empty project_id"
echo "PASS test-hooks-gating"
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bash tests/test-hooks-gating.sh`
Expected: FAIL (hook scripts do not exist).

- [ ] **Step 3: Implement the shared gate + both hooks**

Create `plugins/rkt/hooks/linear-index-refresh.sh`:
```bash
#!/usr/bin/env bash
# SessionStart hook: throttled index refresh. Inert outside rkt Linear repos.
set -euo pipefail
[ -f rkt.json ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
pid=$(jq -r '.linear.project_id // ""' rkt.json 2>/dev/null || echo "")
[ -n "$pid" ] || exit 0
command -v linear >/dev/null 2>&1 || exit 0

throttle=$(jq -r '.linear.index_throttle_minutes // 30' rkt.json 2>/dev/null || echo 30)
if [ -f LINEAR.md ]; then
  synced=$(sed -n 's/.*synced: \([0-9T:-]*Z\).*/\1/p' LINEAR.md | head -1)
  if [ -n "$synced" ]; then
    last=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$synced" +%s 2>/dev/null || date -d "$synced" +%s 2>/dev/null || echo 0)
    now=$(date -u +%s); age=$(( (now - last) / 60 ))
    [ "$age" -lt "$throttle" ] && exit 0
  fi
fi
# Delegate to the sync skill's script path (render only; no commit from hook).
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
[ -n "$RKT_PLUGIN_ROOT" ] || exit 0
# best-effort; never fail the session
( "${RKT_PLUGIN_ROOT}/scripts/linear-index-pull.sh" > /dev/null 2>&1 ) || exit 0
exit 0
```

> Note: extract the GraphQL-pull+normalize+render (Task 2 steps 3-5, WITHOUT the
> commit) into `plugins/rkt/scripts/linear-index-pull.sh` so both the skill and
> this hook share one implementation (DRY). The skill commits; the hook does not.
> Add that extraction as part of this step and update Task 2's SKILL.md to call it.

Create `plugins/rkt/hooks/linear-index-nudge.sh`:
```bash
#!/usr/bin/env bash
# Stop hook: no network. Nudge if LINEAR.md missing or stale. Inert outside rkt.
set -euo pipefail
[ -f rkt.json ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
pid=$(jq -r '.linear.project_id // ""' rkt.json 2>/dev/null || echo "")
[ -n "$pid" ] || exit 0
command -v linear >/dev/null 2>&1 || exit 0
if [ ! -f LINEAR.md ]; then
  echo "rkt: LINEAR.md missing — run /rkt:linear-sync to build the backlog index."
  exit 0
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
git add plugins/rkt/hooks/ plugins/rkt/scripts/linear-index-pull.sh tests/test-hooks-gating.sh plugins/rkt/.claude-plugin/plugin.json plugins/rkt/skills/linear-sync/SKILL.md
git commit -m "feat(linear-index): Claude-only SessionStart/Stop refresh hooks (self-gated)"
```

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

Run: `linear api <<< 'mutation{__type(name:"ProjectMilestoneCreateInput"){inputFields{name}}}'`
Expected: input fields incl. `name`, `projectId`, `targetDate`, `description`.
Record exact names; if the mutation name differs, adjust below.

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
note (reuse by cached id, name-match only as fallback).

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

Run: `linear api <<< 'mutation{__type(name:"ProjectCreateInput"){inputFields{name}}}'`
and `... "ProjectUpdateInput" ...`.
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

Prepend a `[Unreleased]` CHANGELOG entry summarizing the feature. Bump BOTH
manifest versions by one minor. Verify: `jq -r .version
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
| Follow-up: fix pre-existing `--project-id` in other skills | out of scope (separate issue) |
