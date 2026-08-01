# feedback-loop: user feedback to verified PR, without opening an editor

**Date:** 2026-08-01
**Status:** Design, revised after blind review, pending user review
**Targets:** rkt plugin (minor: new skill + new templates). Actual bump happens
at release time per AGENTS.md Release Flow; this header is intent, not a
pre-commitment.
**Source:** a public post by eric zakariasson, 31 Jul 2026, describing the
pattern. Retrieved via authenticated browser; `x.com` is not fetchable
anonymously, so treat the attribution as read-but-not-independently-verifiable.

## Problem

Every consumer-facing project Davies ships accumulates two kinds of work he does
not want to do: triaging user feedback, and fixing the small bugs behind it.
Both require opening the project, reconstructing what the user was doing, and
context-switching into a codebase that may be weeks cold.

The pattern removes that: feedback filed in-app lands in PostHog with the
submitted text, session replay, events and errors; an agent picks it up with
that context plus live read-only PostHog access; it loops until the fix
verifies; it opens a PR with tests; the human reviews on a phone.

The pattern is not the hard part. Making it *repeatable* is. Standing this up on
a new project today means hand-wiring a PostHog project, a survey, a webhook
destination, an agent environment, an MCP connection, a verification convention
and a dispatch path — per project, from memory, differently each time. That cost
is high enough that it never happens, so the feedback loop exists on zero
projects instead of all of them.

## Goal

One command in any rkt project takes it from zero to a working feedback loop:
in-app widget, PostHog wiring, agent dispatch, verified PR, phone review. Under
ten minutes per project after the first, on web and on iOS, with no step that
requires clicking through a third-party dashboard.

## Non-goals

- **Deduplication.** Ten reports of one bug produce ten PRs. Accepted for v1.
  Designing dedup against imagined volume produces the wrong abstraction.
- **The `$exception` auto-dispatch path.** Errors are self-triggering and noisy.
  Error tracking is still *enabled* (the agent reads exceptions as context) but
  does not *dispatch*.
- **Session-replay mining, event-log anomaly mining, cron dedup agents.**
- **Multi-repo projects.** One rkt project maps to one repo.
- **Agent merge authority.** The agent opens PRs. It never merges, never pushes
  to the default branch, never force-pushes.
- **`backend` preset support.** A headless service has no in-app feedback
  surface. The skill refuses on `preset: backend`.
- **Replacing rkt's issue flow.** This does not touch Linear or
  `rkt:create-issue`.

## Design

### Shape: one dispatch path, two execution targets

```
in-app widget
  → PostHog: survey completed
  → CDP webhook destination
  → POST /repos/:o/:r/actions/workflows/feedback-fix.yml/dispatches
  → GitHub Actions: feedback-fix.yml
      ├─ surface=web → POST https://api.cursor.com/v1/agents  (Cursor cloud VM)
      └─ surface=ios → self-hosted macOS runner, Claude Code headless
  → poll to completion → collect artifacts → open PR
```

An earlier revision routed the web path through a **Cursor Automation** with a
webhook trigger. That is not buildable as a one-command setup: the Cloud Agents
REST API (`POST /v1/agents`, runs, artifacts, sub-tokens, `/v1/me`,
`/v1/models`, `/v1/repositories`) exposes **no endpoint for creating or managing
Automations**, and the docs state webhooks are "coming soon". An Automation can
only be created by hand in the Agents Window or at cursor.com/automations, which
would put a dashboard step and a hand-pasted prompt in the middle of the flow.

Routing both surfaces through one GitHub Actions workflow removes that, and
carries four further consequences that are each independently worth having:

1. **The prompt lives in the repo** for both surfaces, so it versions with the
   code and cannot drift from `rkt.json`.
2. **We control the payload end to end**, so context is carried directly. No
   dependence on undocumented Cursor webhook-body interpolation.
3. **One claiming algorithm** for both surfaces instead of two.
4. **The token in PostHog drops to `Actions: write`** (see Keys and scopes).

### Surface routing

`rkt.json:preset` is the single source of truth for platform. There is no
separate `platform` field.

| `preset` | Behaviour |
|---|---|
| `web` | web workflow only |
| `ios` | iOS workflow only |
| `full` | both installed; the surface is routed per-event from PostHog's `$lib` property (`web` vs `ios`), which identifies the SDK that sent it |
| `backend` | refused at step 1 |

### Claiming, concurrency and idempotency

