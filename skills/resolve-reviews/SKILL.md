---
name: resolve-reviews
description: Use when open PRs have unaddressed automated review comments from Codex, Claude, or other bot reviewers. Triggers on "resolve reviews", "fix review comments", "address codex feedback", "handle automated reviews", "resolve bot suggestions", "fix PR feedback", "what did codex say", "reviews are in", or any request to act on bot reviewer suggestions across open PRs.
---

# Resolve Reviews

You are the review-to-fix pipeline. GitHub's `@claude` and other bot reviewers
leave findings on PRs — your job is to read those findings, classify them, and
dispatch domain agents to implement the fixes. You do NOT run your own review.

**UX principle:** All interactive prompts use the `AskUserQuestion` tool — never bash
`read` or free-text options. This is a Claude-invoked workflow and should feel native
inside Claude Code.

**Same orchestration pattern as `/implement`:** domain agents are lean workers.
You read all context once and inject the relevant bits into each agent's prompt.

## Step 0: Read project config

```bash
PREFIX=$(jq -r .linear.issue_prefix rkt.json)
MP=$(jq -r .mempalace.specialist_prefix rkt.json)
```

## Step 1: Discover review comments

```bash
# Get all open PRs
gh pr list --state open --json number,title,headRefName,body

# For each PR, get review-level comments (approve/request-changes)
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
gh api repos/$REPO/pulls/$PR_NUM/reviews \
  --jq '.[] | select(.user.login | test("\\[bot\\]$|^claude$")) | {author: .user.login, state: .state, body: .body}'

# Get inline comments (file-specific suggestions)
gh api repos/$REPO/pulls/$PR_NUM/comments \
  --jq '.[] | select(.user.login | test("\\[bot\\]$|^claude$")) | {author: .user.login, path: .path, line: .line, body: .body}'
```

**Bot detection:** `claude[bot]`, `chatgpt-codex-connector[bot]`, `github-actions[bot]`,
or any login matching `[bot]$`.

**Extract from each inline comment:**
- PR number, branch name
- File path, line number
- Priority badge (P0/P1/P2/P3) — parse from badge image alt text if present
- Full suggestion body

**Skip** reviews with no inline comments or only "looks good" / approval body.

## Step 2: Classify each finding

For every finding, assign one of three classifications:

| Classification | Criteria | Action |
|---|---|---|
| **Actionable** | Clear code change needed — bug, missing validation, security issue, convention violation | Dispatch to domain agent |
| **Already handled** | The suggestion describes something that's already correct in the code, or was fixed in a later commit on the same branch | Dismiss with reason |
| **Needs user decision** | Architectural disagreement, ambiguous trade-off, or the fix would change product behavior | Flag for user decision |

To classify accurately:
1. Read the actual file at the line referenced (not just the diff) — the reviewer
   may have missed context
2. Check `git log --oneline HEAD~5..HEAD -- {file}` on the PR branch to see if
   a later commit already addressed it
3. If the suggestion contradicts an existing pattern used elsewhere in the codebase,
   classify as "Needs user decision" — don't silently override established patterns

## Step 3: Domain routing

| Path pattern | Agent |
|---|---|
| `backend/app/**`, `backend/tests/**` | `backend-implementer` |
| `backend/supabase/**` | `database-implementer` |
| `ios/**` | `ios-implementer` |
| `web/**` | `web-implementer` |

### Cross-domain detection

Parse PR branch `${PREFIX}-XX/[domain]/description` to determine the PR's domain. If a
suggestion's fix lives in a different domain:

1. Look for an open sibling PR matching `${PREFIX}-XX/[target-domain]/*`
2. **Sibling exists and addresses concern** → mark as dependency, note merge order.
   No agent dispatch.
3. **No sibling or sibling doesn't address it** → dispatch target domain's agent.
   Create worktree if needed.

## Step 4: Confirmation gate

Use `AskUserQuestion` to present all three classifications and get confirmation
before dispatching anything:

> **Review findings for ${PREFIX}-XX:**
>
> **Actionable** (will dispatch):
> | PR | Reviewer | Priority | File | Suggestion | Domain |
> |---|---|---|---|---|---|
> | #72 | claude | P1 | `routes.py:108` | Add input validation | backend |
>
> **Already handled** (will dismiss):
> | PR | Finding | Reason |
> |---|---|---|
> | #72 | Missing null check | Fixed in commit abc123 |
>
> **Needs your call:**
> | PR | Finding | Trade-off |
> |---|---|---|
> | #72 | Suggests async rewrite | Contradicts sync pattern used in all other routes |

