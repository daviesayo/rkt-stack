# derive-client: Task-Oriented Command Surface

**Date:** 2026-07-21
**Status:** Approved design, pre-implementation
**Predecessor:** `docs/specs/2026-07-20-derive-client-skill-design.md` (shipped as plugin 0.6.0)
**Placement:** `plugins/rkt/skills/derive-client/` (skill + scripts) and generated output in `rkt-clients/`

## Problem

The 0.6.0 generator emits one command per endpoint, named after the URL: `api-v1-employees-924`. That is a transcription of the API, not a CLI. A useful client speaks the site's domain (`whoami`, `shifts`, `clients`), shapes its output for a human, and manages its own session. The derivation is plumbing; designing the command surface is the value this skill should add and currently skips.

## What changes

A third artifact sits between the derived manifest and the generated code:

| Artifact | Owner | Regenerated |
| --- | --- | --- |
| `client.json` | machine, derived from the HAR | freely, every re-derive |
| `commands.json` | **the user** | never overwritten |
| generated CLI (`cli.ts`, `types.ts`, `lib/`) | machine, emitted from both | freely |

`client.json` becomes an internal endpoint catalogue. The CLI the user types against is built from `commands.json`, which references endpoints by id. Re-deriving the manifest never disturbs the command surface the user has built muscle memory and scripts around.

## commands.json

The reviewable, hand-editable contract between design and codegen.

```jsonc
{
  "schemaVersion": 1,
  "site": "example",
  "identity": {
    "endpoint": "get.api.v1.employees.me",
    "idField": "id",
    "display": ["first_name", "email"]
  },
  "commands": [
    {
      "name": "shifts",
      "summary": "List your upcoming shifts",
      "call": { "endpoint": "get.scheduling.getShifts", "params": { "start": "@today", "end": "@today+14d" } },
      "join": [
        { "key": "client_id", "endpoint": "get.api.v1.clients.id", "select": ["name"], "as": "client", "onError": "blank" }
      ],
      "output": { "kind": "table", "columns": ["date", "client.name", "address"], "sort": "date" },
      "redact": ["address"]
    }
  ]
}
```

Field semantics:

- **`identity`** powers `whoami` and `@me`. It must name an **id-free** endpoint — one that returns the signed-in user's own record without needing an id (a `/me`-style route). `idField` is the field in that response holding the user's id, which is what `@me` resolves to. This breaks the bootstrap circularity a per-id identity endpoint would create: `whoami` can always fire, because its call needs no id. If a site has no id-free identity route, `identity` is omitted and `@me`/`whoami` are unavailable for that client (the drift report says so).
- **`call`** names one endpoint by its exact `client.json` id (see id casing below) and supplies default params.
- **`join`** (optional) resolves references. For each result row, read `key` from the row and look it up against `endpoint`, attaching the `select` fields under `as`. `key` must resolve to a scalar; an array-valued key is a `commands.json` validation error at generation time, not a silent mis-join. `onError` (`blank` default, or `key` to show the raw id, or `fail` to abort the command) controls what a row renders when its lookup 4xx/5xxs. The scheduler (below) deduplicates lookups, so 40 rows referencing 8 clients issue 8 requests.
- **`output`** is `kind: "table"` with ordered `columns` (dotted paths reach into joined data) or `kind: "json"`. `sort` names a column.
- **`redact`** lists response fields masked unless `--raw` is passed. This is field-level redaction of business data, a separate layer from the runtime's existing credential-value masking (`redactAll`), which always runs regardless of `--raw`. There is no manifest flag for credential-adjacent response fields; the user names redacted fields explicitly here.

### Param tokens

A param value is a **token** only if it begins with `@`; everything else is a literal. This ordering resolves the ambiguity: a value like `@todayy` is `@`-prefixed and not in the legal set, so it is a hard error naming the token, never silently passed as a literal string. To pass a literal value that genuinely starts with `@`, escape it as `@@` (renders one `@`).

The complete legal set:

