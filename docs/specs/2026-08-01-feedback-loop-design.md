# feedback-loop: user feedback to verified PR, without opening an editor

**Date:** 2026-08-01
**Status:** Design, pending user review
**Targets:** rkt plugin (minor: new skill + new templates). Actual bump happens
at release time per AGENTS.md Release Flow; this header is intent, not a
pre-commitment.
**Source:** [eric zakariasson, 31 Jul 2026](https://x.com/ericzakariasson/status/2083206179254309036)

## Problem

Every consumer-facing project Davies ships accumulates two kinds of work he does
not want to do: triaging user feedback, and fixing the small bugs behind it.
Both require opening the project, reconstructing what the user was doing, and
context-switching into a codebase that may be weeks cold.

The pattern in the source post removes that entirely: feedback filed in-app
lands in PostHog with the submitted text, session replay, events and errors; a
cloud agent picks it up with that context plus live read-only PostHog access;
it loops until the fix verifies; it opens a PR with tests; the human reviews on
a phone.

The pattern is not the hard part. Making it *repeatable* is. Today, standing
this up on a new project means hand-wiring a PostHog project, a survey, a
webhook destination, an agent environment, an MCP connection, a verification
convention and a dispatch path — per project, from memory, differently each
time. That cost is high enough that it never happens, so the feedback loop
exists on zero projects instead of all of them.

## Goal

One command in any rkt project takes it from zero to a working feedback loop:
in-app widget, PostHog wiring, agent dispatch, verified PR, phone review. Under
ten minutes per project after the first, on web and on iOS.

## Non-goals

- **Deduplication.** Ten reports of one bug produce ten PRs. Accepted for v1.
  Triage and dedup are the first thing to add once real volume exists, and
  designing them against imagined volume produces the wrong abstraction.
- **The `$exception` auto-dispatch path.** Errors are self-triggering and noisy;
  one bad deploy fans out into concurrent agents. Error tracking is still
  *enabled* (the agent reads exceptions as context) but does not *dispatch*.
- **Session-replay mining, event-log anomaly mining, cron dedup agents.** The
  source post explicitly frames these as untapped ideas, not a working system.
- **Multi-repo projects.** One rkt project maps to one repo.
- **Agent merge authority.** The agent opens PRs. It never merges, never pushes
  to the default branch, never force-pushes.
- **Replacing rkt's existing issue flow.** This does not touch Linear or
  `rkt:create-issue`. Feedback goes straight to an agent.

## Design

### Shape

Two paths, one event, one payload contract. The path is chosen by `platform`.

**Web**

```
in-app widget → PostHog (survey sent) → CDP webhook → Cursor Automation
  → cloud VM: repo + PostHog MCP (read-only) + dev server + browser
  → PR with screenshots and video
```

**iOS**

```
in-app widget → PostHog (survey sent) → CDP webhook → GitHub repository_dispatch
  → self-hosted macOS runner (Davies's Mac)
  → Claude Code + XcodeBuildMCP + PostHog MCP + real simulator
  → PR with screenshots
```

The split exists because Cursor's cloud agents run in an isolated **Linux** VM.
They have full desktop and browser control, can start dev servers, click through
UI flows, and attach screenshots, videos and log references to the PR
([Cursor cloud agent capabilities](https://cursor.com/docs/cloud-agent/capabilities)).
What they cannot do is boot an iOS simulator. iOS therefore dispatches to a Mac
that can.

### Context delivery: the webhook is a ping, not a payload

Cursor's webhook triggers create a private HTTP endpoint with an API key, and
the automation declares which repository and branch its agents work in. What is
**not documented** is interpolation of the POST body into the agent prompt.

The design does not depend on it. The web webhook is a **wake-up ping**; the
automation carries a standing prompt that pulls its own context from PostHog
over MCP at run time. This is strictly better than an interpolated payload:

- Context is live at execution time, not frozen at trigger time. A replay that
  finished uploading after the webhook fired is still available.
- Two reports landing together degrade into two sequential claims rather than a
  race over one prompt.
- It removes a dependency on an undocumented feature.

The iOS path templates a real payload, because that hop (PostHog → GitHub
`repository_dispatch`) is one we fully control.

### Claiming, concurrency and idempotency, without infrastructure

The web agent must answer "which feedback am I working on, and is someone
already on it?" with no shared state. Git provides both.

1. Agent queries PostHog for the most recent survey responses (bounded window).
2. Agent runs `git ls-remote --heads origin 'feedback/*'`.
3. Any response whose ID already has a `feedback/<feedback_id>` branch is
   claimed; skip it.
4. If the count of open `feedback/*` branches is at or above
   `max_concurrent`, abort with a logged reason and no PR.
5. Otherwise, claim the oldest unclaimed response by creating and immediately
   pushing an empty `feedback/<feedback_id>` branch, then start work.

The remote branch is the lock. It is atomic enough for this volume, needs no
database, and leaves an auditable trail. A stale branch with no PR after a
timeout is a visible failure, not a silent one.

The iOS path carries `feedback_id` in the dispatch payload and uses the same
branch-claim step, so both paths converge on one convention.

### The verification gate

One contract, both platforms. The agent may only open a **normal** PR when all
of these hold:

1. The reported behaviour was reproduced, and the agent states how.
2. A test exists that **fails before** the fix and **passes after**. The agent
   must show both runs.
3. The full existing suite passes.
4. The app builds and launches.
5. The affected flow was driven end to end — browser click-through on web,
   simulator interaction via XcodeBuildMCP on iOS — and captured as screenshots.
6. The PR body links the PostHog session replay, quotes the feedback text, and
   carries the `feedback_id`.

If any condition fails, the agent opens a **draft** PR whose title begins with
`[unverified: <reason>]`. It never opens a normal PR it could not verify, and it
never silently abandons work — a failed attempt is still visible.

Cursor additionally auto-retries its own CI failures on PRs it created, capped
at ten attempts, which covers the "loops until verified" behaviour on the web
path without anything being built here.

### PostHog provisioning

Driven through the PostHog MCP the session is already authenticated against, not
a hand-rolled API client. Verified available:

| Object | Tool |
|---|---|
| Feedback widget | `survey-create`, then `survey-launch` |
| Webhook destination | `cdp-function-templates-list`, `cdp-functions-create` |
| Error tracking config | `error-tracking-settings-update` |

The destination is filtered to the `survey sent` event for the specific
`$survey_id` this skill created, so it cannot be woken by unrelated surveys.

Two objects have **no MCP tool** and need a documented fallback:

- **PostHog project creation.** The skill attempts the REST call and, on
  failure, stops with the exact UI step. It does not proceed against the wrong
  project.
- **The read-only personal API key** the agent's MCP connection uses. Same
  treatment: attempt, else prompt with the exact settings path and required
  scopes.

Both fallbacks are one-time-per-project clicks. Neither is silently skipped.

There is also a native PostHog `workflows-*` product (triggers, actions,
conditions) that may express this more cleanly than a raw CDP destination.
**Implementation task:** evaluate it against `cdp-functions-create` before
building, and pick one. The design is agnostic to which wins; only the
provisioning step changes.

### Keys and scopes

Three credentials, deliberately separated:

| Credential | Holder | Scope |
|---|---|---|
| PostHog provisioning key | Davies's machine, during setup only | write |
| PostHog agent key | Cursor MCP config / GitHub secret | **read-only** |
| GitHub PAT | PostHog destination config | fine-grained, `dispatches` on one repo |

The agent never holds a PostHog write key. The PAT in PostHog cannot do anything
but trigger a workflow on one repository.

## Components

### 1. Widget layer

**Web** — `posthog-js` initialised with session replay on and exception
autocapture on; the PostHog survey renders the widget, so no custom UI ships.

**iOS** — `posthog-ios` with the same three capabilities. Session replay on iOS
is materially thinner than web; the iOS agent prompt therefore weights events
and breadcrumbs more heavily and does not assume a usable replay exists.

### 2. Agent configuration, written into the target repo

**Web**

- `.cursor/environment.json` — install command, start command, ports. The skill
  infers these from the detected stack (`detect-stack.sh`) and states plainly
  that it guessed, so a project with an unusual dev setup is corrected once.
- `.cursor/mcp.json` — PostHog MCP over **HTTP** (Cursor's recommended
  transport), read-only key.
- `.cursor/rules/feedback-fix.mdc` — the verification gate as a rule, so it
  applies to every agent in the repo, not only this automation.

**iOS**

- `.github/workflows/feedback-fix.yml` — `on: repository_dispatch`,
  `runs-on: [self-hosted, macOS]`, runs Claude Code headless.
- `.mcp.json` — PostHog MCP plus XcodeBuildMCP.

### 3. The standing prompt

Lives in the Cursor Automation (web) and in the workflow (iOS). Same text, one
template, platform-conditional verification steps. It instructs the agent to:
select and claim per the claiming protocol, gather context from PostHog MCP,
reproduce, fix under the verification gate, and open the PR.

### 4. Config

A `feedback` block appended to `rkt.json`:

```json
"feedback": {
  "enabled": true,
  "platform": "web",
  "provider": "cursor",
  "repo": "daviesayo/example",
  "branch": "main",
  "max_concurrent": 3,
  "posthog": {
    "host": "https://us.posthog.com",
    "project_id": "492861",
    "survey_id": "01999e...",
    "destination_id": "01999f..."
  }
}
```

`provider` is `cursor` on web and `claude` on iOS by default, with `codex`
permitted on the Mac path. It exists so the dispatch target can change without
touching the widget, the provisioning, or the verification contract.

### 5. Runbook

`docs/feedback-loop.md` written into the target project: what was provisioned,
what to click if it breaks, how to disable it, and how to re-run the smoke test.

## Skill flow

`/rkt:feedback-loop` in the target project:

1. Read `rkt.json`. Refuse with a clear message if the project is not
   bootstrapped.
2. Detect platform and stack. Confirm the inferred dev commands with the user.
3. Preflight. On iOS, verify the self-hosted macOS runner is registered and
   online; fail loudly with setup steps if not. Verify `gh` auth and repo write.
4. Provision PostHog: project (or prompt), survey, launch, destination, error
   tracking, agent key (or prompt).
5. Install the SDK and widget wiring into the app.
6. Write agent configuration and the runbook.
7. Web only: create the Cursor Automation, capture its webhook URL and key, and
   point the PostHog destination at it.
8. Write the `feedback` block to `rkt.json`.
9. Smoke test.
10. Report what was created, with links.

The skill is idempotent: re-running against a configured project reconciles
rather than duplicating, and never creates a second survey.

## Testing

**Repo-level (`tests/test-feedback-loop.sh`)**, following the existing
idempotent temp-dir-and-trap convention:

- Template rendering produces valid JSON for `.cursor/environment.json`,
  `.cursor/mcp.json` and `rkt.json`.
- The workflow YAML parses and pins `runs-on: [self-hosted, macOS]`.
- Re-running against a project that already has a `feedback` block does not
  duplicate configuration.
- The skill refuses on a project with no `rkt.json`.

**Smoke test, run by the skill itself, step 9.** Fires a synthetic survey
response into PostHog, then polls for a `feedback/<id>` branch within a bounded
window. Passing proves the whole chain: widget event → destination → dispatch →
agent start. Failing tells Davies during setup rather than three weeks later
when a real user reports something. The synthetic response is tagged and
excluded from analytics.

This is the one test that matters. Everything else checks that files are
well-formed; this checks that the system exists.

## Failure modes

| Failure | Behaviour |
|---|---|
| Mac runner offline (iOS) | Preflight fails at setup with steps. At run time, the dispatch queues on GitHub until the runner returns. |
| Agent cannot reproduce | Draft PR, `[unverified: could not reproduce]`, with what it tried. |
| Test written but suite red | Draft PR, `[unverified: suite failing]`. |
| `max_concurrent` reached | Abort, no branch, logged. Next real feedback retries. |
| Inferred dev commands wrong | Agent fails to start the server, opens a draft PR naming the command it tried. Davies fixes `environment.json` once. |
| PostHog API drift | Provisioning fails at setup, loudly, before anything half-exists. |
| Duplicate reports | Duplicate PRs. Known and accepted for v1. |

## Known gaps, shipped deliberately

- No dedup. Per scope decision above.
- iOS depends on the Mac being awake and online. Documented prerequisite,
  checked at setup, never silently degraded.
- iOS session replay is thinner than web.
- Cursor webhook-body interpolation is undocumented; the design routes around it
  rather than depending on it.
- Two PostHog objects need a one-time manual fallback.
- `.cursor/environment.json` inference is a guess on unusual stacks, stated as
  a guess.

## Requirements coverage

| Requirement | Where it is met |
|---|---|
| Repeatable across any project | Skill flow, one command, idempotent |
| Works on web | Web path, Cursor cloud agent |
| Works on mobile | iOS path, self-hosted macOS runner |
| Feedback carries text, replay, events, errors | Widget layer + PostHog MCP context gathering |
| Agent has live read-only PostHog | Agent MCP over HTTP, read-only key |
| Loops until verified | Verification gate + Cursor CI auto-retry |
| Opens a PR with tests | Verification gate conditions 2 and 3 |
| Reviewed on a phone | GitHub PR notification; no extra hop |
| Selectable agent runtime | **Partial in v1.** `provider` is a real config field and the dispatch layer is built around it, but only `cursor` is implemented on web and `claude` on iOS. `codex` on the Mac path and `claude`/`codex` on web via GitHub Actions are a follow-on that changes one hop, not the design. |
| Zero hosted infrastructure | Git branches as the lock; no worker, no database |

## References

- [Source post](https://x.com/ericzakariasson/status/2083206179254309036)
- [Cursor cloud agent capabilities](https://cursor.com/docs/cloud-agent/capabilities)
- [Cursor Automations](https://cursor.com/docs/cloud-agent/automations)
- [PostHog CDP destinations](https://posthog.com/docs/cdp/destinations)
- [PostHog survey destinations](https://posthog.com/docs/surveys/destinations)
- `docs/specs/2026-04-17-rkt-plugin-design.md`
