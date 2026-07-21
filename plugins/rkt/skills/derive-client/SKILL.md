---
name: derive-client
description: Record a logged-in browser session and derive a typed CLI client for a site's internal API. Use when the user wants to automate a site that has no public API, or mentions deriving a client, recording a HAR, or building a CLI for a web app they use.
triggers:
  - derive a client
  - record a HAR
  - build a CLI for this site
  - automate this site
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
---

# derive-client

Record a logged-in browser session, then derive a typed CLI client for that
site's internal API. Browser control is a one-time discovery cost: the derived
client replays plain HTTP calls.

**Host portability:** Before referencing bundled files, set
`RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"`.

**UX principle:** All interactive prompts use `AskUserQuestion`. Never bash `read`.

This skill records a session, derives a `client.json` endpoint manifest, and
generates a standalone typed CLI. It has two design modes for shaping that CLI
into domain tasks (below). `full` (read + write) mode arrives in a later plan.

## Design modes

The skill's positional argument selects how the command surface is designed,
the same way `rkt:bootstrap` reads `[preset]`. Infer it from how you were
invoked; there is no flag.

- **`/derive-client`** (default, Q&A): after deriving and generating, group the
  endpoints, show them, and ask via `AskUserQuestion` which tasks the user
  wants. Propose a name, output columns, and redactions per task. Write
  `commands.json` from the answers, then regenerate.
- **`/derive-client draft`**: infer a complete `commands.json` without asking.
  Start from the scaffold (Step 10) so endpoint ids are correct, then refine it
  (joins, table columns, redactions, an `identity` block) from the endpoint
  paths and response shapes. Write it for the user to edit, then regenerate.

Both modes end with the same artifacts. `commands.json` is the user's: once it
exists, regeneration never overwrites it (Step 11).

## Step 0: Consent gate

Before anything else, ask via `AskUserQuestion`:

> This records network traffic from your logged-in browser session, including
> auth headers and cookies. Only proceed for accounts and data that are yours.
> Proceed?

Options: `Yes, it's my account` / `Cancel`.

Stop immediately on Cancel. If the user asks to record a site that is not their
own account, decline and explain why.

## Step 1: Check the toolchain

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
command -v bun >/dev/null || { echo "bun is required: https://bun.sh"; exit 1; }
(cd "$SCRIPTS" && bun install)
```

## Step 2: Start the recorder

Pick a **site slug** once (lowercase letters, digits, and hyphens only — e.g.
`example-app`; dots and other punctuation are rejected) and reuse
the exact same `SITE=...` value in every command below. Each bash snippet is
self-contained; shell variables and file descriptors do not carry over between
tool calls.

The recorder owns the browser and reads commands as JSON lines appended to a
plain file. It is deliberately **not** a named pipe: opening a FIFO for read
blocks until a writer appears, and because every bash call is a separate shell
the writer never persisted, so the recorder appeared to hang with an empty log.
Paths are pinned under `~/.rkt-clients/run/<site>/` so later steps can find them:

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
SITE=<site-slug>
[[ "$SITE" =~ ^[a-z0-9-]+$ ]] || { echo "site slug must be lowercase letters, digits, hyphens only"; exit 1; }
RUN="${HOME}/.rkt-clients/run/${SITE}"
CMDS="${RUN}/commands.jsonl"
LOG="${RUN}/record.log"
mkdir -p "$RUN"
: > "$CMDS"   # append-only command file; NOT a fifo (see note below)
(cd "$SCRIPTS" && bun src/record.ts --site "$SITE" --commands "$CMDS") >"$LOG" 2>&1 &
disown
```

Chrome opens visibly. Read `"$LOG"` and find the first line with
`"event":"ready"`. Use the `site` and `recordingDir` values from that JSON for
all filesystem paths in Steps 6 and the Artifacts section (lock file, HAR,
derive output). If the line is missing after a few seconds, check `"$LOG"` for
errors before sending commands.

## Step 3: Have the user sign in

The profile starts empty, so **the first recording of any site requires a fresh
sign-in**. Navigate to the login page:

```bash
SITE=<site-slug>
CMDS="${HOME}/.rkt-clients/run/${SITE}/commands.jsonl"
echo '{"kind":"goto","url":"https://<site>/login"}' >> "$CMDS"
```

Then tell the user: "Chrome is open. Please sign in, and tell me when you're
done." Wait for them. Never type credentials yourself and never ask for them.

On later recordings of the same site the profile is already authenticated and
this step is a no-op.

## Step 4: Map the site and pick sections

Ask the recorder what is on the page rather than guessing:

```bash
SITE=<site-slug>
CMDS="${HOME}/.rkt-clients/run/${SITE}/commands.jsonl"
echo '{"kind":"snapshot"}' >> "$CMDS"
```

