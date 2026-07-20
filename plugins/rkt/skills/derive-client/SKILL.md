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

## Artifacts

All under `~/.rkt-clients/`, never in the repo:

- `profiles/<site>/` — persistent Chrome profile (holds the login)
- `recordings/<site>/<timestamp>/session.har.zip` — the recording
- `recordings/<site>/<timestamp>/flows.jsonl` — replayable steps
- `recordings/<site>/<timestamp>/client.json` — the derived manifest

Never commit these. They contain session credentials.
