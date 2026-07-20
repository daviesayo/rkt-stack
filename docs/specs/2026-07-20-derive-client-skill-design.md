# derive-client — HAR-derived typed CLI clients

**Date:** 2026-07-20
**Status:** Approved design, revised after blind review, pre-implementation
**Placement:** `plugins/rkt/skills/derive-client/` (skill) + private `rkt-clients` repo (generated output)

## Purpose

Record the user's browser network traffic while an agent drives a site they are logged into, then derive a standalone typed CLI for that site's internal API. Browser control becomes a one-time discovery cost: future automation replays plain HTTP calls instead of driving a browser.

Primary validation target: AlayaCare. An existing consumer, rkt-roster-feed on Railway, is expected to be the first adopter, but nothing in this repo references it, so treat that integration as unverified until inspected. `[uncertain]`

## Entry points

- `derive <site> [--mode read|full]` — record a session and generate (or extend) a client. Default mode: `read`.
- `repair <site>` — re-record stored flows, diff against stored fixtures, patch the client.
- `--flow <flow-id>` — on either entry point, record or replay one stored flow instead of running a guided crawl.

New flows are created during a guided crawl, not from a free-text description. Each flow is persisted in `flows.json` as an ordered list of machine-replayable steps (navigate, click by selector, fill, wait-for), because `repair` must replay a flow months later without re-deriving it from prose.

## Scope and consent guardrails

Hard rules the skill enforces, stated in SKILL.md and gated interactively. Every gate below uses the `AskUserQuestion` tool, per `decisions.md:64` ("All interactive prompts in skills use `AskUserQuestion`") and the AGENTS.md prohibition on bash `read`. SKILL.md frontmatter must declare `allowed-tools` including `AskUserQuestion`, matching the pattern in `plugins/rkt/skills/office-hours/SKILL.md`.

1. **Own accounts and own data only.** The skill records sessions the user is already authenticated into. It never handles credentials, never creates accounts, never logs in on the user's behalf. Before recording, an `AskUserQuestion` gate states: "This records network traffic from your logged-in session. Only proceed for accounts and data that are yours." Recording does not start without explicit confirmation.
2. **Human-shaped traffic.** The recording crawl and every generated client use randomized delays and concurrency 1 by default (shared runtime lib).
3. **Own-data surface only.** The guided crawl exercises the user's own views (their roster, their profile), not admin or multi-user surfaces or other people's records.
4. **No auth artifacts in git.** Secrets are written to `~/.rkt-clients/secrets/<site>.json` with mode `0600`, outside any git worktree. The generated client reads that absolute path; nothing under `rkt-clients/` ever holds a credential. The `rkt-clients` repo ships a `.gitignore` containing `secrets/` and `recordings/` as a second line of defence.

If pointed at a target that is not the user's own account, the skill says so and stops.

## Recording architecture

Playwright driving the user's real installed Chrome, headed, with a persistent profile and HAR recording.

The correct API is `chromium.launchPersistentContext(userDataDir, options)`, not `launch()` plus `newContext()`. A persistent profile is only available through `launchPersistentContext`, and `recordHar` is a **context** option, so both are passed in the same options bag:

```js
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',        // real installed Chrome, so the pinned UA is genuine
  headless: false,
  serviceWorkers: 'block',  // see below
  recordHar: {
    path: `${recordingDir}/session.har.zip`,
    content: 'attach',      // .zip + attach keeps the manifest parseable
    mode: 'full',           // MUST stay 'full'
  },
});
```

Verified against Playwright docs 2026-07-20:

- **`content` defaults to `embed` for non-`.zip` paths** and `attach` for `.zip`. A guided crawl across paginated lists and detail pages would embed every response body base64-inline into one JSON file, producing a multi-hundred-MB blob the derivation passes must hold in memory. Recording to `session.har.zip` with `content: 'attach'` stores bodies as separate zip entries instead.
- **`mode` defaults to `full` and must stay `full`.** `minimal` omits sizes, timing, and **cookies**, which the auth-analysis pass depends on. An engineer optimizing file size by setting `minimal` would silently break auth derivation.
- **`urlFilter`** is applied at record time to drop obvious static-asset origins, reducing HAR size before the filter pass ever runs.
- **`serviceWorkers: 'block'` is mandatory.** Playwright does not intercept requests handled by a Service Worker, so SPA dashboards that proxy API calls through one would yield an empty or badly incomplete endpoint set with no error. Blocking them forces traffic through the interceptable path. If blocking breaks the site, the skill must abort with a clear message rather than record a silently incomplete HAR.