The response carries `snapshot.headings` and `snapshot.links` (text plus href,
deduplicated). Use those to enumerate the app's sections. Navigate with `goto`
and snapshot again to go deeper.

Navigate the site's main nav, reading each page's title and URL from the
recorder's responses. Then ask via `AskUserQuestion` (multi-select) which
sections to derive, listing what you found.

## Step 5: Exercise the chosen sections

For each chosen section, issue `goto`, `click`, and `fill` commands to walk
list views, pagination, filters, and at least one detail view. Write each command
to the pipe by path (one command per bash call):

```bash
SITE=<site-slug>
CMDS="${HOME}/.rkt-clients/run/${SITE}/commands.jsonl"
echo '{"kind":"goto","url":"https://<site>/section"}' >> "$CMDS"
```

The recorder paces itself between actions; do not add your own tight loops.

## Step 6: Close and derive

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
SITE=<site-slug>
LOG="${HOME}/.rkt-clients/run/${SITE}/record.log"
CMDS="${HOME}/.rkt-clients/run/${SITE}/commands.jsonl"
READY=$(grep -m1 '"event":"ready"' "$LOG" || true)
SANITIZED_SITE=$(printf '%s' "$READY" | sed -n 's/.*"site":"\([^"]*\)".*/\1/p')
RECORDING_DIR=$(printf '%s' "$READY" | sed -n 's/.*"recordingDir":"\([^"]*\)".*/\1/p')
[[ -n "$SANITIZED_SITE" ]] && SITE="$SANITIZED_SITE"
echo '{"kind":"done"}' >> "$CMDS"
LOCK="${HOME}/.rkt-clients/profiles/${SITE}/.rkt-lock"
for _ in $(seq 1 60); do [[ ! -f "$LOCK" ]] && break; sleep 1; done
if [[ -n "$RECORDING_DIR" && -f "$RECORDING_DIR/session.har.zip" ]]; then
  HAR="$RECORDING_DIR/session.har.zip"
