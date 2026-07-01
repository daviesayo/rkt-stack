# Linear Repo-Index + Scan/Bootstrap Enrichment — Design

Date: 2026-07-01
Status: Approved (brainstorm), pending spec review
Scope: `plugins/rkt` — `/rkt:linear-sync` (new), `/rkt:scan`, `/rkt:create-issue`, `/rkt:bootstrap`, plugin hooks

## Problem

Coding agents working in an rkt-bootstrapped repo have no fast, local reference
for what work exists in Linear. Every "what's left to build / what's done"
question costs a Linear GraphQL round-trip, and there is no committed artifact a
human can read in the GitHub UI. Separately, `/scan` only creates flat issues
(no epics/milestones), and `/bootstrap` creates a bare Linear project (labels
only — no overview, no repo link, no milestones).

## Goals

1. A committed, human-readable, agent-greppable index of the project's Linear
   issues that answers "what exists / what's done / what's open" without hitting
   the API.
2. Keep that index fresh through explicit and ambient refresh triggers.
3. Upgrade `/scan` to propose and create milestones + epics (with approval)
   instead of only flat issues.
4. Enrich `/bootstrap`'s Linear project creation: overview, one-line summary,
   git repo link, icon/color, and seed milestones from project phases.

## Non-Goals (v1)

- Index-as-truth or bidirectional push to Linear (Linear stays authoritative).
- Per-issue local brief cache (`.rkt/linear/RKT-N.md`). Deferred; `/implement`
  keeps doing one `linear issue view` at build time.
- GitHub Action that mutates the index on PR merge.
- Linear Initiatives (cross-project; rkt is one-project-per-repo).

## Source-of-Truth Model

**Linear is authoritative. `LINEAR.md` is a regenerable cache.**

- The index is never hand-edited by humans and never pushed back to Linear.
- Sync always regenerates the file wholesale from Linear's current state. This
  eliminates two-writer conflicts and merge conflicts on the file.
- "Mark done on PR merge" is NOT a bespoke feature: Linear's native GitHub
  integration already transitions an issue to Done when its linked PR merges.
  The next reconcile pulls that Done state. The refresh triggers are the only
  mechanism needed.

## Linear Primitive Mapping (grounded, not invented)

Linear has no native "epic" object. Verified primitives: Initiatives (above
projects) → Projects → Milestones (inside a project) → Issues (with parent /
sub-issue nesting via `parentId`).

| rkt concept | Linear primitive | Notes |
|---|---|---|
| Milestone | native project **Milestone** | name, description, targetDate. Maps to `INDEX.md` phases. |
| Epic | **parent issue** + `Epic` label, sub-issues via `parentId` | Only epic-like primitive inside a single project. |
| Project overview | project `description` (markdown) + `summary` (≤255 chars) | Bootstrap enrichment. |
| Repo link | project `links` `[{url, title}]` | Added after `origin` is known. |

**Implementation path:** all Linear reads/writes go through the `linear` CLI and
`linear api` (GraphQL), consistent with existing rkt skills — NOT the Linear
MCP. The MCP was used only to confirm the data model.

**CLI-flag reality (verified against installed `linear` v2.0.0):** `linear issue
list` exposes `--project <name>` (NOT `--project-id`), `--milestone` (requires
`--project`), and `--limit <n>` (**default 50**, `0` = unlimited). `linear issue
create` exposes `--project`, `--parent <RKT-N>`, and `--milestone <name>`.

Consequences for this design:
- **The sync READ path uses `linear api` GraphQL keyed by the project UUID**
  (`rkt.json:linear.project_id`), NOT `linear issue list --project-id`. One
  GraphQL query returns issues (fully paginated), their state *type*, labels,
  milestone, parent/sub-issue edges, and attachment links (PRs). This avoids the
  non-existent `--project-id` flag and the 50-issue truncation default in one
  move.
- Where a skill must shell to the CLI (e.g. `/create-issue` creating an issue),
  it uses the real flags: `--project "$PROJECT_NAME"`, `--parent RKT-N`,
  `--milestone "<name>"`. Never `--project-id` on the CLI.