The HAR is only finalized on `context.close()`, so the recorder wraps the session in a try/finally that always closes.

### Profile and login reality

The profile directory is `~/.rkt-clients/profiles/<site>/`, created fresh by the skill. It is deliberately **not** Chrome's own "User Data" directory: as of Chrome 136 that directory is blocked for automation and pointing at it causes pages not to load or the browser to exit.

The consequence, stated plainly because an earlier draft of this design got it wrong: **a fresh profile carries none of the user's existing logins.** Signing in is the guaranteed first-run path for every new site, not an edge case. Login reuse applies only to repeat recordings of the same site, once that site's profile has been authenticated once.

Only one Chrome instance may use a given profile directory at a time. The skill takes a lock file at `~/.rkt-clients/profiles/<site>/.rkt-lock` and refuses to start a second `derive` or `repair` for that site with a clear message, rather than surfacing an opaque browser error.

### Session flow

1. Consent gate (`AskUserQuestion`).
2. Acquire profile lock; launch Chrome via `launchPersistentContext`.
3. User signs in if the profile is not already authenticated. The agent pauses and never touches credentials.
4. Agent maps site navigation.
5. Agent presents the discovered section list; user picks which to derive (`AskUserQuestion`, multi-select).
6. Agent exercises the chosen sections at human-shaped pace: pagination, filters, detail views. Steps are recorded into `flows.json` as it goes.
7. `context.close()`, releasing the HAR; artifacts written; lock released.

Artifacts are written to `~/.rkt-clients/recordings/<site>/<timestamp>/`: `session.har.zip`, DOM fixtures, `flows.json`, and a session log. All runtime paths are absolute and rooted under `~/.rkt-clients/`; no skill artifact is ever written to a cwd-relative path, per the AGENTS.md Runtime Paths rule.

Full autonomous crawling is explicitly out of scope: long sessions, non-human traffic patterns, and in `full` mode it would propose writes across surfaces the user does not care about.

## Derivation pipeline

Four passes over the recorded HAR:

1. **Filter** — drop static assets, analytics, and telemetry. Keep JSON/XHR requests and the HTML documents that carry data.
2. **Auth analysis** — identify the credential (cookie, bearer token, CSRF header), trace where it is minted, note expiry and refresh behavior. Emits an `auth` block in the manifest. This pass reports what it found and confirms via `AskUserQuestion` rather than silently guessing, because it is the step most likely to be wrong.
3. **Endpoint synthesis** — group requests by path template, infer path and query parameters from variation across recorded calls, derive response types from observed bodies. Data present only in HTML becomes a scraper endpoint with a stored CSS selector map, marked `fragile: true`.
4. **Manifest emission** — write `client.json`.

### `client.json` schema

The manifest is the contract between the derivation pipeline and the code generator, and between successive `repair` runs, so it is specified rather than left to convention:

```jsonc
{
  "schemaVersion": 1,              // bumped on any breaking manifest change
  "site": "alayacare",
  "baseUrl": "https://…",
  "recordedAt": "2026-07-20T12:00:00Z",
  "harSha256": "…",                // content hash, survives the recordings dir moving
  "userAgent": "…",
  "clientHints": { "sec-ch-ua": "…", "sec-ch-ua-platform": "…" },
  "auth": { "kind": "cookie|bearer|csrf", "location": "…", "mintedBy": "…", "expiry": "…" },
  "endpoints": [
    {
      "id": "roster.list",
      "method": "GET",
      "pathTemplate": "/api/v2/roster/{employeeId}",
      "params": [ { "name": "employeeId", "in": "path", "type": "string" } ],
      "responseShape": { },        // inferred JSON Schema
      "source": "xhr|scrape",
      "fragile": false,
      "selectors": null,           // populated for source: "scrape"
      "writeSemantics": null       // populated for write endpoints
    }
  ]
}
```

## Modes

**`read` (default).** Only GET and HEAD endpoints are derived. The agent issues no writes during recording.

**`full`.** Additionally proposes write endpoints. Each write requires per-write confirmation (`AskUserQuestion`) before execution and uses perform-and-undo (create then delete, edit then restore) so both request and response are observed.

### Write failure model

