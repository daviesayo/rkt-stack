---
name: implement
description: Use when planning is done and the user wants to build. Triggers on "implement this", "build this", "let's do it", "ship this feature", "kick off implementation", "start building", "go build", "execute the plan", "architect this", or when the user has a plan/spec ready for agents. Also triggers when the user provides a Linear issue ID to implement (e.g. "implement RKT-42" or "implement MCO-7").
---

# Implement

You bridge planning and execution. Your job: take whatever plan exists, package it
into a Linear issue, decompose the work into domain tasks, and spawn domain agents
directly from this session. You are the orchestrator — you do NOT hand off to an
architect subagent.

**UX principle:** All interactive prompts use the `AskUserQuestion` tool — never bash
`read` or free-text options. This is a Claude-invoked workflow and should feel native
inside Claude Code.

**You are the single context gatherer.** Domain agents are lean workers — they don't
read CLAUDE.md, decisions.md, agent_learnings.md, or query MemPalace themselves.
You read everything once and inject the relevant context into each agent's prompt.
This is critical for token efficiency.

## Why you orchestrate directly

Domain agents are the leaf nodes — they code, test, and PR. The orchestration
(decomposition, worktree creation, agent spawning, result collection) runs here
in the main session because:
- You have the correct PATH and environment
- You can spawn agents via the Agent tool reliably (one hop, not two)
- The user can see what's happening and intervene if needed

## Step 0: Read project config

Before doing anything else, read the project config:

```bash
PREFIX=$(jq -r .linear.issue_prefix rkt.json)
PROJECT_ID=$(jq -r .linear.project_id rkt.json)
PROJECT_NAME=$(jq -r .project_name rkt.json)
MP=$(jq -r .mempalace.specialist_prefix rkt.json)
LINEAR=$(which linear 2>/dev/null || echo /opt/homebrew/bin/linear)
```

Use these variables throughout. Never hardcode project names, prefixes, or IDs.

## Step 1: Gather the plan

Look at the current conversation for plan artifacts. Extract:

- **What** is being built (feature name, one-line summary)
- **Why** it matters (user problem, product goal)
- **Scope** — what's in, what's explicitly out
- **Technical decisions** made during planning (architecture, API shapes, schema changes, design patterns)
- **Acceptance criteria** — how do we know it's done?

If any of these are missing or ambiguous, ask the user before proceeding via
`AskUserQuestion`. Don't guess scope.

## Step 2: Create the Linear issue (or use an existing one)

**If the user provided a Linear issue ID** (e.g. "implement ${PREFIX}-42"), read the issue:
```bash
$LINEAR issue view ${PREFIX}-[N]
```
Then skip to Step 3.

**If no issue exists yet**, create one from the plan:

```bash
cat > /tmp/rkt-issue-desc.md <<'EOF'
## Description
[What needs to be done — clear, specific, derived from the plan]

## Requirements
- [ ] [Specific deliverable from the plan]
- [ ] [Another deliverable]

## Context
- **Source:** [Which planning skills were used: /office-hours, /plan-eng-review, etc.]
- **Domain:** [Which domains are affected: database / backend / ios / web]
- [Key technical decisions from planning — architecture, API shapes, schema, design patterns]
- [What's explicitly out of scope, if relevant]

## Acceptance Criteria
- [ ] [How we verify it's done — tests pass, flow works end-to-end, etc.]
EOF

$LINEAR issue create \
  --title "[concise title]" \
  --description-file /tmp/rkt-issue-desc.md \
  --project-id "$(jq -r .linear.project_id rkt.json)"
```

Show the user the issue ID and a brief summary. Use `AskUserQuestion` to confirm:

> Use `AskUserQuestion` with options:
> - `[Proceed]` — continue with this issue
> - `[Edit first]` — pause to adjust before continuing
> - `[Cancel]` — abort

## Step 3: Gather all context (once, for all agents)

This is where you do the expensive reads — **once** — so agents don't have to.

**Read project files:**
- `PROGRESS.md` — current implementation state
- `OPS.md` — production sync state (especially for database tasks)
- `decisions.md` — recent decisions (scan for ones relevant to this feature)
- `docs/decisions/agent_learnings.md` — pitfalls relevant to the affected domains

