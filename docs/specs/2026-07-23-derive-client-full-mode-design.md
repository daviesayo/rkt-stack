# derive-client: full mode (read + write clients)

**Date:** 2026-07-23
**Status:** Design, pending user review
**Targets:** rkt plugin v0.10.0 (minor: new capability). Actual bump happens at
release time per AGENTS.md Release Flow, consolidating whatever is in
`## [Unreleased]` then; this header is the intent, not a pre-commitment.
**Builds on:** v0.9.1 (regenerate.sh + generic identity)

## Problem

Derived clients are read-only by construction. `filter.ts` drops every
non-GET/HEAD request during derivation, `transport.ts` rejects non-read methods
in two places (`buildRequest` and `issue`), and `ManifestEndpoint.writeSemantics`
is a reserved-but-empty slot typed `null`. So a client can list a site's data
but never create, update, or delete it. Real automation needs writes: creating
an event, updating a roster entry, cancelling a booking.

The groundwork is already laid. `har.ts` **captures request bodies**
(`postData`, currently used only to replay token grants). `filter.ts` **already
has an `allowWrites` option** stubbed "Full mode only". `synthesize.ts` has
generic JSON shape inference (`shapeOf`/`mergeShapes`). What is missing is a
body-param model, a write transport path, a curation surface for write commands,
and, above everything, a **safety model** strong enough that neither a human
fat-finger nor an agent-in-the-loop causes a silent, irreversible mutation.

Writes are irreversible in a way reads never are. This design treats safety as
the primary requirement, not a bolt-on.

## Goal

Let a derived client expose a site's write endpoints as curated commands, with
guardrails that make every mutation a deliberate, previewable, gated act, for
both a human at a terminal and an agent (Claude) driving the client in a session.

## Non-goals

- **Unattended / cron writes.** Out of scope. There is no human or agent present
  to consent, and the gate below assumes a decision-maker is. A cron that mutates
  state (the future [[rkt-roster-feed]] write case) needs allowlists and
  idempotency machinery this design deliberately does not build.
- **`--json` arbitrary-body escape hatch.** Deferred to a later release. v1 bodies
  are curated templates with marked holes (see Design). `--json` can raise the
  ceiling later if a real task needs a body too dynamic to template.
- **Danger classification by HTTP verb.** A POST can delete; a DELETE can be
  trivial. All writes get the same gate. No verb is treated as "safe".
- **Auto-exposing endpoints without curation.** Writes reuse the `commands.json`
  curation model. Deriving a write endpoint does not create a command for it.
- **Enum / multi-sample body inference.** No enum-value inference from samples.
  Body modeling is shape + format hint only.
- **Non-JSON request bodies (v1).** Only JSON request bodies get a modelled
  `bodyShape` and typed flags. urlencoded / multipart writes are recorded
  (`contentType` kept, `bodyShape: null`) but not modelled in v1; a later release
  can add a urlencoded body builder.
- **Non-2xx write responses (v1).** The filter's success-status gate (`filter.ts:81`)
  is unchanged, so a write answering `3xx` (e.g. a form-POST `302`/`303` redirect)
  is not derived in v1. Scope is JSON APIs returning `200/201/204`.

## Locked decisions (from brainstorming)

1. **Callers:** human at a terminal + agent (Claude). No unattended cron.
2. **Body input model:** the curated `commands.json` task pins the body and marks
   which fields are caller-supplied; marked holes surface as typed `--flags`.
   Not `--json`, not derive-and-go per-endpoint flags.
3. **Fire gate:** dry-run **by default**; a bare write previews and exits, and
   only sends when `--commit` is passed. No TTY-dependent interactive prompt
   (it would be a hang or theatre for the agent caller).
4. **Env-flag gating:** writes do not exist unless an env flag is set. Flag off →
   write commands are not listed in `--help` and are rejected if invoked.
5. **Body capture:** manifest stores the request body **shape + format hints**
   only, never the recorded values. Nothing foreign, stale, or replayable is
   persisted. The curator authors the live body template fresh.
6. **Method scope:** all write methods (POST/PUT/PATCH/DELETE) in v1, uniform gate.

## Design

Seven parts: schema, derivation, curation surface, transport, runtime, codegen,
skill. The safety model is called out separately because it spans all seven.

### 1. Manifest schema (`lib/manifest-schema.ts`)

