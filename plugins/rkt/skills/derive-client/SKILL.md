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

This plan-1 skill covers `read` mode only: it records a session and produces a
`client.json` endpoint manifest. Auth analysis, code generation, and `full` mode
arrive in later plans.

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
`alayacare` or `alaya-care`; dots and other punctuation are rejected) and reuse
the exact same `SITE=...` value in every command below. Each bash snippet is
self-contained; shell variables and file descriptors do not carry over between
tool calls.

The recorder owns the browser and reads commands as JSON lines from a named pipe.
Paths are pinned under `~/.rkt-clients/run/<site>/` so later steps can find them:

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
SITE=<site-slug>
[[ "$SITE" =~ ^[a-z0-9-]+$ ]] || { echo "site slug must be lowercase letters, digits, hyphens only"; exit 1; }
RUN="${HOME}/.rkt-clients/run/${SITE}"
PIPE="${RUN}/commands.fifo"
LOG="${RUN}/record.log"
mkdir -p "$RUN"
[[ -p "$PIPE" ]] || mkfifo "$PIPE"
(cd "$SCRIPTS" && bun src/record.ts --site "$SITE" < "$PIPE") >"$LOG" 2>&1 &
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
PIPE="${HOME}/.rkt-clients/run/${SITE}/commands.fifo"
echo '{"kind":"goto","url":"https://<site>/login"}' > "$PIPE"
```

Then tell the user: "Chrome is open. Please sign in, and tell me when you're
done." Wait for them. Never type credentials yourself and never ask for them.

On later recordings of the same site the profile is already authenticated and
this step is a no-op.

## Step 4: Map the site and pick sections

Navigate the site's main nav, reading each page's title and URL from the
recorder's responses. Then ask via `AskUserQuestion` (multi-select) which
sections to derive, listing what you found.

## Step 5: Exercise the chosen sections

For each chosen section, issue `goto`, `click`, and `fill` commands to walk
list views, pagination, filters, and at least one detail view. Write each command
to the pipe by path (one command per bash call):

```bash
SITE=<site-slug>
PIPE="${HOME}/.rkt-clients/run/${SITE}/commands.fifo"
echo '{"kind":"goto","url":"https://<site>/section"}' > "$PIPE"
```

The recorder paces itself between actions; do not add your own tight loops.

## Step 6: Close and derive

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
SITE=<site-slug>
LOG="${HOME}/.rkt-clients/run/${SITE}/record.log"
PIPE="${HOME}/.rkt-clients/run/${SITE}/commands.fifo"
READY=$(grep -m1 '"event":"ready"' "$LOG" || true)
SANITIZED_SITE=$(printf '%s' "$READY" | sed -n 's/.*"site":"\([^"]*\)".*/\1/p')
RECORDING_DIR=$(printf '%s' "$READY" | sed -n 's/.*"recordingDir":"\([^"]*\)".*/\1/p')
[[ -n "$SANITIZED_SITE" ]] && SITE="$SANITIZED_SITE"
echo '{"kind":"done"}' > "$PIPE"
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

If `echo … > "$PIPE"` hangs, the recorder may have died — check `"$LOG"` before
retrying.

Report the derived endpoints to the user. If zero endpoints were derived but the
site clearly worked, say so plainly: the likely cause is API traffic routed
through a Service Worker, which HAR recording cannot see.

## Step 7: Confirm the detected credential

`derive.ts` reports what it found, for example:

```
Stored cookie credential for "alayacare" at 0600 (location: cookie:sessionid).
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
