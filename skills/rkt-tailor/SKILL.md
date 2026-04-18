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

- `CLAUDE.md` — agent conventions and project overview
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