Add a top-level `mode` and give `writeSemantics` a real shape.

```ts
export const SCHEMA_VERSION = 3;

export interface WriteSemantics {
  /**
   * Body field names + types, from the recorded request body. No values.
   * null when the endpoint takes no body (bodyless POST/PUT, most DELETEs).
   */
  bodyShape: JsonShape | null;
  /** Dotted body path -> format hint, e.g. "starts_at" -> "iso8601". */
  bodyHints: Record<string, string>;
  /** Observed request Content-Type; null when there is no body. */
  contentType: string | null;
}

export interface ManifestEndpoint {
  // ...unchanged...
  writeSemantics: WriteSemantics | null; // was: null
}

export interface ClientManifest {
  // ...unchanged...
  /** Read-only client (default) or read+write. Absent = "read". */
  mode?: "read" | "full";
}
```

`writeSemantics` is **present (non-null) for every write endpoint** even when
`bodyShape` is null, so codegen and the transport gate can recognise a write
structurally without a body. It stays `null` for read endpoints.

**Construction site (do not miss this).** `ManifestEndpoint` is built in
`src/lib/manifest.ts` (`buildManifest`), which today hardcodes
`writeSemantics: null` and never sets `mode`. That file, not just
`src/lib/manifest-schema.ts`, is where the new fields get populated; it is listed
in §2. (All `lib/...` paths in this spec live under
`plugins/rkt/skills/derive-client/scripts/src/lib/`.)

**Backward compatibility (real migration concern).** Existing luma and
kirinari-alayacare manifests are `schemaVersion: 2`. `validateManifest` currently
hard-rejects anything but the exact version. Change it to **accept 2 or 3**: a
version-2 manifest is treated as `mode: "read"` with all `writeSemantics: null`,
so existing read-only clients keep working untouched. A client regenerated in
full mode is written at version 3. Regenerating a v2 client in read mode leaves
it read-only (still valid). This avoids forcing a re-record of every existing
client.

`bodyShape` reuses the existing `JsonShape` union (`shapeOf` already produces it).
Format hints are stored **separately** so the shape stays the same type reads use.

### 2. Derivation (`derive.ts`, `filter.ts`, `synthesize.ts`, `manifest.ts`)

- **`derive.ts` gains a `--mode full` flag** (default read). This threads down
  through **`deriveManifest(harPath, site)` (`derive.ts:29`), whose signature also
  gains a mode/`allowWrites` parameter** — it currently calls `filterEntries` with
  defaults and passes nothing to `buildManifest`, so both call sites change. Full
  mode threads `allowWrites: true` into the filter and records `mode: "full"` on
  the manifest. `record.ts` is unchanged; it already captures `postData`
  (`har.ts:12`).
- **`filter.ts`:** pass `allowWrites` from the mode. The method-drop is already
  stubbed (`filter.ts:47,58`), but the response-quality gates then discard writes:
  a `204 No Content` write has an empty body (dropped at `filter.ts:85`) **and**
  typically no `Content-Type`, so `DATA_MIME.test("")` is false and it is dropped
  again at `filter.ts:89`. Fix **both**: for a write endpoint, skip the
  response-body and content-type quality gates entirely (they judge whether a
  *response* is useful data, which is irrelevant to a write we keep for its
  *request*). Reads keep both drops unchanged.
- **`manifest.ts` (`buildManifest`, the construction site):** stop hardcoding
  `writeSemantics: null`. For a write endpoint, populate `writeSemantics` (below);
  for a read endpoint, keep `null`. Set `mode` on the returned manifest from the
  derive flag.