**Extract GitHub PR labels from the Linear issue:**

Labels split into two categories:
- **Type labels** (apply to ALL PRs for this issue): `Bug`, `Feature`, `Improvement`, `Ops`
- **Domain labels** (apply only to the matching domain's PR): `Backend`, `Database`, `iOS`, `Web`

```bash
# Get labels via Linear GraphQL API (issue view --json doesn't include labels)
$LINEAR api --variable issueId="${PREFIX}-[N]" <<'GRAPHQL' | python3 -c "
import json, sys
data = json.load(sys.stdin)
labels = [l['name'] for l in data['data']['issue']['labels']['nodes']]
print('Labels:', labels)
"
query(\$issueId: String!) { issue(id: \$issueId) { labels { nodes { name } } } }
GRAPHQL
```

Note the type labels and domain labels separately — you'll pass the right combination
to each agent in Step 6.

**Query MemPalace** — read diaries for `${MP}-architect`, `${MP}-reviewer`, and
`${MP}-ops` (if database domain involved). Search for the feature/area name in the
relevant wing. Use the MemPalace MCP tools (`mempalace_diary_read`, `mempalace_search`).

⚠️ **MemPalace tools may take a moment to connect** (ChromaDB startup). If
`mempalace_diary_read` isn't available on first try, use ToolSearch to load the tools:
`ToolSearch(query: "mempalace", max_results: 30)`. If still unavailable after that,
skip MemPalace reads and note it in the report — don't let a disconnected MCP block
the entire implementation.

**Distill what you find into a context brief** for each domain. Only include what's
relevant to that specific agent's task — don't dump everything on every agent.

## Project-specific context

If `.claude/rules/project-*.md` exists (written by `/rkt-tailor`), read the
relevant domain rules and include them in each agent's spawn prompt. Likewise,
if `agents/*.project.md` exists for an agent you're spawning, mention its
presence so the agent loads it at task start.

These project-specific overlays encode business rules and domain conventions
that the generic agents don't know — this is what makes them effective on your
particular codebase.

## Step 4: Decompose into domain tasks

Analyse the issue and determine:

1. **Which domains are affected** — only include domains that need code changes:
   - `database` — new/modified tables, columns, constraints, RLS, RPC functions
   - `backend` — new/modified API endpoints, business logic, rules, tests
   - `ios` — new/modified SwiftUI views, view models, stores, models
   - `web` — new/modified React pages, components, lib utilities

2. **Dependency order** — based on the real dependency chain:

   ```dot
   digraph deps {
       "database needed?" [shape=diamond];
       "backend needed?" [shape=diamond];
       "ios needed?" [shape=diamond];
       "web needed?" [shape=diamond];
       "Spawn database-implementer\n(wait for completion)" [shape=box];
       "Spawn backend-implementer\n(wait for completion)" [shape=box];
       "Spawn ios-implementer" [shape=box];
       "Spawn web-implementer" [shape=box];
       "Done" [shape=doublecircle];

       "database needed?" -> "Spawn database-implementer\n(wait for completion)" [label="yes"];
       "database needed?" -> "backend needed?" [label="no"];
       "Spawn database-implementer\n(wait for completion)" -> "backend needed?";
       "backend needed?" -> "Spawn backend-implementer\n(wait for completion)" [label="yes"];
       "backend needed?" -> "ios needed?" [label="no"];
       "Spawn backend-implementer\n(wait for completion)" -> "ios needed?";
       "ios needed?" -> "Spawn ios-implementer" [label="yes"];
       "ios needed?" -> "web needed?" [label="no"];
       "web needed?" -> "Spawn web-implementer" [label="yes"];
       "web needed?" -> "Done" [label="no"];
       "Spawn ios-implementer" -> "web needed?";
       "Spawn web-implementer" -> "Done";
   }
   ```

   **Key rule:** database and backend are sequential (each waits for completion).
   iOS and web are parallel (spawn both with `run_in_background: true`).
   Skip layers that aren't needed. A backend-only fix is just one agent.

3. **Task description for each domain** — what specifically needs to be built, including
   any cross-domain context (API shapes, schema columns, etc.)

Present the decomposition to the user via `AskUserQuestion`:

> **Decomposition for ${PREFIX}-XX:**
>
> | Order | Domain | Task | Agent |
> |---|---|---|---|
> | 1 | backend | Add auth check to notification endpoints | backend-implementer |
> | 2 (parallel) | ios | Update notification polling interval | ios-implementer |
>
> **Dependencies:** None — backend and iOS are independent here.

Options:
> - `[Spawn agents]` — proceed with this decomposition
> - `[Adjust scope]` — modify before spawning
> - `[Cancel]` — abort

## Step 5: Create worktrees

Only create worktrees for the domains you need:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/new-feature.sh" ${PREFIX}-[N] [short-description] [domain1] [domain2] ...
```

Example: `"${CLAUDE_PLUGIN_ROOT}/scripts/new-feature.sh" ${PREFIX}-42 cron-auth backend` for a backend-only fix. Scripts ship with the rkt plugin — no local `scripts/` folder in the project.

## Step 6: Spawn domain agents

Use the `Agent` tool to spawn each domain agent. Respect the dependency order.

**The prompt you give each agent is critical.** Include the distilled context from
Step 3 so the agent can start working immediately without reading shared files:

```
Linear issue: ${PREFIX}-[N]
Worktree: cd to [full worktree path] before starting work

## Task
[Clear description of what to build in this domain]

## Context from orchestrator
- [Relevant decisions from decisions.md]
- [Relevant pitfalls from agent_learnings.md for this domain]
- [MemPalace findings: reviewer warnings, architect notes, ops state]
- [Cross-domain context: schema from database agent, API shapes from backend, etc.]
- [If present: "Load agents/[domain].project.md at task start for project-specific rules"]
- [If present: "See .claude/rules/project-[domain].md for domain business rules"]

## Acceptance criteria
- [Specific, verifiable outcomes for this domain]

## GitHub PR labels
Apply these labels when creating your PR (use one --label flag per label):
- [Type labels from the issue e.g. Feature, Bug]
- [This domain's label e.g. Backend, iOS, Database, Web]

Example: --label "Feature" --label "Backend"

## Issue prefix
Linear issue prefix: ${PREFIX}
```

Use `subagent_type` matching the agent name: `database-implementer`, `backend-implementer`,
`ios-implementer`, `web-implementer`.

**Sequential phase (if needed):**
- If schema changes needed → spawn `database-implementer`, wait for completion
- If new API endpoints needed → spawn `backend-implementer`, wait for completion

**Parallel phase:**
- Spawn `ios-implementer` and `web-implementer` in parallel (if both needed)
- Use `run_in_background: true` for parallel agents, or spawn both in the same message

## Step 7: Report results

After all agents complete, summarise for the user:
- Which agents completed successfully
- Which PRs were created (with links)
- Any issues or blockers

The `@claude` comment on each PR triggers GitHub's automated review. Once those
reviews land, offer: **"Reviews are in. Want me to run `/resolve-reviews` to
action the feedback?"**

`/resolve-reviews` reads the GitHub review comments, classifies them, and dispatches
domain agents to fix — this is the standard path for acting on review feedback.

The standalone `code-reviewer` agent is available on-demand for high-risk changes
(security, state machines, multi-domain features) when the user specifically asks.
Don't offer it in the standard flow — it duplicates the GitHub review.

## Step 8: Consolidate decisions after merge

After the user merges all PRs, read each PR's `## Decisions` section:
```bash
gh pr view [PR-NUMBER] --json body --jq '.body'
```

Extract decisions from each PR body and prepend them to `decisions.md` using the
standard format: `[YYYY-MM-DD HH:mm] | [decision] | [rationale] | [agent-name]`

This is the **only** place `decisions.md` gets written to during the implement flow.
Agents do NOT write to it directly — that causes merge conflicts when agents work
in parallel worktrees.

**Commit and push** the consolidated decisions and any session-end file updates
(PROGRESS.md, DEVLOG.md, etc.) so main stays in sync with origin:

```bash
git add decisions.md PROGRESS.md DEVLOG.md
git commit -m "[${PREFIX}-XX] Consolidate post-merge decisions and progress"
git push origin main
```

## Step 9: Update MemPalace

Post-merge is the best time to capture what was actually built. Write to the
relevant specialists based on what happened during implementation.

If MemPalace tools aren't available, use ToolSearch first:
`ToolSearch(query: "mempalace", max_results: 30)`. If still unavailable, skip
this step and note it in the report.

**Diary entries** — write as the specialist who owns that area, using AAAK format:

- `${MP}-architect` — what was built, key architectural decisions, patterns established
- `${MP}-reviewer` — code quality observations, recurring issues found during review
- `${MP}-ops` — if database/infra changes were made: migration details, schema evolution

```
# Example diary write after implementing ${PREFIX}-42:
mempalace_diary_write(
  agent_name="${MP}-architect",
  entry="SESSION:2026-04-10|impl.${PREFIX}-42.[feature-name]|arch:[key pattern]|decided:[decision summary]|★★",
  topic="${PREFIX}-42"
)
```

Only write diaries for specialists whose domain was actually touched. Don't write
empty entries just to be complete.

**KG facts** — add structured relationships for significant additions:

```
# Example: new feature, new pattern, new API endpoint
mempalace_kg_add(subject="${PROJECT_NAME}", predicate="has_feature", object="[feature-name]", valid_from="[date]")
mempalace_kg_add(subject="[feature-name]", predicate="uses_pattern", object="[pattern-name]")
mempalace_kg_add(subject="${PROJECT_NAME}-api", predicate="has_endpoint", object="/v1/[path]", valid_from="[date]")
```

Only add KG facts for things a future agent would need to know about — new features,
new patterns, new endpoints, new schema entities. Don't log routine bug fixes.

## Step 10: Check off completed requirements in Linear

After all agents complete and PRs are merged, update the Linear issue to reflect
what was done. Fetch the current description, check off completed items, and update:

```bash
# Fetch current description
$LINEAR api --variable issueId="${PREFIX}-[N]" <<'GRAPHQL' | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['data']['issue']['description'])
" > /tmp/issue-desc-current.md
query($issueId: String!) { issue(id: $issueId) { description } }
GRAPHQL

# Replace completed checkboxes: - [ ] → - [x]
# Only check off items you can verify from agent output (tests passed, code written, PR merged)
# Leave unchecked anything that needs user judgment

# Write updated description
$LINEAR issue update ${PREFIX}-[N] --description-file /tmp/issue-desc-updated.md
```

Also update the issue state to "Done" if all boxes are checked:
```bash
$LINEAR issue update ${PREFIX}-[N] --state "Done"
```

## Step 11: Clean up worktrees

**Pre-flight: always run cleanup from the main repo directory, never from
inside a worktree.** If you `cd`'d into a worktree earlier in the session to
do manual work, `cd` back out first:

```bash
# If in any doubt, return to the main repo root before cleanup
MAIN_REPO=$(git worktree list --porcelain | awk '/^worktree / { print $2; exit }')
cd "$MAIN_REPO"
```

The cleanup script itself guards against this (`ensure_out_of_worktrees`) but
being explicit keeps the shell state sane for anything that runs after:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-feature.sh" ${PREFIX}-[N]
```

## Common Mistakes

| Mistake | Fix |
|---|---|
| Spawning an architect subagent | You ARE the orchestrator — run decomposition inline |
| Writing application code yourself | Domain agents write code. You orchestrate. |
| Skipping Linear issue creation | The issue is the coordination point — always create or reference one |
| Assuming scope not in the plan | Ask if ambiguous. Don't guess. |
| Creating worktrees for uninvolved domains | Only create worktrees for domains that need code changes |
| Spawning all 4 agents when only 1-2 are needed | Match agents to actual scope |
| Telling agents to read CLAUDE.md / decisions.md / agent_learnings.md | You already gathered context — inject the relevant bits in their prompt |
| Spawning ios + web before backend completes | Respect dependency order: database → backend → (ios \| web) |
| Hardcoding "RKT-" or project name | Always read from rkt.json via jq |
| Using text menus instead of AskUserQuestion | All prompts must use AskUserQuestion — never bash read |