The earlier revision used "push an empty `feedback/<id>` branch" as a lock. It is
not one: two agents branching from the same base push an identical SHA, so the
second push is accepted as a no-op rather than rejected, and both believe they
hold the claim. It also leaked — nothing ever deleted those branches, so a
`max_concurrent` counted from them would deadlock permanently after N lifetime
reports.

Both are replaced by mechanisms GitHub already provides.

**Mutual exclusion — Actions concurrency groups.** The workflow declares:

```yaml
concurrency:
  group: feedback-${{ inputs.feedback_id }}
  cancel-in-progress: false
```

GitHub serialises runs per group server-side. Two simultaneous dispatches for one
`feedback_id` cannot execute concurrently. This is a real lock, not a race we
have argued is unlikely.

**Idempotency — pull requests, not branches.** Before doing any work the workflow
runs `gh pr list --state all --head "feedback/<feedback_id>"`. A merged or closed
PR persists indefinitely, so a re-fired webhook for already-handled feedback
exits cleanly. Branches were the wrong record because they are deleted on merge.

**Concurrency limit — open PRs, not branches.**
`gh pr list --label feedback --state open` counts in-flight work. Merged and
closed PRs drop out of the count naturally, so the limit self-releases and cannot
deadlock. Above `max_concurrent`, the workflow exits with a logged reason and no
agent is launched.

### The verification gate, and what enforces it

One contract for both surfaces. The agent may only produce a **ready** PR when:

1. The reported behaviour was reproduced, and the agent states how.
2. A test exists that **fails before** the fix and **passes after**, with both
   runs shown.
3. The full existing suite passes.
4. The app builds and launches.
5. The affected flow was driven end to end — browser click-through on web,
   simulator interaction via XcodeBuildMCP on iOS — and captured as screenshots.
6. The PR body links the PostHog session replay, quotes the feedback text, and
   carries the `feedback_id`.

The gate is prose in a prompt, which is not enforcement. **The workflow, not the
agent, opens the PR**, and it is the enforcement point: the agent must emit a
structured result (`reproduced`, `test_added`, `suite_green`, `flow_verified`,
each boolean, plus artifact references). The workflow asserts all four. All true
→ ready PR, `feedback` + `verified` labels. Any false → **draft** PR titled
`[unverified: <reason>]`, `feedback` label only. An agent cannot open a ready PR
by asserting in prose that it was careful.

### Artifacts

Cursor cloud agents run in an isolated VM with a full desktop environment, can
start dev servers, drive a browser, and produce screenshots, videos and log
references. Posting those into a GitHub PR directly is gated behind an opt-in
dashboard setting, and the resulting links are "long, unguessable URLs that are
viewable without authentication" — unacceptable for a private app's screen
recordings.

The workflow therefore pulls artifacts itself via `GET /v1/agents/{id}/artifacts`
and `.../artifacts/download`, and attaches them to the PR using the run's
`GITHUB_TOKEN`. No dashboard toggle, no unauthenticated URLs, and the same code
path serves the iOS runner's simulator screenshots.

Cursor also auto-retries CI failures on PRs it creates, capped at 10 follow-ups.
This is a **Teams-tier feature** and the design does not depend on it. The
"loops until verified" behaviour comes from the agent's own loop inside a single
run, which the workflow polls to completion.

### PostHog provisioning

Driven through the PostHog MCP the session is already authenticated against.
Verified present in the live tool listing:

| Object | Tool |
|---|---|
| Feedback survey | `survey-create`, then `survey-launch` |
| Webhook destination | `cdp-function-templates-list`, `cdp-functions-create` |
| Error tracking config | `error-tracking-settings-update` |
| Response retrieval | `surveys-responses-list` |

**Project scoping.** The MCP carries an active project for the session. The skill
calls `switch-project` to the target project ID before any provisioning call and
verifies with `project-get`, rather than trusting whatever the session was last
pointed at. The provisioning key needs write scope on surveys, hog functions and
error tracking; the MCP **hides scope-gated tools rather than erroring**, so a
missing scope presents as "tool does not exist". The skill treats a missing
expected tool as a scope problem and says so, instead of reporting API drift.

**Destination filter.** `survey sent` fires per *question answered* when partial
response collection is on, so a filter on `$survey_id` alone dispatches N times
for one report. The destination filters on the event, `$survey_id` equal to the
survey this skill created, **and `$survey_completed = true`**.