- **`synthesize.ts`:** derive `bodyShape` from the recorded request body.
  - `shapeOf`/`mergeShapes` are **not currently exported** (only `templatePath`,
    `groupEndpoints`, `inferShape` are). Reuse `inferShape(bodies)` (already
    exported, already the multi-sample response-shape merger) fed the request
    bodies instead of response bodies, or export `shapeOf`. Do not describe them
    as "existing" callable helpers; one of these two wiring steps is required.
  - **Multi-sample:** `groupEndpoints` groups every recorded sample of an
    endpoint, so a write may carry several `postData` values. Merge their shapes
    (this is exactly what `inferShape` does across a sample set), do not assume one.
  - **Bodyless writes:** when every sample's `postData` is null/empty (DELETE,
    bodyless POST), set `bodyShape` and `contentType` to `null` **before** calling
    the shape merger (`inferShape` never returns null; on any parse failure it
    collapses the whole merge to `{type:"unknown"}`, so the null case must be
    special-cased up front, not left to it).
  - **JSON bodies only in v1.** Only derive `bodyShape` when the recorded request
    `Content-Type` is JSON. `har.ts`'s `readPostData` normalises urlencoded /
    multipart bodies to a urlencoded *string*, which would hit `JSON.parse` and
    silently collapse to `{type:"unknown"}`. For a non-JSON write body, record
    `contentType` but leave `bodyShape: null` and mark the endpoint so the curator
    knows the body is not modelled (non-JSON request bodies are a v1 limitation,
    see Non-goals).
  - **Scrub data-derived object keys.** `shapeOf` uses `Object.keys` as property
    names, so a map keyed by a user id/email (`{"alice@x.com": {...}}`) would
    persist that literal as a schema key in the committed `client.json`, defeating
    the "no foreign data" bar for bodies. Run the same format-hint classifier over
    **keys**: an object whose keys classify as data (email/uuid/long-id) collapses
    to a generic record shape (a single wildcard entry, keys dropped) rather than
    persisting the literal keys.
  - Build `bodyHints` by walking the parsed body, then **discard the values**.
    `contentType` comes from the recorded request headers. **Path convention:**
    hints key object-scalar leaves by dotted object path only; array leaves and
    values nested inside arrays get no hint in v1 (the shape's `type` carries them).
    No array-index or wildcard syntax is introduced.
- **Format-hint inferrer (new, small):** classify a string leaf value into
  `iso8601 | email | uuid | url | <absent>` by regex. Output the hint string only;
  the value never leaves the function. Non-string leaves get no hint (type carries
  it). This is where Option-2's value (type disambiguation) is captured without
  Option-2's risk (stored foreign data).

Result: the manifest describes *how to build a valid body* (field names, types,
formats) without carrying *anyone's actual body*.

### 3. Curation surface (`lib/commands-schema.ts`)

`CommandSpec` gains an optional `write` flag; the `call` shape (an **inline
anonymous type** on `CommandSpec` today, not a named `CallSpec` interface) gains
an optional `body`. The body is a JSON value whose **string leaves** are resolved
through the existing token machinery, extended with a caller-argument token.

```ts
export interface CommandSpec {
  // ...unchanged: name, summary, output, redact, join...
  call: {
    endpoint: string;
    params?: Record<string, string>;
    /** Request body template. Object/array/scalar; string leaves are tokenized. */
    body?: unknown;
  };
  /** Marks a mutating command. Required when call targets a write endpoint. */
  write?: boolean;
}
```

**Tokens (extends `lib/tokens.ts`).** Today a string value resolves via
`resolveToken(value, ctx, now): Promise<string>`: literals pass through, `@me` and
`@today` resolve dynamically. Add one form:

- `@arg:<name>` -> the value of CLI flag `--<name>`, where `<name>` is used
  **verbatim** (no kebab-casing), matching the existing param-override flag surface
  (`flagValue(key)`, `codegen.ts`): `@arg:starts_at` -> `--starts_at`, not
  `--starts-at`. Verbatim avoids a reverse-mapping step on lookup. The union of
  `@arg:` names across `params` and `body` defines the command's caller flags. This
  requires a
  new `TokenContext` slot carrying the parsed `--<arg>` values (today `TokenContext`
  has `resolveMe`/`timezone` only, no caller-arg map); `resolveToken` reads
  `@arg:name` from it. Params keep their existing `overrideParams` override path;
  `@arg:` is the mechanism for reaching values **inside a body**, where there is no
  flat-param override slot.

**Type coercion (explicit, not implied).** `resolveToken` returns a string, but a
JSON body needs real numbers/booleans. After a body leaf's `@arg:`/token resolves
to a string, coerce it to the leaf's `bodyShape` type at that path
(`number`->parseFloat with NaN rejected, `boolean`->true/false, else string).
Format hints (`iso8601`, etc.) drive **validation** of the string, not coercion.
This coercion step is new code; it lives where the body template is materialised
(§5), keyed on the shape, so `--count 5` becomes `5` and `--starts_at <s>` is
validated as ISO before it goes on the wire.

Example curated write task (authored fresh, never pasted from a recording):

```json
{
  "name": "event-create",
  "summary": "Create a Luma event",
  "write": true,
  "call": {
    "endpoint": "post.event.create",
    "body": {
      "name": "@arg:title",
      "start_at": "@arg:starts_at",
      "timezone": "America/New_York",
      "visibility": "public"
    }
  },
  "output": { "kind": "json" },
  "redact": ["body.name"]
}
```

`title` and `starts_at` become `--title` / `--starts_at`; `timezone` and
`visibility` are pinned; the caller can touch nothing else. That small surface is
the safety win from choosing the curated model.

**`redact` gains a `body.` namespace.** A `redact` entry `body.<path>` masks that
path in the **request** echo (dry-run / commit preview). Existing response-path
redaction is unchanged.

**Validation.** Two functions, two distinct jobs:
- **`validateCommandsFile`** (no manifest access): carry `write` and `call.body`
  through the whitelist reconstruction. *(v0.9.0 trap: the validator reconstructs
  specs field-by-field, so a new field silently dropped there never reaches
  codegen. Add them explicitly.)* Shape-only checks (e.g. `write` is a boolean).
- **`assertResolvable`** (has manifest access) owns the cross-checks against
  endpoints. Its endpoint parameter is currently `Pick<ManifestEndpoint, "id" |
  "params">`; **widen it to include `method` and `writeSemantics`** so it can:
  - reject a command whose endpoint method is non-read but lacks `write: true`,
    and a `write: true` command targeting a read endpoint (fail-closed: prevents
    an un-gated mutation slipping through as a read);
  - reject an `@arg:` name whose body/param path has no shape entry (so every flag
    can be typed). Unknown `@arg:` -> error.

**`redact` namespace split.** `CommandSpec.redact` stays one flat `string[]`.
Entries prefixed `body.` apply to the **request preview** object (§5); unprefixed
entries apply to the **response** render as today. `runCommand` partitions them by
prefix so a `body.` entry is not applied to the response and vice-versa.

**Writes must never reach an uncurated command path (fail-closed).** Two existing
code paths auto-produce commands with no curation, and both would otherwise expose
a write with none of the four gates:
- **`scaffold-commands.ts` (`scaffoldCommands`)** auto-drafts one `CommandSpec` per
  endpoint. For a write endpoint it must emit a **curated stub, not a bare read**:
  `write: true`, and a `call.body` built from `bodyShape` with every scalar leaf as
  an `@arg:<path>` hole (all-editable starting point the curator then prunes/pins).
  A bodyless write gets `write: true` and no body. This keeps the standard
  record -> derive -> scaffold -> generate flow schema-valid (without it, the new
  `assertResolvable` write-rule rejects the scaffolder's own output).
- **`emitEndpointCli` (the no-`commands.json` fallback, `codegen.ts`)** builds a raw
  endpoint-per-command CLI with no body assembly, no `--commit`, and opt-in
  dry-run. It must **skip write endpoints entirely**: a full-mode client with no
  authored `commands.json` exposes only its **reads**. Writes require a curated
  task. This preserves the "no auto-exposing without curation" non-goal and keeps
  all four gates intact.
- **`src/call.ts` (the manual debug invoker)** issues any endpoint id straight from
  the manifest. It is not a *command* path, which is why it sits outside the frame
  above, but it **is** a request path, and today it is read-only only because
  `buildRequest` throws on non-read methods. Making that throw conditional (§4)
  silently turns `call.ts` into a write path with two of the four gates. It must
  **enforce its own read-only refusal**, structurally and unconditionally, so it
  refuses writes even in full mode with the flag on. Its stale comment and the
  SKILL text claiming transport refuses writes must be corrected.

**Generalisation worth carrying forward:** the enumeration that matters is not
"every path that builds a command" but **every caller of the guard being
relaxed**. Before removing `buildRequest`'s throw, enumerate its callers; the
command-path framing alone misses `call.ts`.

### 4. Transport (`lib/transport.ts`)

- **`buildRequest`** stops hard-rejecting writes. It **gains a `body` parameter**
  (a fourth widening site the enumeration below now names): for a write endpoint it
  builds the URL as today (path + query), serialises the passed body to JSON, and
  sets `content-type` from `writeSemantics.contentType` (default `application/json`).
  The read/write decision is **structural**: `READ_METHODS.has(endpoint.method)`.
- **`issue`** sends `body` for writes.
- **Writes never auto-retry (idempotency safety, load-bearing).** The read path
  re-issues on 401-after-renewal (`runtime.ts:90-93`) and backs off / re-sends on
  429/503 (`scheduler.ts`). For a **read** those replays are safe; for a **write**
  a request the server already committed before answering 401/503 would fire
  **twice** (two events created). So: a non-read request must **not** be
  auto-retried. `issue` (or the scheduler, keyed on method being non-read)
  suppresses backoff-retry for writes, and the runtime does **not** re-issue a
  write after a 401 renewal; instead it surfaces a `CliError` that says the write
  may or may not have applied and to verify before re-running. This is the
  attended-path idempotency rule (cron idempotency stays a non-goal).
- **Env-flag gate, keyed on structure not names.** A non-read request is refused
  unless `RKT_ALLOW_WRITES` is enabled (see §Security for exact truthiness). Place
  the gate in **`issue` (the send), not `buildRequest`**, so the dry-run preview
  can still *build* the request object to display it. This is defense-in-depth
  behind the runtime gate in §5; transport never mutates on its own even if a
  caller bug reaches it. A read-mode manifest (`mode !== "full"`) refuses all
  writes regardless of the flag.

`BuiltRequest` gains an optional `body: string`.

**Body-plumbing sites that must widen (full end-to-end list).** A body must thread
through every hop or it is silently dropped or fails to compile under `strict`:
1. `BuiltRequest.body?: string` (§4).
2. `buildRequest(..., body?)` parameter (§4) — the materialised body's only route
   into `BuiltRequest`.
3. `SchedulerRequest.body?: string` + `fetchWithBackoff` forwarding it to `fetch`
   (omitting this is an excess-property compile error).
4. `RunnerCaller.call(endpointId, params, body?)` (`command-runner.ts`).
5. runtime `Caller.call(endpointId, params, body?)` (`runtime.ts`) and its
   `createCaller.call` implementation, which calls `buildRequest`.
These are two separate `Caller`/`RunnerCaller` interfaces (v0.9.0 trap); both
widen. Credentials are applied by `applyCredentials` into **headers**, never the
body, so body plumbing never carries a secret.

### 5. Runtime (`lib/command-runner.ts`, `lib/runtime.ts`)

- **`RunOpts` gains the write control state** (named fields, not implied): a
  `commit: boolean` (was `--commit` passed) and an `args: Record<string,string>`
  (parsed `--<arg>` flag values). `runCommand` seeds `TokenContext` with `args` so
  `@arg:` resolves. `RunnerCaller.call`/`Caller.call` gain the optional `body`
  (plumbing list above).
- **`runCommand` returns a discriminated result, it does not `exit` inside the
  library.** Add a `{ kind: "preview"; rendered }` vs the existing send result
  (`{ kind: "sent"; ... }`); the generated `main()` prints and chooses the exit
  code. This keeps the "no network call on preview" behavior **unit-testable**
  without intercepting `process.exit`.
- **`runCommand` write path.** When `cmd.write`:
  1. Resolve `params` (existing flat path) and **materialise the `body` template**:
     walk the JSON template, and for each **string leaf** resolve tokens via
     `resolveToken` (`@me`, `@today`, `@arg:*`) then coerce to the leaf's shape type
     (§3). Non-string leaves pass through. This tree-walk is new; `resolveToken` is
     per-string, so the walker calls it per leaf. `TokenContext` carries `args` (§3).
  2. Build the request via transport (URL + serialised body + content-type).
  3. **If `!commit`:** return `{ kind: "preview", rendered }`, **no network call**
     (dry-run-by-default). The rendered preview is one object:
     `{ method, url, headers: <secret-masked>, body: <redacted> }`. Header masking
     uses `maskHeaders` (in `secrets.ts`; **new import into `command-runner.ts`** —
     the task-CLI path has no existing dry-run, so this is net-new wiring, not
     reuse); the `body.`-namespaced `redact` paths apply to `body` via `render.ts`'s
     dotted-path `redactClone` primitive (**currently unexported — export it, same
     wiring step as `shapeOf` in §2**), then `maskSecretValues` over the whole
     object as a backstop.
  4. **If `commit`:** check the env-flag gate; on failure raise a `CliError` telling
     the caller to enable writes (defense-in-depth: through the real CLI the §6
     listing gate already makes a flag-off write an unknown command, so this fires
     mainly for direct/programmatic callers and unit tests). On success, send with
     **no auto-retry** (§4), then render the response like a read. A `204`/empty
     response is success with no body, not an error.
- Credential headers (cookie / bearer / csrf) are **always** masked in the preview
  echo. A dry-run must never print a live credential to the scrollback.

### 6. Codegen (`lib/codegen.ts`)

- **Remove the hard write-block first (this is the current blocker).** Today
  `commandNames()` (`codegen.ts:26`) and `emitCli()` (`codegen.ts:107`)
  **unconditionally throw** on any non-GET/HEAD endpoint, and `emitTypes()` runs
  `commandNames()` over the full endpoint list before `emitCli()`. So generating
  from a full-mode manifest with even one write endpoint crashes before any
  write-emission code runs. These throws must become conditional: allowed when the
  manifest is `mode: "full"`, still rejected in read mode. (The method-aware
  naming in `commandNames()`, `method === "GET" ? segments : [method, ...segments]`
  at `codegen.ts:39`, is already write-ready; it is currently dead code behind the
  guard.)
- Emit write commands with typed `--<arg>` flags derived from the `@arg:` holes,
  typed by `bodyShape` + `bodyHints`.
- Register `--commit` on write commands; dry-run is the default so no `--commit`
  means preview.
- **Skip writes in the uncurated fallback.** `emitEndpointCli` (no-`commands.json`
  path) must not emit write endpoints at all (§3); only `emitTaskCli` (curated)
  emits writes.
- **Runtime flag gate on listing.** `emitTaskCli` emits `COMMANDS` as a build-time
  static array. The generated `main()` filters that array by `RKT_ALLOW_WRITES`
  **at runtime** before `usage()` and dispatch: flag off -> write commands are
  dropped from the list, so they do not appear in `help` and invoking one is an
  unknown command (fail-closed; no special message that would re-expose the hidden
  tool to an enumerating agent). To keep a human from being mystified, `help` ends
  with a **generic** footer when the manifest is full mode and the flag is off,
  e.g. "write commands are hidden; set RKT_ALLOW_WRITES=1 to enable" — it reveals
  that writes exist and how to enable, **without listing which**. This implements
  "when the flag is off, the agent shouldn't even see the tools" without changing
  the static emission model (the array is emitted whole; the filter is a small
  runtime step in `main()`).
- Read-mode clients emit no write commands and no `--commit`. **"Byte-identical to
  today" holds only for the regenerate path** (an unchanged v2 `client.json` on
  disk): a **re-derived** read client is written at `schemaVersion: 3`, so its
  `client.json` and the `GENERATED_HEADER` version line differ from the committed
  v2 luma/kirinari files. The claim is about not perturbing existing on-disk
  clients, not about re-derivation output.

### 7. Skill (`SKILL.md`)

Add a **Full mode** section:

- **Recording a write performs it.** You cannot capture `event-create` without
  creating an event. Instruct: perform each write against **disposable / test
  data** you are willing to leave behind (a throwaway event, a test row you then
  delete). Note plainly that recording mutates real state.
- **Derive with `--mode full`.** Only then do write endpoints survive.
- **Author write tasks fresh.** Never paste a recorded body; the manifest stores
  only shape + hints for exactly this reason. Mark caller fields with `@arg:`, pin
  the rest. A pinned literal that itself starts with `@` (e.g. a Slack `@channel`
  mention in a body) must be escaped `@@channel`, since an unrecognised `@`-token
  is a hard error (existing token behavior; bodies hit this more than params do).
- **The gate is dry-run -> `--commit`.** Show the two-step: preview first, read the
  echoed request, then re-run with `--commit`. Enabling writes at all requires
  `RKT_ALLOW_WRITES`.
- **Agent rule (safety doctrine).** An agent MUST surface the resolved write to
  the human and get explicit approval before adding `--commit`. The CLI cannot
  enforce human consent; the skill makes the agent ask. `--commit` is a
  permission-required action, not a regular one.

## Security model

The whole point of full mode. Four deliberate acts stand between intent and an
irreversible mutation, and each is independent:

1. **Build:** the client's manifest must be derived with `--mode full` (the flag
   lives on `derive.ts` and stamps `mode: "full"` on the manifest; `generate.ts`
   honours that manifest field, it takes no mode flag of its own). A read client
   has no write code at all: read-mode codegen keeps the write-block throw.
