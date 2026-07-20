# derive-client — HAR-derived typed CLI clients

**Date:** 2026-07-20
**Status:** Approved design, pre-implementation
**Placement:** `plugins/rkt/skills/derive-client/` (skill) + private `rkt-clients` repo (generated output)

## Purpose

Record the user's browser network traffic while an agent drives a site they are logged into, then derive a standalone typed CLI for that site's internal API. Browser control becomes a one-time discovery cost: future automation replays plain HTTP calls instead of driving a browser.

Primary validation target: AlayaCare (existing consumer: rkt-roster-feed on Railway).

## Entry points

- `derive <site> [--mode read|full]` — record a session and generate (or extend) a client. Default mode: `read`.
- `repair <site>` — re-record known flows, diff against stored fixtures, patch the client.
- `--flow "<description>"` — shortcut on either entry point to record one specific task instead of a guided crawl.

## Scope and consent guardrails

These are hard rules the skill enforces, stated in SKILL.md and gated interactively:

1. **Own accounts and own data only.** The skill records sessions the user is already authenticated into. It never handles credentials, never creates accounts, never logs in on the user's behalf. At session start it states: "This records network traffic from your logged-in session. Only proceed for accounts and data that are yours." and waits for explicit confirmation before recording.
2. **Human-shaped traffic.** The recording crawl and every generated client use randomized delays and concurrency 1 by default (shared runtime lib).
3. **Own-data surface only.** The guided crawl exercises the user's own views (their roster, their profile), not admin or multi-user surfaces or other people's records.
4. **No auth artifacts in git.** Cookies and tokens land in a gitignored secrets file per site. Only the endpoint manifest and generated code are committable.

If pointed at a target that is not the user's own account, the skill says so and stops.

## Recording architecture

Playwright driving the user's real installed Chrome via `channel: 'chrome'`, headed, with `recordHar` capturing a full HAR including response bodies. Chrome (not bundled Chromium) matters because the pinned User-Agent must be the user's genuine browser identity, not "Chrome for Testing".

Persistent profile directory per site at `~/.rkt-clients/profiles/<site>/` (gitignored) so login survives across recording sessions.

**Aside is not usable for recording.** Probed 2026-07-20: the `aside repl` surface is Playwright-shaped but its network layer is absent. `page.on('request')` and `page.on('response')` register without ever firing; `page.route()`, `page.context()`, and `waitForResponse` are undefined; no CDP access; no HAR flag on the CLI. Aside remains useful at runtime (see Auth transports).

### Session flow

1. Consent gate.
2. Launch Chrome with persistent profile and HAR recording.
3. User signs in if the profile is not already authenticated. The agent pauses and never touches credentials.
4. Agent maps site navigation.
5. Agent presents the discovered section list; user picks which to derive (guided crawl).
6. Agent exercises the chosen sections at human-shaped pace: pagination, filters, detail views.
7. Artifacts written to `recordings/<site>/<timestamp>/`: `session.har`, DOM fixtures, and a session log.

Full autonomous crawling is explicitly out of scope: it produces long sessions, non-human traffic patterns, and in `full` mode would propose writes across surfaces the user does not care about.

## Derivation pipeline

Four passes over the recorded HAR:

1. **Filter** — drop static assets, analytics, and telemetry. Keep JSON/XHR requests and the HTML documents that carry data.
2. **Auth analysis** — identify the credential (cookie, bearer token, CSRF header), trace where it is minted, note expiry and refresh behavior. Emits an `auth` block in the manifest. This pass reports what it found and asks for confirmation rather than silently guessing, because it is the step most likely to be wrong.
3. **Endpoint synthesis** — group requests by path template, infer path and query parameters from variation across recorded calls, derive response types from observed bodies. Data present only in HTML becomes a scraper endpoint with a stored CSS selector map, marked `fragile: true`.
4. **Manifest emission** — `client.json` holding endpoints, parameters, response shapes, auth strategy, pinned `User-Agent` and `sec-ch-ua` client hints, fragility flags, and recording provenance (timestamp, HAR path).

