# derive-client

Record a logged-in browser session once, then derive a standalone, typed CLI
for that site's internal API. Browser control is a one-time discovery cost; the
generated client replays plain HTTP calls with no browser and no dependency on
this plugin.

This README is the developer overview. [`SKILL.md`](SKILL.md) is the agent-facing
runbook the `/derive-client` skill executes step by step.

## Why

Many sites you use daily have no public API, just an internal one their web app
calls. `derive-client` captures those calls from your own logged-in session and
turns them into a typed CLI you can script or schedule, without reverse
engineering anything by hand.

## Pipeline

```
record ──▶ derive ──▶ generate ──▶ shape (commands.json) ──▶ regenerate
(browser)  (HAR →     (manifest →   (endpoints → domain        (drift report;
           manifest)   typed CLI)    tasks, identity, joins)     never clobbers
                                                                 commands.json)
```

- **record** (`src/record.ts`) drives a real Chrome via Playwright and captures a HAR.
- **derive** (`src/derive.ts`) turns the HAR into `client.json`: the endpoint
  manifest (method, path, params with examples, inferred response shapes), the
  detected credential bundle, and a renewal (`refresh`) spec.
- **generate** (`src/generate.ts`) emits the standalone client: `cli.ts`,
  `types.ts`, `install.sh`, and a copy of the shared `lib/` runtime.
- **shape** (`src/scaffold-commands.ts` + hand/agent editing) writes
  `commands.json`, turning raw endpoints into domain tasks. Two modes: interactive
  Q&A (default) or `draft` (inferred).

## Artifacts

Generated clients live in `~/Documents/Repositories/rkt-clients/<site>/`:

| File | Owner | Purpose |
|---|---|---|
| `client.json` | generated | endpoint manifest (the derived API catalog) |
| `types.ts` | generated | TypeScript types per endpoint response |
| `cli.ts` | generated | the runnable client (`#!/usr/bin/env bun`) |
| `commands.json` | **you** | the task surface; regeneration never overwrites it |
| `install.sh` | generated | put the CLI on your PATH |
| `../lib/` | generated | shared runtime, copied per rkt-clients root |

Runtime state lives under `~/.rkt-clients/` (never committed):

- `profiles/<site>/` — persistent Chrome profile (holds the login)
- `recordings/<site>/<ts>/` — HAR, flows, and the derived `client.json`
- `secrets/<site>.json` — the session credential bundle, mode `0600`
- `<site>.storage-state.json` — serialized browser session
- `out/<site>/` — capped-output spill files (redacted; unredacted only if the
  run used --raw). Prune-managed, newest 20 kept.

## Using a generated client

```bash
bun ~/Documents/Repositories/rkt-clients/<site>/cli.ts            # help
bun .../<site>/cli.ts <command> --dry-run                        # inspect the request
bun .../<site>/cli.ts <command> [--param v] [--json] [--raw] [--limit n]
bun .../<site>/cli.ts <command> --help                           # params, columns, example
bun .../<site>/cli.ts <task> --full                              # disable the 200-row/50KB output cap
```

Every run prints a `[exit:N | Xs | N rows]` footer on stderr; oversized output
is capped and the full redacted payload is written under
`~/.rkt-clients/out/<site>/` with the path in the footer.

Or put it on your PATH and run it by name:

```bash
bash ~/Documents/Repositories/rkt-clients/<site>/install.sh      # symlink onto ~/.local/bin
<site> <command>
<site> uninstall                                                 # remove the launcher, keep the client
```

Session lifecycle commands (available on every generated client):

- `login` / `logout` — sign in via a browser and save the session / clear it
- `auth status` — access-token TTL, refresh window, session age
- `whoami` — the signed-in user (requires an `identity` block; see below)
- `install [--name x]` / `uninstall` — PATH launcher management
- `help` / `--help` / `-h` — usage

## Regenerating a client

Regeneration refreshes `cli.ts` + the shared `lib/` from the client's current
`client.json`, preserves your `commands.json`, and prints a drift report. Each
client ships a `regenerate.sh` that finds the newest installed plugin and does
it for you:

