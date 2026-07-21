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
    "endpoint": "get.api.v1.employees.id",
    "params": { "id": "@me" },
    "display": ["first_name", "email"]
  },
  "commands": [
    {
      "name": "shifts",
      "summary": "List your upcoming shifts",
      "call": { "endpoint": "get.scheduling.getshifts", "params": { "start": "@today", "end": "@today+14d" } },
      "join": [
        { "key": "client_id", "endpoint": "get.api.v1.clients.id", "as": "client", "select": ["name"] }
      ],
      "output": { "kind": "table", "columns": ["date", "client.name", "address"], "sort": "date" },
      "redact": ["address"]
    }
  ]
}
```

Field semantics:

- **`identity`** powers `whoami`: an endpoint plus which fields name the signed-in user.
- **`call`** names one endpoint by its `client.json` id and supplies default params.
- **`join`** (optional) resolves references: for each result row, look up `key` against another endpoint and attach the response as `as`, keeping only `select` fields. The scheduler (below) deduplicates these lookups, so 40 rows referencing 8 clients issue 8 requests.
- **`output`** is `kind: "table"` with ordered `columns` (dotted paths reach into joined data) or `kind: "json"`. `sort` names a column.
- **`redact`** lists fields masked unless `--raw` is passed.

**Param tokens** resolve at call time: `@me` (the identity id, cached after first `whoami`), `@today`, `@today+14d`, `@today-30d`. Anything else is a literal. A token that cannot resolve is an error naming the token, not a silent empty value.

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

- **`login`** — launches headed Chrome via the recorded profile, waits for the user to authenticate, saves `storageState`, exits. Self-sufficient: re-authenticating needs no Claude, no skill, no re-record. Reuses the recorder's proven launch path.
- **`logout`** — deletes the site's `storageState` and secrets file.
- **`auth status`** — see output below.
- **`whoami`** — calls `identity.endpoint`, prints `identity.display` fields. Caches the resolved id for `@me`.

`login` deliberately does not store username/password. A cron that outlives every renewal tier still needs a human at the keyboard; automated credential login is out of scope here and noted as a known gap (see below).

### auth status output

```
Signed in as Davies Ayo (davies@example.com)
Access token   expires in 3m 42s
Refresh window expires in 51m
Browser session saved 2h ago
```

Each line derives from data already captured: access-token TTL from the credential's `expiry` (a JWT `exp` or cookie `Max-Age`), the refresh window from `refresh.refreshExpiresIn`, the browser session from the `storageState` file mtime. Any line whose source is unavailable prints `unknown` rather than guessing. When the access token is expired it says so and notes that the next call will attempt renewal.

### scheduler.ts — replaces ratelimit.ts

The current `ratelimit.ts` serialises calls with jitter. It is replaced by a scheduler that makes joins a non-issue:

- concurrency cap (default 1) with randomised human-shaped delay between requests
- **per-run request cache**: identical GETs within one command invocation are issued once and shared, so a join over N rows referencing M distinct targets makes M requests
- adaptive backoff on 429 and 503, honouring `Retry-After` when present
- the existing limiter's public shape (`createLimiter`-style) is preserved so `transport.ts` and generated code do not churn

This is the module that lets a join-bearing command stay within human-shaped traffic. It is built once and shared, never hand-rolled per client.

### render.ts — output shaping

- table renderer for `output.kind: "table"` using the declared columns and dotted paths into joined data
- passthrough JSON for `--json`
- redaction applied by default to `redact` fields and to any field the manifest already flagged as credential-adjacent; `--raw` disables it
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

Two sequenced plans, ~1 day total. Plan A ships independently.

**Plan A — runtime foundation (~4h).** `scheduler.ts` (replacing `ratelimit.ts`), `session.ts` (`login`/`logout`/`auth status`/`whoami`), `render.ts` (table/json/redaction). Wired into the generator so the existing client gains the lifecycle commands with no command redesign. Deliverable: `login`, `logout`, `auth status`, `whoami` working on the client already generated.

**Plan B — command surface (~5h).** The `commands.json` schema and validator, the two design modes in the skill, join planning, the drift report, and codegen that emits a CLI from `commands.json` + `client.json`. Deliverable: a derived client whose commands are domain tasks with shaped output.

## Requirement → design map

| Requirement | Where |
| --- | --- |
| Commands are domain tasks, not endpoint clones | commands.json; Plan B codegen |
| Two design modes, both produce commands.json | Two design modes |
| Mode is a bare positional arg, agent-inferred | Two design modes |
| One command may call several endpoints (joins) | commands.json `join`; scheduler dedup |
| Joins must not break human-shaped rate limiting | scheduler.ts (per-run cache, backoff) |
| Session lifecycle in shared runtime, wired per client | session.ts |
| `auth status` shows token TTL | auth status output |
| `login` opens browser, saves session, self-sufficient | session.ts |
| commands.json is the user's, never overwritten | commands.json is the user's; drift report |
| CLI conventions: help, --json, selectors, redaction | render.ts; Generated CLI conventions |
| Redacted by default, --raw to opt out | render.ts |

## Open items / known gaps

1. **No automated credential login.** A daily cron that outlives the SSO session still needs a human. `rkt-roster-feed` solves this with stored credentials and a lockout circuit breaker; porting that is deliberately deferred, not forgotten.
2. **Legacy 200-with-HTML-error routes** (from the 0.6.0 run) remain undetected. A soft-fail route returning an "Access Denied" HTML body with status 200 would render as an empty table. Out of scope for this pass; flagged.
3. **Join correctness is the highest-risk surface.** A wrong `key` or a reference that is an array rather than a scalar mis-resolves silently. Plan B must test array-valued keys and missing references explicitly.