2. **Enable:** `RKT_ALLOW_WRITES` must be enabled. **Truthiness is pinned
   fail-closed:** enabled iff the value is exactly `"1"` (or `"true"`); everything
   else, including unset, `""`, `"0"`, and `"false"`, is disabled. A gate whose job
   is to fail closed must never read `=0` as enabled. Off -> write commands are
   invisible and rejected.
3. **Curate:** a human authored the write task and chose which body fields are
   editable. Un-marked fields cannot be changed by caller or agent.
4. **Commit:** the invocation must carry `--commit`. A bare run only previews.

Additional properties:

- **No stored foreign data / PII.** Body shape + format hints only; recorded
  values are discarded at derivation. `client.json` (which is committed) never
  carries anyone's payload. Contrast reads, which store scalar `example` values;
  bodies are richer and riskier, so they earn the higher bar.
- **Credentials never printed.** The dry-run echo masks secret header values.
- **Structural gates, not name-based.** Read/write is decided by
  `READ_METHODS.has(method)` and `mode === "full"`, never by endpoint id or path
  substring. A name-based check would be a bypass.
- **Uniform blast radius.** Every write method gets the same four gates; no verb
  is trusted.
- **No silent double-mutation.** Writes never auto-retry (§4): no backoff re-send
  on 429/503, no re-issue after a 401 renewal. A write that fails mid-flight
  surfaces "may or may not have applied, verify before re-running" rather than
  silently firing twice. This is the attended-path idempotency guarantee.