Perform-and-undo is the highest blast-radius part of this design: it mutates a real production account the user depends on. The undo can fail (network drop, permission change, server-side validation, a record that becomes non-deletable once referenced). Therefore:

- Before any write fires, the intended undo is appended to a **rollback journal** at `~/.rkt-clients/recordings/<site>/<timestamp>/rollback.jsonl`, flushed to disk. The journal entry is written first, so a crash mid-write still leaves a record of what to clean up.
- After the undo succeeds, its journal entry is marked resolved.
- If an undo fails, the skill **stops the whole session immediately**, does not attempt further writes, and reports the exact unresolved artifact (endpoint, identifiers, what was created) so the user can remove it by hand. It never retries blindly against a mutating endpoint.
- On startup, `derive` and `repair` check for unresolved journal entries from a previous run and surface them before doing anything else.
- Any write the user flags as irreversible falls back to capture-and-block: the request is recorded, the send is suppressed, and the response type is left unknown and marked as such in the manifest.

## DOM fallback

Server-rendered data that never appears in an API response is handled by derived scraper endpoints, not by treating page archives as the primary artifact.

- Working artifacts: raw HTML plus the extracted selector map.
- Fixture artifact: a full-page snapshot (mhtml) retained so `repair` can diff old against new DOM when selectors break.
- Generated scraper subcommands are marked `fragile: true` in the manifest.

Accepted tradeoff: scraper endpoints re-fetch full pages, so they are slower than JSON calls and are where most future breakage will occur. That is inherent to DOM-sourced data.

## Generated client

Bun/TypeScript CLI in `rkt-clients/<site>/`, one subcommand per endpoint, JSON to stdout for jq composition.

**Toolchain note (needs a `decisions.md` entry before implementation):** this introduces Bun, TypeScript, and Playwright into a plugin package that is currently bash and Python only. There is no `package.json` under `plugins/rkt/` outside `templates/presets/`, and no Node runtime dependency today. Bun 1.3.11 is present on the development machine. The recorder's Playwright dependency is installed in the skill's own `scripts/` workspace with a pinned version, never assumed globally present, and the skill must fail with an actionable install message when it is missing. Recording this as a decision is mandatory because it changes the plugin's runtime surface.

Shared runtime lib (`rkt-clients/lib/`) provides:

- Auth loading from `~/.rkt-clients/secrets/<site>.json`.
- Human-shaped rate limiting: randomized delays, concurrency 1 by default.
- Pinned `User-Agent` and `sec-ch-ua` headers replayed verbatim from the recording. This is session fidelity, not spoofing: many backends key sessions to the UA or run WAF consistency checks between login and API calls. The pinned value is the user's own Chrome, refreshed on every `repair` so it does not drift stale as Chrome updates.
- `--dry-run` on every write subcommand: prints method, URL, headers with secrets redacted, and body, and sends nothing.

### Auth transport

One transport: **`direct`**. The client manages its own tokens and cookies, runs headless, and is suitable for cron and remote deployment.