**Reading the response.** Answers are stored as `$survey_response_<question_uuid>`,
not `$survey_response`; the unsuffixed form only exists in the legacy
single-question shape. Rather than templating a UUID-suffixed property name into
the payload, the destination carries only identifiers (`feedback_id`,
`survey_id`, `distinct_id`, `session_id`, `surface`, `synthetic`) and the agent
resolves the text via `surveys-responses-list`, which resolves question text
server-side and returns the session ID.

**Two objects with no MCP tool.**

- **Project creation** — `POST /api/organizations/:organization_id/projects/` is
  documented. The skill calls it directly and, on failure, stops with the exact
  UI step rather than provisioning into the wrong project.
- **The read-only personal API key** — no documented endpoint exists, and it is
  chicken-and-egg regardless. One-time manual step with the exact settings path
  and required scopes.

**Destination mechanism decision.** v1 uses a CDP webhook destination
(`cdp-functions-create`), not the newer `workflows-*` product, despite PostHog
now steering toward Workflows. A destination is one templated HTTP call with no
branching or delay semantics, which is exactly the surface area this design
needs; Workflows adds scheduling and conditional behaviour that would overlap
confusingly with the workflow-level concurrency controls above. Workflows is the
right home for triage and dedup when those land, and that is when to revisit it.
This is a decision, not a deferral.

### Keys and scopes

| Credential | Holder | Scope | Notes |
|---|---|---|---|
| PostHog provisioning key | Davies's machine, setup only | write: surveys, hog functions, error tracking | never leaves the setup session |
| PostHog agent key | Cursor Secrets (web) / GitHub Actions secret (iOS) | **read-only** | never written to a committed file |
| GitHub token | PostHog destination config | **Actions: write**, one repo | see below |
| Cursor API key | GitHub Actions secret | account-scoped | web surface only |
| `ANTHROPIC_API_KEY` | GitHub Actions secret | — | iOS surface only |

**Why `workflow_dispatch` and not `repository_dispatch`.** `POST /repos/{o}/{r}/dispatches`
requires **Contents: write**, which also permits pushing arbitrary code — a poor
thing to store in a third-party SaaS destination config.
`POST /repos/{o}/{r}/actions/workflows/{id}/dispatches` requires **Actions: write**,
which cannot push code. Same trigger, strictly smaller blast radius. This costs
a `ref` in the payload and caps inputs at 25 properties, neither of which binds.

**No secret is committed.** `.cursor/mcp.json` is a version-controlled file, so
it carries `${env:...}` references only; the values come from Cursor's Secrets UI
(encrypted, injected as environment variables at run time). The iOS equivalent
uses GitHub Actions secrets and an explicit `--mcp-config`. An implementation
task confirms `${env:...}` substitution behaves for an **HTTP**-transport MCP
server; it is documented for stdio. If it does not, the PostHog MCP is
configured over stdio instead — the design does not depend on the transport.

## Components

### 1. Widget layer

**Web** — `posthog-js` with session replay and exception autocapture on. The
PostHog survey renders the feedback-button widget, so no custom UI ships.

**iOS** — `posthog-ios`, iOS 15.0+, SDK 3.56.0+ for surveys and 3.6.0+ for
replay. iOS surveys render natively but **do not support the feedback-button
presentation type**, nor URL targeting, shuffle, partial responses or custom
position. A small trigger affordance therefore *does* ship on iOS — one button
that activates the survey. Session replay on iOS is also thinner than web, so
the iOS prompt weights events and breadcrumbs more heavily and does not assume a
usable replay exists.

### 2. Agent configuration, written into the target repo

**Both surfaces**

- `.github/workflows/feedback-fix.yml` — `on: workflow_dispatch` with typed
  inputs, the concurrency group, the idempotency and limit checks, the surface
  branch, artifact collection, gate assertion and PR creation. Must exist on the
  **default branch** to be dispatchable.
- `docs/feedback-loop.md` — runbook: what was provisioned, what to click if it
  breaks, how to disable it, how to re-run the smoke test.

**Web**

- `.cursor/environment.json` — `install`, `start`, and `ports` (a **top-level**
  array of `{port, name}` objects, not a terminal property). `snapshot` and
  `build.dockerfile` are left unset so Cursor's default base image applies; a
  project needing system packages must add `build.dockerfile` by hand, and the
  runbook says so.
- `.cursor/mcp.json` — PostHog MCP, `${env:...}` for the key.
- `.cursor/rules/feedback-fix.mdc` — the verification gate as a repo rule, so it
  binds every agent in the repo rather than only this flow.

**iOS**