- **Data-derived keys scrubbed.** Body object keys that classify as data
  (email/uuid/id) collapse to a generic record shape (§2), so a map keyed by PII
  does not persist that PII as a schema key in the committed `client.json`.
- **Agent consent is out-of-band.** The CLI provides the previewable, gated
  mechanism; the skill obliges the agent to get human sign-off before `--commit`.
  Unattended callers are a non-goal precisely because they cannot satisfy this.

**Flag scope (open sub-decision for the plan, defaulted here):** `RKT_ALLOW_WRITES`
is process-global by default. A per-client variant (`RKT_ALLOW_WRITES_<SITE>`) is
a cheap add if a session should enable writes for one client only; the plan will
implement global first and note the per-client override as a follow-up unless it
falls out for free.

## Testing

- **filter:** `allowWrites: true` keeps a POST; default drops it (regression).
- **synthesize:** a recorded JSON body yields `bodyShape` + `bodyHints`, and the
  manifest contains **no** recorded body values (assert the example string is
  absent); multiple recorded samples of one write merge (a key absent from one
  sample is optional); a bodyless write (null `postData`) yields
  `writeSemantics` present with `bodyShape: null`, `contentType: null`.
- **manifest/filter:** a `204`/empty-response write endpoint survives filtering in
  full mode (regression guard for `filter.ts:85`); `buildManifest` populates
  `writeSemantics` for writes and `mode: "full"`, `null`/absent for reads.