An `aside` transport (shelling out to `aside repl`'s cookie-bearing `fetch()`) was considered and **rejected for v1**. It would be read-only, require Aside running, and could not run headless or under cron, which defeats the stated purpose of replacing browser control with plain HTTP calls. It is also outside the aside-browser skill's own guidance, which scopes `fetch()` to same-origin or trusted direct-download URLs discovered on the current page, not arbitrary endpoints from a manifest.

**Aside is separately unusable for recording.** Probed 2026-07-20: the `aside repl` surface is Playwright-shaped but its network layer is absent. `page.on('request')` and `page.on('response')` register without ever firing (zero hits across a real navigation); `page.route()`, `page.context()`, and `page.waitForResponse` are undefined; no CDP access; no HAR flag on the CLI (`aside --help`, `aside repl --help`).

## Repair path

`repair <site>` replays the stored flows from `flows.json`, diffs the new HAR and DOM against stored fixtures, and produces an updated manifest. Internal APIs carry no stability contract, so repair is a first-class entry point rather than an afterthought.

Semantics, pinned so a partial failure is recoverable:

- Repair writes a **new** manifest alongside the old one and swaps it in only after the full diff succeeds. It never patches in place, so a failed repair leaves the working client untouched and the previous manifest available for comparison.
- Endpoints present in the old manifest but absent from the new recording are **retained and marked `stale: true`**, never silently deleted. Their generated subcommands warn on use.
- Repair holds the same per-site profile lock as `derive`, so the two cannot run concurrently.
- A repair that replays a flow whose steps no longer match the site (selector gone, page moved) reports which flow broke and stops, rather than producing a manifest derived from a half-completed crawl.

## Testing

**Derivation passes:** TDD against checked-in HAR fixtures. Deterministic, no network. These are TypeScript unit tests run by Bun, wrapped in `tests/test-derive-client.sh` so they are discovered by the repo's existing `for t in tests/test-*.sh` harness, and so the wrapper can assert skill file structure the way `tests/test-visual-identity-skills.sh` does. The wrapper skips with a clear message (not a failure) when Bun is unavailable, keeping the suite runnable on machines without the toolchain.

**Generated clients:** live smoke test after generation. Each read endpoint runs once and its output is compared against the recording **by shape, not by value**: field presence, types, and structure. Value-level diffing would produce constant false failures, since the target data (a roster, a message list) legitimately changes between recording and smoke test. A client is not "done" until the shape comparison passes.

## Implementation slices

The design spans several workstreams; they are sequenced so each lands independently and the first one is small.

1. **Recorder.** `launchPersistentContext` with the verified options, consent gate, profile lock, artifact layout. Deliverable: a HAR on disk from a real logged-in session.
2. **Derivation passes 1, 3, 4 (read-only).** Filter, endpoint synthesis, manifest emission, against checked-in HAR fixtures. Deliverable: a valid `client.json` for a recorded site.
3. **Auth analysis (pass 2) and the `direct` transport.** Deliverable: authenticated requests replaying successfully.
4. **Code generator plus shared runtime lib.** Deliverable: a working read-only CLI for AlayaCare, shape-smoke-tested.
5. **Repair path** including `flows.json` replay and stale-endpoint handling.
6. **DOM scraper endpoints** and mhtml fixtures.
7. **`full` mode**: write derivation, rollback journal, per-write gates, `--dry-run`.

Slices 1 to 4 are the minimum useful product. Slices 5 to 7 are each independently valuable and independently deferrable.

Per AGENTS.md "Making Changes", every slice that touches `plugins/rkt/` must bump both manifest versions in lockstep (`plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json`), prepend a `plugins/rkt/CHANGELOG.md` entry, run `for t in tests/test-*.sh; do bash "$t"; done`, and pass `claude plugin validate plugins/rkt`. Adding a new skill is a **minor** bump per the Release Flow section.

## Requirement → design map

| Requirement | Where satisfied |
| --- | --- |
| Record traffic while an agent drives a site | Recording architecture (`launchPersistentContext`, `channel: 'chrome'`, `recordHar`) |
| Derive a typed CLI from the recording | Derivation pipeline; Generated client |
| `read` default, `full` for writes | Modes |
| Writes confirmed, not blindly executed | Modes (perform-and-undo, per-write `AskUserQuestion` gate) |
| Writes recoverable when undo fails | Write failure model (rollback journal, fail-stop) |
| Dry run | Generated client (`--dry-run` on writes); capture-and-block fallback in Modes |
| DOM/mhtml robustness | DOM fallback |
| Drive derivation across the site's surface | Session flow steps 4 to 6 (guided crawl) |
| Own accounts and data only | Guardrails 1 and 3 |
| Human-shaped request rates | Guardrail 2; shared runtime lib |
| User-Agent handling | Generated client (pinned recorded UA and client hints) |
| Reuse existing logins | Partially: persistent profile reuses login across repeat recordings of a site. First run on any site requires a fresh sign-in (see Profile and login reality). The `aside` route that would have reused existing browser sessions is rejected in Auth transport. |
| Central home for generated clients | Placement (private `rkt-clients` repo) |
| Breakage recovery | Repair path |
| Repo conventions (paths, prompts, tests, release) | Guardrails preamble; Session flow artifact paths; Testing; Implementation slices |

## Open items

1. **Toolchain decision not yet recorded.** The Bun/TypeScript/Playwright addition needs a `decisions.md` entry before slice 1 begins.
2. **`rkt-clients` repo does not exist yet.** Slice 1 must create it, private, with the `.gitignore` described in guardrail 4.
3. **AlayaCare service-worker behavior unknown.** If it proxies API traffic through a Service Worker and breaks under `serviceWorkers: 'block'`, slice 1's approach needs revisiting for that target. Determine this during the first real recording.