- `.mcp.json` — PostHog MCP and XcodeBuildMCP.
- The runner job invokes `claude -p` with an explicit `--mcp-config`. Claude
  Code's `--bare` mode **skips MCP server discovery** and keychain auth, so MCP
  config is passed explicitly and authentication comes from `ANTHROPIC_API_KEY`.
  `anthropics/claude-code-action@v1` is the alternative and is evaluated during
  implementation; the choice does not change the contract.

**Dev command inference.** `plugins/rkt/scripts/detect-stack.sh` emits only
`target`, `suggested_preset` and boolean signals — no install command, start
command or port. It is **not extended** by this work. The skill reads candidate
commands from `package.json` scripts, presents them for confirmation using the
host's native structured question tool, and writes what the user confirms.

### 3. The standing prompt

One template under `plugins/rkt/templates/feedback-loop/`, rendered into the
repo, with surface-conditional verification steps. It instructs the agent to
gather context from PostHog MCP, reproduce, fix under the verification gate, and
emit the structured result the workflow asserts on. It does **not** open the PR.

### 4. Config

A `feedback` block **merged into `rkt.json` with `jq` at skill time**. It is
deliberately *not* added to `plugins/rkt/templates/rkt.json.tmpl`:
`render-template.sh` hard-fails on any unresolved `{{TOKEN}}`, so adding it there
would force every preset and every `bootstrap` run to supply feedback tokens and
would touch `tests/test-bootstrap-new.sh` and `tests/test-bootstrap-adopt.sh`.
Bootstrap is untouched by this work.

```json
"feedback": {
  "enabled": true,
  "repo": "daviesayo/example",
  "ref": "main",
  "max_concurrent": 3,
  "lookback_hours": 24,
  "posthog": {
    "host": "https://us.posthog.com",
    "project_id": "492861",
    "survey_id": "01999e...",
    "destination_id": "01999f..."
  }
}
```

Surface comes from `preset`. `lookback_hours` bounds the response query and
removes the "bounded window" ambiguity.

## Package layout

Per AGENTS.md Package Shape and Runtime Paths:

```
plugins/rkt/skills/feedback-loop/SKILL.md
plugins/rkt/templates/feedback-loop/
  feedback-fix.yml.tmpl
  environment.json.tmpl
  cursor-mcp.json.tmpl
  feedback-fix.mdc.tmpl
  standing-prompt.md.tmpl
  runbook.md.tmpl
tests/test-feedback-loop.sh
```

No root-level duplicate directories. `SKILL.md` opens with the standard host
portability block resolving
`RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"`
before referencing any bundled file, and never references `./scripts/`. All
interactive points use the host's native structured question tool; bash `read`
is not used.

## Skill flow

`/rkt:feedback-loop` in the target project:

1. Read `rkt.json`. Refuse if absent or if `preset` is `backend`.
2. Preflight:
   - `gh` authenticated with write access to the repo.
   - **iOS only:** repo is **private** (refuse on public — see Failure modes),
     and a self-hosted macOS runner carrying the explicit `rkt-ios` label is
     registered and online.
   - Required PostHog MCP tools are visible (a missing one means a missing
     scope, not API drift).
3. Read candidate dev commands from `package.json`; confirm with the user.
4. Provision PostHog: `switch-project`, verify, then project (or REST, or
   prompt), survey, launch, destination, error tracking, agent key (or prompt).
5. Install the SDK and widget wiring into the app.
6. Render templates into the repo.
7. Set secrets: `gh secret set` for `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` /
   `POSTHOG_AGENT_KEY`; instruct on Cursor Secrets for the web MCP key.
8. Merge the `feedback` block into `rkt.json`.
9. Smoke test.
10. Report what was created, with links.

Re-running reconciles rather than duplicating, and never creates a second survey.
Because the standing prompt now lives in the repo, reconciliation covers it —
which was not true when it lived in a Cursor dashboard.

## Testing

**Repo-level (`tests/test-feedback-loop.sh`)**, idempotent, temp dirs and cleanup
traps per AGENTS.md:

- Rendered `environment.json`, `cursor-mcp.json` and the merged `rkt.json` are
  valid JSON, and `ports` is a top-level array of objects.
- `feedback-fix.yml` parses, declares the concurrency group, and targets the
  `rkt-ios` label on the iOS job. It asserts the **label**, not an OS string:
  runner labels are case-insensitive and GitHub does not validate that a runner
  actually runs the OS its label claims.
- Re-running against a project that already has a `feedback` block does not
  duplicate configuration.
- The skill refuses with no `rkt.json`, and refuses on `preset: backend`.