- **codegen guard:** generating a full-mode manifest with a write endpoint no
  longer throws (regression for `codegen.ts:26`/`:107`); a read-mode manifest with
  a stray write endpoint still throws.
- **coercion:** `--count 5` reaches the body as JSON `5`; a non-numeric `--count`
  is rejected; a bad `--starts_at` fails ISO validation.
- **format-hint inferrer:** iso date -> `iso8601`, email -> `email`, uuid ->
  `uuid`, plain string -> no hint.
- **schema/validate:** `write` + `call.body` survive `validateCommandsFile`; a
  write command on a read endpoint (and vice-versa) is rejected; unknown `@arg:`
  is rejected; a v2 manifest still validates as read-only.
- **transport:** write builds a JSON body + content-type; a write is refused when
  `RKT_ALLOW_WRITES` is unset; a write is refused on a `mode: "read"` manifest.
- **runtime:** `runCommand` returns `{kind:"preview"}` with **no network call**
  (assert the caller was never invoked) and a redacted echo that masks the
  credential header; with `commit` + flag on it returns `{kind:"sent"}` with the
  body on the wire; with `commit` + flag off it raises the enable-writes `CliError`
  (direct-call defense-in-depth); `@arg:` resolves from `RunOpts.args`.
- **no auto-retry (safety):** a write that gets 503 is **not** re-sent, and a write
  that gets 401 is **not** re-issued after renewal; both surface the
  may-have-applied `CliError`. (Reads still retry: regression guard.)