## Modes

**`read` (default).** Only GET and HEAD endpoints are derived. The agent issues no writes during recording.

**`full`.** Additionally proposes write endpoints. Each write requires per-write confirmation before execution and uses perform-and-undo (create then delete, edit then restore) so both request and response are observed. Any write the user flags as irreversible falls back to capture-and-block: the request is recorded, the send is suppressed, and the response type is left unknown and marked as such in the manifest.

## DOM fallback

Server-rendered data that never appears in an API response is handled by derived scraper endpoints, not by treating page archives as the primary artifact.

- Working artifacts: raw HTML plus the extracted selector map.
- Fixture artifact: a full-page snapshot (mhtml) retained so `repair` can diff old against new DOM when selectors break.
- Generated scraper subcommands are marked `fragile: true` in the manifest.

Accepted tradeoff: scraper endpoints re-fetch full pages, so they are slower than JSON calls and are where most future breakage will occur. That is inherent to DOM-sourced data.

## Generated client

Bun/TypeScript CLI in `rkt-clients/<site>/`, one subcommand per endpoint, JSON to stdout for jq composition.

Shared runtime lib (`rkt-clients/lib/`) provides:

- Auth loading from the gitignored per-site secrets file.
- Human-shaped rate limiting: randomized delays, concurrency 1 by default.
- Pinned `User-Agent` and `sec-ch-ua` headers replayed verbatim from the recording. This is session fidelity, not spoofing: many backends key sessions to the UA or run WAF consistency checks between login and API calls. The pinned value is the user's own Chrome, refreshed on every `repair` so it does not drift stale as Chrome updates.
- `--dry-run` on every write subcommand: prints method, URL, headers with secrets redacted, and body, and sends nothing.

### Auth transports

- **`direct`** — the client manages its own tokens and cookies. Fully standalone, suitable for cron and headless deployment.
- **`aside`** — the client shells out to `aside repl` and uses its cookie-bearing `fetch()`, piggybacking the user's live browser sessions. No token management, but requires Aside to be running and is restricted to `read` mode, since Aside's own guidance limits that fetch to safe GET/HEAD requests.

## Repair path

`repair <site>` re-records the stored flows, diffs the new HAR and DOM against stored fixtures, and patches the manifest. It reports which endpoints changed shape, which selectors moved, and refreshes the pinned UA and client hints.

Internal APIs carry no stability contract, so repair is a first-class entry point rather than an afterthought.

## Testing

- **Derivation passes:** TDD against recorded HAR fixtures. Deterministic, no network.
- **Generated clients:** mandatory live smoke test after generation. Each read endpoint runs once and its output is diffed against what the browser showed during recording. A client is not "done" until this passes.

## Requirement → design map

| Requirement | Where satisfied |
| --- | --- |
| Record traffic while an agent drives a site | Recording architecture (Playwright + `channel: 'chrome'` + `recordHar`) |
| Derive a typed CLI from the recording | Derivation pipeline; Generated client |
| `read` default, `full` for writes | Modes |
| Writes confirmed, not blindly executed | Modes (perform-and-undo + per-write confirmation gate) |
| Dry run | Generated client (`--dry-run` on writes); capture-and-block fallback in Modes |
| DOM/mhtml robustness | DOM fallback |
| Drive derivation across the site's surface | Recording session flow (guided crawl, step 5-6) |
| Own accounts and data only | Scope and consent guardrails 1 and 3 |
| Human-shaped request rates | Scope and consent guardrail 2; Generated client runtime lib |
| User-Agent handling | Generated client (pinned recorded UA + client hints) |
| Reuse existing logins where possible | Persistent profile per site; `aside` auth transport at runtime |
| Central home for generated clients | Placement (private `rkt-clients` repo) |
| Breakage recovery | Repair path |

## Open items for the implementation plan

None. All design questions resolved during brainstorming.