```bash
bash ~/Documents/Repositories/rkt-clients/<site>/regenerate.sh
```

Set `RKT_PLUGIN_ROOT` to override which plugin build is used. Regeneration needs
the plugin's generator (it is not shipped in the dependency-free client), which
is why this is a wrapper into the plugin rather than a `cli.ts` subcommand. Run
it after editing `commands.json`, or to pull the latest runtime into an older
client. If you re-recorded the site, run `derive.ts` first to rebuild
`client.json`, then regenerate.

## The command surface (`commands.json`)

A user-owned file that shapes endpoints into tasks. Per command: `name`,
`summary`, `call` (endpoint id + params), optional `join`s, `output`
(`table` with `columns`/`sort`/`rows`, or `json`), and a `redact` list (field
masking, on by default; `--raw` opts out). Param values may use tokens: `@me`
(the signed-in user's id), `@today` with `±<n><d|w|m|y>` offsets, `@@` to escape
a literal `@`.

### Identity and `whoami` (v0.9.0)

`whoami` and `@me` need an `identity` block naming the current-user endpoint:

```json
"identity": {
  "endpoint": "get.user.profile",
  "params": { "username": "usr-8YWsBVeEy8stAMd" },
  "idField": "user.api_id",
  "display": ["user.name"]
}
```

The current user is almost always an endpoint keyed by **your own id**. That id
may be a literal path segment (`/employees/924` → id-free), a path param, or a
query param; `params` supplies it in the last two cases. The scaffolder detects
the endpoint by response shape (an object carrying a name/email plus an id) and
seeds `params` from the recorded example, which is only correct if you recorded
**your own** profile. Always verify with `whoami` before trusting it. Sites that
server-render the user (no client-side user API) cannot wire `whoami`.

## Auth and staying signed in

Generated clients renew credentials automatically on a 401, cheapest tier first:

1. the stored credential as-is,
2. an OAuth `refresh_token` grant (one POST) when the recording had a token exchange,
3. the recorded browser profile launched headless (survives an expired refresh token).

Rotated tokens are written back, so a scheduled job stays signed in until the
profile itself is signed out. Read mode emits only GET and HEAD; recorded writes
are excluded and refused.

## Security

- Credentials never live in `rkt-clients/`; each client reads
  `~/.rkt-clients/secrets/<site>.json` (mode `0600`) at runtime. Delete that file
  to revoke access.
- Output redaction is on by default because the data is real PII.
- The consent gate (SKILL Step 0) records only accounts and data that are yours.

## Developing the skill

The scripts are Bun + TypeScript (strict). From `scripts/`:

```bash
bun install
bun test               # the unit suite
bunx tsc --noEmit      # typecheck (also run in the generated output as a closure probe)
```

Run a stage directly:

```bash
bun src/generate.ts --manifest <client.json> --out ~/Documents/Repositories/rkt-clients
bun src/scaffold-commands.ts --manifest <client.json> --out <site>/commands.json
bun src/call.ts --manifest <client.json> --endpoint <id> [--dry-run]
```

`src/` layout: `record.ts`, `derive.ts`, `generate.ts`, `scaffold-commands.ts`,
`call.ts`, and `lib/` (the runtime copied into every generated client:
`transport`, `runtime`, `session`, `command-runner`, `commands-schema`,
`identity`, `join`, `tokens`, `render`, `scheduler`, `secrets`, `refresh`,
`reauth`, `manifest-schema`, and the derivation-only `har`/`manifest`/`synthesize`/
`origin`/`filter`/`refresh-detect`).

When adding a file to the runtime allowlist (`RUNTIME_FILES` in `generate.ts`),
re-run the closure probe: generate into a temp dir, `bun install`, and
`tsc --noEmit` there.

## Status

Read-mode derivation is complete. Not yet built: `full` (read + write) mode,
fully automated credential login so a cron survives SSO without a human,
JWT-`sub` identity auto-seeding, and array-payload `/me` detection. See
[`../../CHANGELOG.md`](../../CHANGELOG.md) for release history.