- **`@me`** — the identity id, resolved by calling `identity.endpoint` and reading `idField`. Resolved lazily on first use within a process and cached in memory for that process only (not persisted; see identity cache below).
- **`@today`**, **`@today±<n><unit>`** — a date offset. `unit` is one of `d` (days), `w` (weeks), `m` (months), `y` (years). No unit means days: `@today+14` is legal and equals `@today+14d`.

Dates render as `YYYY-MM-DD` in the client's local timezone. If a recorded request used full ISO datetimes for the same param, generation captures that format from the manifest's example value and renders to match; the default is date-only. Timezone is local; a `TZ` env override is honoured so a cron can pin it.

An unresolvable or malformed token (`@tomorrow`, `@today+14x`, `@me` with no `identity` block) is an error naming the token and the reason, and the command does not fire.

### commands.json is the user's

Re-derive regenerates `client.json` but never writes `commands.json` once it exists. Instead it prints a **drift report**:

- commands whose `call` or `join` endpoint id is no longer in the manifest (broken, need attention)
- endpoints in the manifest that no command references (new surface the user may want)

The user edits `commands.json` by hand in response. This keeps the CLI stable across re-records at the cost of new endpoints not appearing automatically, which is the right trade for a surface the user scripts against.

## Two design modes

Both produce a `commands.json`. Mode is a positional skill argument, inferred by the agent, no flag:

- **`/derive-client`** (default, Q&A): after deriving, the skill groups the endpoints, shows them, and asks via `AskUserQuestion` what tasks the user wants. It proposes names, output columns and redactions per task, and writes `commands.json` from the answers.
- **`/derive-client draft`**: the agent infers a complete `commands.json` from endpoint paths and response shapes and writes it for the user to edit before generating. No blank page; no interactive session.

The skill decides between them by reading its positional arg, the same way `rkt:bootstrap` reads `[preset]`.

## Shared runtime additions

Three modules in the skill's `src/lib/`, copied into every generated `rkt-clients/lib/` by the existing generator allowlist. Building them in the shared runtime, wired per client, means every derived CLI gets session management and safe joins for free.

### session.ts — lifecycle as first-class commands

Every generated client gets these built in, independent of `commands.json`:

- **`login`** — launches headed Chrome via the recorded profile, waits for the user to authenticate, saves `storageState` and the credential bundle, exits. Self-sufficient: re-authenticating needs no Claude, no skill, no re-record. Reuses the recorder's proven launch path. `playwright` is already a generated-client dependency, so no new package is added.
- **`logout`** — deletes the site's `storageState`, secrets file, and the identity cache.
- **`auth status`** — see output below.
- **`whoami`** — calls the id-free `identity.endpoint`, prints `identity.display` fields, and caches the resolved id (from `idField`) for `@me`.

`login` deliberately does not store username/password. A cron that outlives every renewal tier still needs a human at the keyboard; automated credential login is out of scope here and noted as a known gap (see below).

### Identity cache