- Project mutations (create, description/summary/links, milestone create/update)
  use `linear api` GraphQL — the CLI does not expose them.

**Pre-existing `--project-id` usage (out of scope, noted):** existing skills
(`create-issue`, `scan`, `implement`) already invoke `linear issue list
--project-id`, which does not exist on CLI v2.0.0. That is a pre-existing bug
this design does not fix, but the new sync path must NOT propagate it. Filing a
separate issue to correct the existing skills is recommended (see QoL / follow-up).

## Component 1: The Index File — `LINEAR.md`

- **Location:** repo root. **Committed** (not gitignored) — visibility in the
  GitHub UI and travel-with-repo are the point.
- **Regenerated wholesale** each sync. Header carries a machine-readable
  "do not edit" marker, project URL, and ISO sync timestamp.
- **Grouping:** milestone → epic → issues, plus a flat "No milestone" bucket and
  (if any) a "No epic" bucket within a milestone.
- **Columns:** ID, Title, Status, Labels (type·domain), PR (linked merged PR # or `—`).

Example:

```markdown
<!-- rkt:linear-index generated by /rkt:linear-sync — do not edit. synced: 2026-07-01T14:03Z -->
# Linear Backlog — {ProjectName}  ·  [open in Linear](https://linear.app/…)

## Milestone: Phase 2 — Core API  (target 2026-07-15)

### Epic RKT-10 — Payments  (In Progress)
| ID | Title | Status | Labels | PR |
|----|-------|--------|--------|----|
| RKT-11 | Add charge endpoint | ✅ Done | Feature·Backend | #42 |
| RKT-12 | Webhook handler | 🔄 In Progress | Feature·Backend | — |

## No milestone
| ID | Title | Status | Labels | PR |
|----|-------|--------|--------|----|
| RKT-30 | Fix null deref | 📋 Todo | Bug·iOS | — |
```

**Status glyph mapping** (Linear state *type*, not display name, so it is
workspace-workflow-agnostic): `triage` → `🔺 Triage`, `backlog`/`unstarted` →
`📋 Todo`, `started` → `🔄 In Progress`, `completed` → `✅ Done`,
`canceled` → `🚫 Canceled`. Any unmapped/unknown type falls back to `❔ <type>`
so a new Linear state can never silently vanish from the index.

## Component 2: Sync Skill — `/rkt:linear-sync`

New skill. Named to avoid collision with the existing `rkt-sync` (template sync).
Canonical skill directory: `plugins/rkt/skills/linear-sync/`.

The skill resolves the plugin root first
(`RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-root>}}"`),
matching `sync-github-labels.sh`.

Steps:
1. `source "${RKT_PLUGIN_ROOT}/scripts/lib/common.sh"; require_linear || exit`
   (reuses existing guard — exits if `rkt.json` missing or `linear.project_id`
   empty). Verified: `common.sh` `require_linear()` parses `rkt.json` in cwd and
   errors when `.linear.project_id` is empty/null.
2. Read `PROJECT_ID`, `PROJECT_NAME`, `PREFIX`, `project_url` from `rkt.json`.
3. Pull data via a **single `linear api` GraphQL query keyed by the project
   UUID** (`PROJECT_ID`) — issues (all statuses, unassigned included, **fully
   paginated** via `pageInfo.hasNextPage`/`endCursor` — never truncate),
   each issue's state *type*, labels, milestone, parent/sub-issue edges, and
   attachment links (PRs). Do NOT use `linear issue list --project-id` (flag does
   not exist; default limit truncates at 50).
4. Render `LINEAR.md` wholesale via the helper script (see below), fed the
   GraphQL JSON. Rendering is **deterministic**: identical Linear state → byte-
   identical file → no-op diff.
5. Commit behavior: the on-demand skill makes its **own dedicated atomic commit**
   (`chore(linear): sync backlog index`) touching ONLY `LINEAR.md`, so the index
   delta never rides inside an unrelated feature diff (AGENTS.md atomic-commit
   discipline). If the render is a no-op (no change), commit nothing. The skill
   never `git add -A` / never stages other files. On `main`, follow the repo's
   commit-authorization norms (this is a mechanical, self-contained doc-style
   commit, in the same class as label sync).

**Rendering helper:** `plugins/rkt/scripts/render-linear-index.sh` — takes the
GraphQL/CLI JSON on stdin (or a temp file path) and emits `LINEAR.md`. Keeping
the render in a script (not inline skill prose) makes it testable via
`tests/test-*.sh` with fixture JSON. The skill orchestrates; the script renders.

### Refresh Triggers (belt-and-suspenders)

1. **On-demand:** invoke `/rkt:linear-sync` directly. **Works on both Claude Code
   and Codex** — this is the portable, always-available trigger.
2. **Session-start reconcile (Claude Code only, v1):** a `SessionStart` hook
   refreshes the index when a session opens in an rkt repo.
3. **Stop nudge (Claude Code only, v1):** a `Stop` hook that flags when
   `LINEAR.md` is stale relative to session activity and reminds the agent/user
   to run sync. Drift-visibility surrogate for the (impossible) local "PR merged"
   hook.

**Cross-tool caveat `[unverified]`:** Claude Code plugin hooks (`SessionStart`,
`Stop`) are well-supported. Whether Codex auto-loads a *plugin-packaged*
`hooks/hooks.json` is **not confirmed against first-party Codex docs**, and
`plugins/rkt/.codex-plugin/plugin.json` currently declares only `skills` (no
hooks key). Therefore v1 scopes hooks as **Claude-only** and does NOT claim
ambient refresh on Codex. Codex users get trigger 1 (on-demand) only.
Implementation task 0 for the hooks slice = verify Codex plugin-hook loading
against official docs; if confirmed, wire the Codex manifest; if not, leave
Codex on-demand-only and document it. Never assert Codex hook support without a
first-party citation.

Neither hook stages or commits `LINEAR.md`. The `SessionStart` refresh writes the
working-tree file only (leaves it modified/uncommitted); committing is the
on-demand skill's job. Hooks never run `git add`.

**Hook gating (critical):** hooks must be inert outside rkt Linear repos. Each
hook script first checks: `rkt.json` exists AND `.linear.project_id` is
non-empty AND the `linear` CLI is available. If any check fails → exit 0
silently (no output, no error). This prevents the plugin's hooks from firing
noise in every unrelated repo the user opens.

**Hook cost control:** the `SessionStart` hook does a network pull on every
session. To bound cost, it is a **throttled** refresh: skip if `LINEAR.md` was
synced within the last N minutes (default 30, read from an env/`rkt.json`
field), using the header timestamp. The `Stop` hook does NO network call — it
only compares the file timestamp/marker against a cheap local signal and prints
a reminder; it never pulls.

Hooks ship as `plugins/rkt/hooks/hooks.json` + scripts under
`plugins/rkt/hooks/`. This is net-new infra (rkt has no hooks today); keep the
scripts generic and self-gating.

## Component 3: `/scan` Upgrade — Epics + Milestones

Insert a hierarchy stage into the existing present→approve→create flow, without
disturbing the current issue-creation path.

1. **Cluster** findings:
   - Milestones from `INDEX.md` phases (current + next phase scope only, per
     existing scan discipline).
   - Epics by feature area / domain cluster.
2. **Present** proposed hierarchy via the host's native structured question tool
   — a SEPARATE approval gate before the existing issues table. Show:
   milestones to create/reuse, epics to create/reuse, and which findings nest
   where.
3. On approval:
   - Create-or-reuse milestones via `linear api` GraphQL
     (`projectMilestoneCreate` / `projectMilestoneUpdate` — NOT the MCP tool name
     `save_milestone`, which does not exist in `linear api`). Field names
     (`projectMilestoneCreate` input shape) are `[unverified]` — confirm against
     the installed CLI's GraphQL schema in task 0 of this slice.
   - Create-or-reuse epic parent issues (Linear label `Epic`) via `linear issue
     create`.
   - File findings via `/create-issue`, passing the real CLI flags
     `--parent RKT-N` (epic) and `--milestone "<name>"` so each lands in the
     hierarchy.
4. **Never** create hierarchy without the gate.
   - **Idempotency via cached Linear IDs, not name match.** When scan creates a
     milestone/epic it records the returned Linear ID in a mapping under
     `rkt.json` (`linear.milestones{}` / `linear.epics{}`, keyed by phase name /
     epic slug). Re-runs reuse by ID; name-match is only a fallback for
     pre-existing objects created outside scan. This closes the
     duplicate-on-typo / concurrent-run race that pure name-matching leaves open.

New Linear label **`Epic`** on parent issues. This is a **Linear** label
(created via the Linear label API / `linear` CLI on the team), distinct from the
GitHub label manifest in `templates/github-labels.json` — epics never get PRs, so
`Epic` is NOT added to the GitHub label set. See Cross-Cutting.

## Component 4: `/bootstrap` Linear Enrichment (Step N6)

When creating the Linear project, populate beyond labels using already-available
info (preset, `PROGRESS.md`/`INDEX.md`, git remote):

- **`summary`** — one-line description (≤255 chars).
- **`description`** — real overview markdown: what the project is, preset/stack,
  phase list from `INDEX.md`, key links.
- **`links`** — git repo URL, added after `origin` is known (post Step N7, or
  when linking an existing repo). `[{url, title: "Repository"}]`.
- **`icon` / `color`** — sensible defaults so the project is not blank.
- **Milestones (optional-on by default):** seed project milestones from
  `INDEX.md` phases so structure exists day one.

All enrichment is idempotent and failure-tolerant: on any Linear API failure,
warn and continue (matches existing "do not abort bootstrap" pattern). Repo-link
attach is a separate best-effort call so a project created before the remote
exists can still get the link later.

The project-create mutation gains `description`/`summary` fields; a follow-up
`projectUpdate` (or link mutation) adds the repo link once `origin` is known.

**`[unverified]` — uniform GraphQL-shape verification required:** the existing N6
mutation (`bootstrap/SKILL.md`) passes only `name` + `teamIds`. The exact field
names for the enrichment (`summary` vs `content`, whether `projectCreate` accepts
`description` inline, the `links`/attachment mutation shape, `icon`/`color`
inputs) are unverified against the installed CLI's GraphQL schema. Task 0 of this
slice = confirm each field against `linear api` schema introspection or official
Linear API docs (verify-against-docs, not memory). Do not ship guessed field
names.

## Component 5: Quality-of-Life Extras

- **`/create-issue` refreshes the index** immediately after creating an issue by
  invoking the same render path (`render-linear-index.sh` fed a fresh GraphQL
  pull), NOT by hand-inserting a row. This avoids a second, divergent
  grouping/sorting implementation living in skill prose (which could disagree
  with the render script and leave `LINEAR.md` inconsistent until the next full
  sync). Best-effort: on any failure (no `LINEAR.md`, Linear unreachable), skip
  silently — the next `/rkt:linear-sync` heals it. Single writer, single
  ordering source of truth.
- **Staleness banner:** `LINEAR.md` header shows last-sync ISO time; the `Stop`
  hook uses it to decide whether to nudge.
- **PR ↔ issue backfill:** during sync, read merged PRs via `gh` and populate the
  PR column for Done issues. Best-effort: if `gh` unavailable or no remote, leave
  `—`.

## Cross-Cutting

- **Labels — two distinct systems, do not conflate:**
  - `Epic` is a **Linear** label (on parent issues), created via the Linear label
    API on the team. It is NOT added to `templates/github-labels.json` (epics have
    no PRs). `/create-issue`'s label reference gains an `Epic` row noting it is
    Linear-only.
  - The GitHub label manifest (`sync-github-labels.sh`) is unchanged by this work.
  - Already-bootstrapped repos: the `Epic` Linear label is created lazily by
    `/scan` on first epic creation (create-or-reuse), so no re-bootstrap is
    needed. Note this in the scan skill.
- **rkt.json new fields (additive, non-breaking; absent → defaults):**
  - `linear.index_throttle_minutes` (default 30) — SessionStart throttle.
  - `linear.milestones{}` / `linear.epics{}` — cached Linear IDs for idempotent
    scan reuse (see C3).
- **AGENTS.md / templates:** note `LINEAR.md` as the local backlog reference so
  agents grep it first; regenerate the project-facing AGENTS.md template if the
  bootstrap ships one.
- **decisions.md:** append an entry recording (a) the Linear-as-truth /
  regenerable-cache model and (b) the net-new plugin hooks subsystem, per the
  project's append-only decisions-log convention.
- **CHANGELOG + version bump:** minor bump (new skill + new capabilities). Update
  `plugins/rkt/CHANGELOG.md` `[Unreleased]` and both manifest versions
  (`.claude-plugin/plugin.json` + `.codex-plugin/plugin.json`) in lockstep.
- **Docs:** update `plugins/rkt/README.md` (user-facing) and `AGENTS.md` where
  the new skill/hooks are relevant, in the same commit as the code.

## Testing

- `tests/test-linear-index-render.sh`: feed fixture JSON (issues + milestones +
  epics + PR links) to `render-linear-index.sh`, assert grouping, glyphs, PR
  column, header marker/timestamp. Pure function of input — no network.
- `tests/test-hooks-gating.sh`: run each hook script in (a) a non-rkt dir, (b) an
  rkt dir with empty `project_id`, (c) a fully-configured stub — assert silent
  exit 0 in (a)/(b), action only in (c). Stub the `linear` CLI.
- Idempotency: run render twice on the same fixture → identical output
  (deterministic ordering).
- `tests/test-linear-index-pagination.sh`: fixture with >50 issues across pages →
  assert every issue appears (guards the truncation failure mode).
- Keep tests hermetic: temp dirs, cleanup traps, stubbed `linear`/`gh`.

## Open Questions / Risks

- **Ordering determinism:** issues must sort deterministically (by milestone
  target date, then epic ID, then issue number) so re-syncs produce byte-stable
  diffs. Enforced in the render script + tested (double-render fixture).
- **Pagination (resolved, must-do):** the GraphQL read fully paginates via
  `pageInfo`. The old truncation risk (`linear issue list` default limit 50) is
  designed out by using GraphQL, not the CLI list command. Tested with a
  >50-issue fixture.
- **Large backlogs:** very large projects could make `LINEAR.md` big. Acceptable
  for v1; if it becomes a problem, add per-milestone files later (not now).
- **`linear api` GraphQL shape (`[unverified]`):** the issue/milestone/sub-issue
  read query AND all project/milestone mutation field names must be verified
  against the installed `linear` CLI's GraphQL schema during implementation
  (verify-against-docs, not memory). This is task 0 of the relevant slices.
- **Codex hook loading (`[unverified]`):** see C2 — resolve before building the
  hooks slice.

## Follow-up (separate issue, out of scope here)

- Fix the pre-existing `linear issue list --project-id` usage in
  `/create-issue`, `/scan`, `/implement` — the flag does not exist on CLI v2.0.0.
  File as its own issue; do not bundle into this work.

## Requirement → Component Map

| Requirement | Component |
|---|---|
| Local index of Linear issues | C1 `LINEAR.md` |
| Fresh without per-session API cost | C2 triggers (throttled session-start, on-demand, Stop nudge) |
| "Done on merge" reflected locally | Source-of-truth model + C2 reconcile |
| Scan creates epics + milestones | C3 |
| Bootstrap fills overview + repo link + milestones | C4 |
| Single-issue index freshness | C5 create-issue append |
| PR visibility in index | C5 PR backfill |
| Hooks don't pollute unrelated repos | C2 gating |
