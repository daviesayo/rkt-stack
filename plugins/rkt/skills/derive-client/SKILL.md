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
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
command -v bun >/dev/null || { echo "bun is required: https://bun.sh"; exit 1; }
(cd "$SCRIPTS" && bun install)
```

## Step 2: Start the recorder

The recorder owns the browser and reads commands as JSON lines on stdin. Start
it in the background with a named pipe so you can issue commands as the crawl
proceeds:

```bash
SITE=<site-slug>
PIPE=$(mktemp -u); mkfifo "$PIPE"
(cd "$SCRIPTS" && bun src/record.ts --site "$SITE" < "$PIPE" > /tmp/rkt-record-$SITE.log) &
exec 3>"$PIPE"
```

Chrome opens visibly. Watch `/tmp/rkt-record-$SITE.log` for the `ready` event.

## Step 3: Have the user sign in

The profile starts empty, so **the first recording of any site requires a fresh
sign-in**. Navigate to the login page:

```bash
echo '{"kind":"goto","url":"https://<site>/login"}' >&3
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
list views, pagination, filters, and at least one detail view. The recorder
paces itself between actions; do not add your own tight loops.

## Step 6: Close and derive

```bash
echo '{"kind":"done"}' >&3
exec 3>&-
wait
HAR=$(ls -td ~/.rkt-clients/recordings/$SITE/*/ | head -1)session.har.zip
(cd "$SCRIPTS" && bun src/derive.ts --site "$SITE" --har "$HAR")
```

Report the derived endpoints to the user. If zero endpoints were derived but the
site clearly worked, say so plainly: the likely cause is API traffic routed
through a Service Worker, which HAR recording cannot see.

## Artifacts

All under `~/.rkt-clients/`, never in the repo:

- `profiles/<site>/` — persistent Chrome profile (holds the login)
- `recordings/<site>/<timestamp>/session.har.zip` — the recording
- `recordings/<site>/<timestamp>/flows.json` — replayable steps
- `recordings/<site>/<timestamp>/client.json` — the derived manifest

Never commit these. They contain session credentials.