**Smoke test, run by the skill at step 9.** Fires a synthetic survey response
carrying `synthetic: true`, then asserts the workflow run appears and exits
successfully. The workflow **short-circuits on `synthetic`**: it validates the
payload, confirms secrets resolve, and exits 0 **without launching an agent**.
This proves widget → destination → dispatch → workflow, which is the whole
fragile chain, without burning agent credits or opening a junk draft PR on every
bootstrap. The synthetic response is excluded from analytics.

## Failure modes

| Failure | Behaviour |
|---|---|
| Mac runner offline (iOS) | Preflight fails at setup. At run time the job queues, and GitHub fails it after **24 hours**. |
| Target repo is public (iOS) | Refused at preflight. GitHub's guidance is that self-hosted runners should almost never be used on public repos, because any user can open a PR and compromise the environment. |
| Agent cannot reproduce | Draft PR, `[unverified: could not reproduce]`, with what it tried. |
| Test written but suite red | Draft PR, `[unverified: suite failing]`. |
| Agent claims success falsely | Workflow asserts the structured result; unset flags force a draft PR regardless of prose. |
| `max_concurrent` reached | Exit, logged, no agent launched. Count releases as PRs close. |
| Duplicate dispatch, same `feedback_id` | Concurrency group serialises; the second run finds the existing PR and exits. |
| Inferred dev commands wrong | Agent cannot start the server; draft PR names the command it tried. Fix `environment.json` once. |
| PostHog scope missing | Reported as a scope problem with the required scopes, not as API drift. |
| Duplicate reports, different IDs | Duplicate PRs. Known and accepted for v1. |

## Known gaps, shipped deliberately

- **No dedup.** Per scope decision.
- **The iOS runner executes LLM-authored code on Davies's primary Mac**, with a
  GitHub token, an Anthropic key and a PostHog key present. Private-repo-only
  narrows the fork-PR attack surface but does not eliminate the fundamental
  exposure. Accepted knowingly; a dedicated machine or VM is the real fix if
  this ever runs on anything shared.
- **iOS depends on the Mac being awake and online.** Checked at setup, never
  silently degraded.
- **iOS session replay is thinner than web**, and iOS ships a small custom
  trigger because feedback-button surveys are unsupported there.
- **Two PostHog objects need a one-time manual fallback.**
- **`${env:...}` substitution for HTTP-transport MCP is unconfirmed**; stdio is
  the documented fallback.
- **`environment.json` cannot express system dependencies** without a
  hand-written `build.dockerfile`.

## Requirements coverage

| Requirement | Where it is met |
|---|---|
| Repeatable across any project | Skill flow, one command, idempotent, no dashboard step |
| Works on web | Cursor cloud agent via `POST /v1/agents` |
| Works on mobile | Self-hosted macOS runner, real simulator |
| Feedback carries text, replay, events, errors | Widget layer + `surveys-responses-list` + PostHog MCP |
| Agent has live read-only PostHog | Agent MCP, read-only key, never committed |
| Loops until verified | Agent's own loop within a run; workflow polls to completion. Explicitly **not** dependent on Cursor's Teams-tier CI auto-retry. |
| Opens a PR with tests | Gate conditions 2 and 3, asserted by the workflow |
| Reviewed on a phone | GitHub PR with artifacts attached via `GITHUB_TOKEN` |
| Selectable agent runtime | **Partial in v1.** The workflow's surface branch is the switch point and `provider` can be added there without touching provisioning, widget or gate. v1 implements Cursor on web and Claude Code on iOS only. |
| Zero hosted infrastructure | No service Davies operates: GitHub Actions, one PostHog destination, one self-hosted runner. No worker, no database. |

## References

- Cursor Cloud Agents API endpoints — https://cursor.com/docs/cloud-agent/api/endpoints
- Cursor cloud agent capabilities — https://cursor.com/docs/cloud-agent/capabilities
- Cursor environment schema — https://cursor.com/schemas/environment.schema.json
- GitHub fine-grained token permissions — https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- GitHub self-hosted runner security — https://docs.github.com/en/actions/reference/security/secure-use
- PostHog survey SDK feature support — https://posthog.com/docs/surveys/sdk-feature-support
- PostHog survey partial responses — https://posthog.com/docs/surveys/troubleshooting
- PostHog projects API — https://posthog.com/docs/api/projects
- Claude Code headless — https://code.claude.com/docs/en/headless
- `docs/specs/2026-04-17-rkt-plugin-design.md`