`@me` resolution is cached to avoid re-calling the identity endpoint on every command in a session. The cache lives in its own file at `<rkt-root>/secrets/<site>.identity.json` (0600, since it holds a user's own record fields), **separate from the credential bundle** so identity data never mixes into the secrets file. It stores the resolved id plus the `display` fields. `logout` deletes it. `login` deletes it before the new sign-in, so signing in as a different user cannot leave a stale `@me` pointing at the previous person.

### auth status output

```
Signed in as Davies Ayo (davies@example.com)
Access token   expires in 3m 42s
Refresh window   unknown
Browser session saved 2h ago
```

Line by line, honest about what is actually derivable:

- **Signed in as** — from the identity cache if present, else "unknown (run whoami)".
- **Access token** — computed from the credential's live expiry. The manifest's `auth.expiry` is the **recording-time** value and is useless at runtime; renewals must therefore write the new token's expiry alongside the token. This means `secrets.ts` gains a per-credential expiry field (decoded from the JWT `exp` when the value is a JWT, else null) written on every `writeSecret`, and `readSecrets`/`storedAt` must be exposed rather than discarded. When no live expiry is known, the line prints `unknown`.
- **Refresh window** — `refresh.refreshExpiresIn` is a duration with no anchor in the manifest, so an absolute countdown is not computable from captured data. This line prints `unknown` unless the stored token set records a refresh-token mint time (which the runtime does not currently do). Shown as `unknown` above deliberately, matching reality. A future enhancement can anchor it; this spec does not claim to.
- **Browser session** — from the `storageState` file mtime.

The sample output is the honest one: `Refresh window unknown`. Any line whose source is unavailable prints `unknown` rather than a fabricated countdown.

### scheduler.ts — replaces ratelimit.ts

The current `ratelimit.ts` exposes `createLimiter()` returning `limit<T>(fn: () => Promise<T>)` — an **opaque thunk** wrapper. `transport.issue` runs `fetch` inside that thunk, so the limiter never sees the request URL or the response status. Dedup needs the URL for a cache key; backoff needs the status. **Both features are impossible under the current signature**, so the scheduler changes it, and this is a deliberate, contained churn rather than the "no churn" the earlier draft wrongly claimed.

New shape: the scheduler owns the fetch. `schedule(request: BuiltRequest): Promise<{status, body}>` moves the `fetch`, retry, and pacing inside `scheduler.ts`, and `transport.issue` becomes a thin caller. This changes three call sites, all in this repo: `transport.issue` (`src/lib/transport.ts`), the emitted `cli.ts` (`src/lib/codegen.ts`), and `src/call.ts`. All three are updated in Plan A.

What the scheduler provides:

- concurrency cap (default 1) with randomised human-shaped delay between requests
- **per-run request cache**: identical GETs within one command invocation are issued once and shared by URL key, so a join over N rows referencing M distinct targets makes M requests
- adaptive backoff on 429 and 503, honouring `Retry-After` when present
- preserves the existing `min/max` delay options and the first-call-not-delayed behaviour

This is the module that lets a join-bearing command stay within human-shaped traffic. It is built once and shared, never hand-rolled per client.

**Generator wiring.** `session.ts`, `scheduler.ts`, and `render.ts` are new files that must be added to the generator's `RUNTIME_FILES` allowlist (`src/generate.ts`), and `ratelimit.ts` is removed from it. This churns the pinned copies of the allowlist in `tests/generate.test.ts` and the closure-probe assertions, and the `manifest-schema.ts` import test in `tests/manifest.test.ts`. All are in Plan A's scope.

### render.ts — output shaping

- table renderer for `output.kind: "table"` using the declared columns and dotted paths into joined data
- **redaction runs before output in both table and `--json` modes.** `--json` is not raw passthrough: a user piping `--json` to a file must not leak the `redact` fields the default is there to protect. Redaction of the declared `redact` fields is on by default in every output mode; `--raw` is the single, explicit opt-out that disables it everywhere. Credential-value masking (`redactAll`) is a separate always-on layer and is never disabled by `--raw`.
- a real `help` surface: a quickstart block plus per-command summaries, generated from `commands.json`

## Generated CLI conventions

Modelled on the luma-cli reference, not copied:

- numbered selectors: `shifts` lists with row numbers, `shift 1` addresses one; a stateful default via `use <selector>` where a command has a natural scope
- global flags: `--json`, `--raw`, `--limit <n>`
- `help` with a quickstart, and per-command help
- redacted by default, `--raw` to opt out (the data is real personal information)

## Testing

- **Pure units, TDD against fixtures**: token resolution, join planning, the scheduler's dedup and backoff, table rendering, redaction, `auth status` TTL formatting, drift detection. No network.
- **Generated-client execution** (as in 0.6.0): generate from a fixture `commands.json`, run it as a subprocess, assert `help`, a table command with a stubbed join, and `auth status` all behave.
- **Live smoke** (owner-run): against the real recorded site, confirm `whoami`, `auth status` showing a real TTL, and a join-bearing command returning shaped data, compared by shape not value.

## Plan decomposition

Two sequenced plans, ~1 day total. Plan A ships a usable increment on its own; the split is real because Plan A touches only the runtime and generator, never `commands.json`.

**Generated clients are static copies.** A 0.6.0 client already on disk keeps running its old `lib/` and `cli.ts` unchanged; it does not retroactively gain anything. The lifecycle commands appear only when a client is **regenerated**. Plan A therefore makes `generate.ts` work with **no `commands.json` present** (the 0.6.0 case): it falls back to the existing endpoint-per-command emission plus the new lifecycle commands. This is the backward-compatibility contract, stated explicitly.

**Plan A — runtime foundation (~4h).** `scheduler.ts` (replacing `ratelimit.ts`, updating its three callers), `session.ts` (`login`, `logout`, `auth status`), `render.ts` (table/json/redaction), the per-credential expiry field in `secrets.ts`, and the generator wiring (allowlist, no-`commands.json` fallback, regeneration). Deliverable, verifiable on a regenerated client with no `commands.json`: **`login`, `logout`, and `auth status` work.** `whoami` is **not** in Plan A — it needs `identity`, which lives in `commands.json`, so it ships in Plan B. `auth status`'s "Signed in as" line shows "unknown (run whoami)" until then.

**Plan B — command surface (~5h).** The `commands.json` schema and validator, `identity`/`@me`/`whoami`, the two design modes in the skill, the param-token resolver, join planning with `onError`, the drift report, and codegen that emits a task CLI from `commands.json` + `client.json`. Deliverable: a derived client whose commands are domain tasks with shaped output, plus a working `whoami`.

## Requirement → design map

| Requirement | Where |
| --- | --- |
| Commands are domain tasks, not endpoint clones | commands.json; Plan B codegen |
| Two design modes, both produce commands.json | Two design modes |
| Mode is a bare positional arg, agent-inferred | Two design modes |
| One command may call several endpoints (joins) | commands.json `join`; scheduler dedup |
| Joins must not break human-shaped rate limiting | scheduler.ts (per-run cache, backoff) |
| Session lifecycle in shared runtime, wired per client | session.ts (Plan A: login/logout/auth status; Plan B: whoami) |
| `auth status` shows token TTL | auth status output (access-token TTL live; refresh window `unknown`) |
| `login` opens browser, saves session, self-sufficient | session.ts |
| commands.json is the user's, never overwritten | commands.json is the user's; drift report |
| CLI conventions: help, --json, selectors, redaction | render.ts; Generated CLI conventions |
| Redacted by default in every output mode, --raw to opt out | render.ts |
| A 0.6.0 client keeps working; regeneration is how it upgrades | Plan decomposition (no-`commands.json` fallback) |

## Open items / known gaps

1. **No automated credential login.** A daily cron that outlives the SSO session still needs a human. `rkt-roster-feed` solves this with stored credentials and a lockout circuit breaker; porting that is deliberately deferred, not forgotten.
2. **Legacy 200-with-HTML-error routes** (from the 0.6.0 run) remain undetected. A soft-fail route returning an "Access Denied" HTML body with status 200 would render as an empty table. Out of scope for this pass; flagged.
3. **Join correctness is the highest-risk surface.** Mitigations are now specified rather than left to tests: an array-valued `key` is a generation-time validation error, and a failed per-row lookup follows the command's `onError` policy (`blank` / `key` / `fail`). Plan B tests all three plus the array-key rejection.
4. **Refresh-window countdown is not derivable** from captured data (a duration with no anchor). `auth status` prints `unknown` for it. Anchoring it would require the runtime to record the refresh token's mint time; deferred.
5. **Join latency.** With concurrency 1 and 400-1300ms pacing, a join over M distinct targets adds up to ~M seconds. Dedup bounds it to distinct targets, not row count, but a join-bearing command is not instant. Acceptable for the roster use case; noted so it is not a surprise.