Options:
> - `[Dispatch actionable fixes]` — proceed with dispatching agents
> - `[Review each item]` — go through findings one by one
> - `[Cancel]` — abort, no agents dispatched

Always pause if any P0/P1 findings or more than 2 actionable items. Auto-dispatch
only for ≤2 low-priority items with no architectural implications.

## Step 5: Gather context (once)

Read once, distill per-domain:
- `docs/decisions/agent_learnings.md` — domain-relevant pitfalls
- `decisions.md` — recent decisions affecting the fixes
- `git worktree list` — existing worktrees

Only pass each agent the context relevant to its specific fix.

## Step 6: Dispatch domain agents

Use the `Agent` tool with `subagent_type` matching the domain:
`backend-implementer`, `database-implementer`, `ios-implementer`, `web-implementer`

**Parallel:** Different worktrees/files → dispatch with `run_in_background: true`
**Sequential:** Same file in same worktree → one at a time

### Agent prompt template

```
You are fixing review feedback on PR #{pr_number}.

## Worktree
All work in: `{worktree_path}`
Branch: `{branch_name}` (open PR #{pr_number})

## Fixes
{for each actionable finding assigned to this agent:}
### Fix {n}: {summary}
**File:** `{file_path}`, line {line_number}
**Reviewer:** {reviewer_name} ({priority})
**Problem:** {full_suggestion_body}
**What to change:** {specific fix description}

## Context
- {relevant agent_learnings entries}
- {relevant decisions}
- {cross-domain context if needed}

## Steps
1. Make all fixes
2. Run checks:
   - backend: cd {worktree}/backend && uv run pytest tests/ -v
   - database: cd {worktree}/backend && supabase db push --local --include-all
   - ios: Xcode build on device (check rkt.json for device name)
   - web: cd {worktree}/web && npm run build && npm run lint
3. Commit: `[Review] Fix: {description}`
4. Push: `git push origin {branch_name}`

Do NOT modify files outside your domain or touch shared files.

Return: what changed, whether checks passed.
```

## Step 7: Re-request review

After fixes are pushed, re-request the automated review so the reviewer can
verify the fixes:

```bash
# Post comment to trigger @claude re-review
gh pr comment $PR_NUMBER --body "@claude please review this PR"
```

## Step 8: Update MemPalace

If actionable fixes uncovered recurring patterns (a class of bug that keeps appearing,
a convention that agents keep missing), write a diary entry to `${MP}-reviewer`:

```
mempalace_diary_write(
  agent_name="${MP}-reviewer",
  topic="[area/pattern name]",
  entry="[COMPRESSED] PR:[PR-NUM] found:[pattern description]. Recurring: [yes/no]. Fix: [what to do differently]. Watch: [what to look for in future reviews]."
)
```

Skip this step if the fixes were one-off and don't reveal a pattern.

## Step 9: Report

> **Review resolution complete:**
>
> | PR | Fixes applied | Status |
> |---|---|---|
> | #72 | 3 actionable fixes pushed | Tests pass, re-review requested |
> | #72 | 1 already handled | Dismissed (fixed in abc123) |
> | #72 | 1 needs user decision | Async rewrite — contradicts sync pattern |
>
> {N} fixes pushed, {M} dismissed, {K} flagged for your decision.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Running a full independent review instead of acting on existing findings | You are the fixer, not a second reviewer. Read and act on what's already there. |
| Dispatching agent for cross-domain issue that sibling PR already addresses | Check for sibling PRs first, just note merge order |
| Sending two agents to same worktree in parallel | Queue them sequentially — they'll clobber each other |
| Creating new PRs for review fixes | Always commit to the existing PR branch |
| Dumping all context on every agent | Distill only what's relevant to each fix |
| Skipping classification — treating all findings as actionable | Always classify first. Some findings are stale or need human judgment. |
| Auto-fixing something that contradicts an established codebase pattern | Classify as "Needs user decision" — don't override patterns silently |
| Using text menus instead of AskUserQuestion | All prompts must use AskUserQuestion |