- **key scrub:** a recorded body keyed by an email/uuid yields a `bodyShape` with
  no literal key value in the manifest.
- **schema constants:** the `SCHEMA_VERSION === 2` / built-manifest-version
  assertions (`manifest.test.ts`) are updated to 3, plus a new "v2 manifest still
  accepted as read-only" case (TDD: these go red first).
- **codegen:** a write command emits typed `--<arg>` flags + `--commit`; with the
  flag off the write command is not listed in `help`; read-mode output is
  byte-identical to today.
- **uncurated paths fail-closed:** `emitEndpointCli` (no commands.json) emits **no**
  write endpoint even in full mode (reads only); `scaffoldCommands` emits a write
  endpoint as a `write: true` stub with an `@arg:`-holed body, and that scaffold
  output passes `assertResolvable` and generates without throwing.
- **scheduler:** a write body set on `SchedulerRequest` is forwarded to `fetch`
  (covered by the generated-client `tsc` test, since omitting the widening is a
  compile error).
- **skill:** the Full mode section documents disposable-data recording, the
  dry-run -> `--commit` two-step, and the agent-consent rule.
- **generated client typechecks** (`tsc --noEmit`) in full mode.

## Requirement -> task self-review map

| Requirement | Where |
|---|---|
| Body shape + hints, no values | §1 schema, §2 synthesize, format-hint inferrer |
| v2 clients keep working | §1 backward-compat (accept schema 2 or 3) |
| Curated body, marked holes as flags | §3 curation surface, `@arg:` token |
| Dry-run by default, `--commit` to send | §5 runtime, §6 codegen |
| Env-flag gating, tools invisible when off | §4 transport gate, §6 listing gate |
| All write methods, uniform | §4 structural READ_METHODS check |
| Credentials/PII never leak | §5 masked echo, §Security no-stored-data |
| Agent gets human consent | §7 skill agent rule, §Security out-of-band |
| Structural not name-based gates | §4, §Security |
| Codegen no longer throws on writes | §6 (remove write-block for full mode) |
| Schema fields actually populated | §2 `manifest.ts` buildManifest |
| DELETE / 204 / bodyless writes derive | §2 filter keep + null bodyShape |
| `@arg:` typing + string->JSON coercion | §3 coercion, §5 body materialise |
| Body-token resolution over a nested tree | §5 step 1 tree-walk + TokenContext arg map |
| Request-echo redaction (new behavior) | §5 step 3 (header mask + body redactClone, exported) |
| Uncurated fallback never exposes writes | §3 fallback, §6 skip in emitEndpointCli |
| Scaffolder emits valid write stubs | §3 scaffolder (write:true + @arg: body) |
| Body reaches the wire (3rd interface) | §4 SchedulerRequest widening |
| 204 survives both filter drops | §2 filter (skip body + content-type gates) |
| JSON-only bodies; non-JSON recorded not modelled | §2, Non-goals |
| Mode plumbed through deriveManifest | §2 deriveManifest signature |
| Body reaches wire, all 5 hops | §5 body-plumbing list (adds buildRequest param) |
| Writes never auto-retry (no double-mutation) | §4 no-retry, §Security |
| runCommand preview/send is a return, not exit() | §5 discriminated result |
| Env flag truthiness fail-closed | §Security (=="1"/"true" only) |
| Flag-off write is unknown cmd + generic footer | §6 listing gate |
| Data-derived body keys scrubbed | §2 key scrub, §Security |
| @arg names map to flags verbatim | §3 verbatim naming |
| Byte-identical claim scoped to regenerate | §6 |

## Deferred / future work

- Unattended / cron writes with allowlists + idempotency keys ([[rkt-roster-feed]]).
- `--json` / `--json-file` arbitrary-body escape hatch.
- Per-client `RKT_ALLOW_WRITES_<SITE>` scoping (noted in §Security).
- Enum-value inference from multiple recorded samples of the same write.
- Response-driven confirmation (e.g. echo the created resource id back into a
  local ledger for later reference).