else
  HAR=$(ls -t "${HOME}/.rkt-clients/recordings/${SITE}"/*/session.har.zip 2>/dev/null | head -1)
fi
[[ -n "$HAR" && -f "$HAR" ]] || { echo "no recording found for $SITE"; exit 1; }
(cd "$SCRIPTS" && bun src/derive.ts --site "$SITE" --har "$HAR")
```

If `echo … >> "$CMDS"` hangs, the recorder may have died — check `"$LOG"` before
retrying.

Report the derived endpoints to the user. If zero endpoints were derived but the
site clearly worked, say so plainly: the likely cause is API traffic routed
through a Service Worker, which HAR recording cannot see.

## Step 7: Confirm the detected credential

`derive.ts` reports what it found, for example:

```
Stored cookie credential for "example-app" at 0600 (location: cookie:sessionid).
Credential expires: 2026-08-01T00:00:00.000Z
```

Confirm with the user via `AskUserQuestion`:

> I detected a **cookie** credential at `cookie:sessionid`. Does that look like
> the session credential for this site?

Options: `Yes, that's the session credential` / `No, pick a different one` / `Not sure, show me the candidates`.

Never print the credential's value. Report only its kind, location, and expiry.

## Step 8: Verify with a real call

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
MANIFEST="<recordingDir>/client.json"
(cd "$SCRIPTS" && bun src/call.ts --manifest "$MANIFEST" --endpoint <endpoint-id> --dry-run)
```

Inspect the dry-run output with the user, then drop `--dry-run` to run it for
real. Compare the result against what the browser showed during recording by
**shape** (fields present, types, structure), not by exact values: live data
changes between recording and replay.

A 401 or 403 means the credential is wrong, expired, or bound to something the
transport does not replay. Re-record rather than guessing.

### Staying authenticated

Access tokens on modern apps expire in minutes, so `call` renews automatically
rather than making you re-record. It tries, in order:

1. The stored credential as-is.
2. An OAuth `refresh_token` grant, when the recording contained a token
   exchange. One POST, no browser.
3. The recorded browser profile, launched headless. The identity provider's own
   session cookie outlives the access token by a long way, so loading the app
   with that profile makes it mint a fresh token unattended.

Rotated tokens are written back, so a scheduled job stays signed in without
help. Only when the profile itself is no longer signed in does a human need to
re-run this skill.

Only GET and HEAD endpoints can be called. Recorded writes are excluded from
the manifest in read mode, and `call` refuses them even if one appears.

## Step 9: Generate the typed client

`call` is the manual path. For repeat use, generate a standalone client:

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
MANIFEST="<recordingDir>/client.json"
OUT="${HOME}/Documents/Repositories/rkt-clients"
(cd "$SCRIPTS" && bun src/generate.ts --manifest "$MANIFEST" --out "$OUT")
```

This writes `$OUT/<site>/` with `client.json`, `types.ts`, and `cli.ts`, and
refreshes the shared runtime in `$OUT/lib/`. The generated client has no
dependency on this plugin and can be run from cron.

Use it:

```bash
bun "$OUT/<site>/cli.ts"                        # list commands
bun "$OUT/<site>/cli.ts" <command> --dry-run    # inspect the request
bun "$OUT/<site>/cli.ts" <command>              # run it, JSON to stdout
```

Verify a generated client the same way as `call`: compare against the browser
by shape, not by value.

Generated files carry a "do not edit" header. To change one, re-record or
re-derive and regenerate; hand edits are overwritten on the next run.

Credentials are never written into `rkt-clients`. Each client reads
`<rkt-root>/secrets/<site>.json` at runtime.

## Step 10: Shape the command surface

The generated CLI so far has one command per endpoint. Turn it into domain
tasks by writing a `commands.json` in the site directory
(`$OUT/<site>/commands.json`).

Scaffold a valid starting point (correct endpoint ids, one JSON command each):

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
OUT="${HOME}/Documents/Repositories/rkt-clients"
SITE=<site-slug>
(cd "$SCRIPTS" && bun src/scaffold-commands.ts \
  --manifest "$OUT/$SITE/client.json" --out "$OUT/$SITE/commands.json")
```

Then edit `commands.json`:

- **`identity`** names an **id-free** endpoint (a `/me`-style route needing no
  id), its `idField` (the field holding the user's id, what `@me` resolves to),
  and `display` fields for `whoami`. Omit it if the site has no such route;
  `@me` and `whoami` are then unavailable.
- Each **command** has a `name`, a `summary`, a `call` (endpoint id + params),
  optional `join`s, an `output` (`table` with `columns`/`sort`/`rows`, or
  `json`), and a `redact` list.
- **Param tokens:** a value beginning with `@` is a token — `@me`, `@today`,
  `@today±<n><d|w|m|y>`. Escape a literal leading `@` as `@@`. Anything else
  `@`-prefixed is an error.
- **`join`** resolves a reference per row: read `key`, look it up against
  `endpoint` (which must take exactly one path param), attach `select` fields
  under `as`. `onError` is `blank` (default), `key`, or `fail`.
- **`output.rows`** is the dotted path to the row array when the response wraps
  it (e.g. `"data"`); omit it when the response is a bare array or a single
  object.
- **`redact`** masks fields by default in every output mode; `--raw` opts out.

At the command line, a task's declared `call.params` can be overridden by
`--<param> <value>`; only params the command already declares are overridable,
so give a command every param a user should be able to vary. `--json` (JSON
instead of a table), `--raw` (disable redaction), and `--limit <n>` are global.

In Q&A mode, drive this by asking the user which tasks they want and proposing
the shape. In draft mode, infer it. Regenerate when done (Step 11).

## Step 11: Regenerate and read the drift report

Re-run `generate.ts` (Step 9) whenever `commands.json` or the recording
changes. Regeneration:

- reads `commands.json` and emits a task CLI (`whoami`, `login`, `logout`,
  `auth status`, and one command per task);
- **never overwrites `commands.json`**;
- prints a **drift report** comparing it against the freshly derived
  `client.json`: `broken` (a command references an endpoint no longer present —
  regeneration stops until you fix it) and `new` (endpoints no command uses
  yet). Edit `commands.json` in response.

Use the task CLI:

```bash
bun "$OUT/<site>/cli.ts"                 # help: session + task commands
bun "$OUT/<site>/cli.ts" whoami          # the signed-in user (needs identity)
bun "$OUT/<site>/cli.ts" auth status     # token TTL and session age
bun "$OUT/<site>/cli.ts" <task>          # a domain task, shaped output
bun "$OUT/<site>/cli.ts" <task> --json   # JSON instead of a table
bun "$OUT/<site>/cli.ts" <task> --raw    # disable field redaction
bun "$OUT/<site>/cli.ts" login           # re-authenticate in a browser, no re-record
```

Redaction is on by default because the data is real personal information. Only
`--raw` disables it.

## Artifacts

All paths below resolve under `~/.rkt-clients/`. (`RKT_CLIENTS_ROOT` relocates
this root during automated tests only; it is ignored outside `NODE_ENV=test`.)

- `profiles/<site>/` — persistent Chrome profile (holds the login)
- `recordings/<site>/<timestamp>/session.har.zip` — the recording
- `recordings/<site>/<timestamp>/flows.jsonl` — replayable steps
- `recordings/<site>/<timestamp>/client.json` — the derived manifest
- `secrets/<site>.json` — the session credential, mode `0600`. Never commit,
  never print, never paste into a chat or an issue. Delete this file to revoke
  the derived client's access.

Never commit these. They contain session credentials.
