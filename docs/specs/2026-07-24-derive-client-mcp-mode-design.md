# derive-client: MCP mode (derived clients as MCP servers)

**Date:** 2026-07-24 (rev 3, post two blind reviews)
**Status:** Design, pending user review
**Targets:** next minor after full mode. Version chosen at release time per AGENTS.md
Release Flow; full mode is currently unreleased under `## [Unreleased]`.
**Builds on:** full mode (write gates, `commands.json` curation), v0.10.0 (agent-navigable CLI)

## Problem

A derived client can only be driven by a human at a terminal. Everything the
pipeline already produces, a typed endpoint manifest plus a curated,
human-authored task surface, is exactly what an MCP server needs, but there is no
way to expose it to an agent. The sites worth automating (Instagram is the
motivating case) have no official MCP server and never will, while the operator
already holds a working browser session for them.

The naive route, pointing a generic OpenAPI-to-MCP generator at a spec, produces
one tool per endpoint: dozens of thin, badly described tools that blow up the
agent's context and wreck tool selection. What makes a good MCP server is exactly
what `commands.json` already is, a small set of curated, task-shaped operations.

## Goal

Let `generate.ts` emit an MCP server for a derived client, reusing the existing
curation, auth, join, token and redaction machinery, so a local agent (and,
through a tunnel, a remote one) can drive a site that has no public API.

## Non-goals

- **Write tools (v1).** Read commands only. See "Why writes wait".
- **A remotely hosted server.** Runs on the operator's machine; remote reach is a
  tunnel plus a fail-closed listener token. Hosting elsewhere is a later phase and
  a different problem: credential custody.
- **`login` / `logout` / `auth status` tools**, and **no browser launch from a
  tool call** (§7; enforced, not merely intended).
- **A raw endpoint-fallback tool.**
- **Any search or FTS index over results.**
- **Instagram in v1.** Phase 2, see "First target".
- **Changing derivation.** No change to `record.ts`, `filter.ts`, `synthesize.ts`
  or the manifest schema.
- **Refactoring `runCommand`'s rendering.** Explicitly out of scope; see §5.

## Locked decisions

1. **Transport:** local stdio, plus an optional loopback HTTP listener on
   `127.0.0.1` behind a required token. Remote reach via `cloudflared` + Access.
2. **Adapter shape:** generic adapter in `lib/`, thin per-client entrypoint.
3. **Dependency:** the MCP SDK and `lib/mcp-server.ts` are present **iff any
   client under the shared root uses MCP**, decided by scanning the root each run
   rather than by the current invocation's flag (§3).
4. **Tool surface:** one tool per curated read command, plus `whoami` when the
   client has an identity block.
5. **Result path:** surface the **already-computed** shaped rows on `RunResult`.
   No pipeline refactor (§5).
6. **Scope:** read-only in v1; luma proves the mechanism, Instagram follows.

## SDK version

Use **`@modelcontextprotocol/sdk` `^1.29.0`** (stable v1.x):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
```

Remote/HTTP uses `StreamableHTTPServerTransport`; tests use
`InMemoryTransport.createLinkedPair()`. **Do not** use the `2.0.0-alpha`
restructure (`@modelcontextprotocol/server`, `serveStdio`, `createMcpHandler`).

**Dependency cost, stated accurately.** `@modelcontextprotocol/sdk@1.29.0`
declares ~17 runtime dependencies including `express`, `hono`,
`@hono/node-server`, `cors`, `jose`, `eventsource`, `ajv`, `ajv-formats`,
`pkce-challenge`, `zod` and `zod-to-json-schema`. *(An earlier draft called this
"one dependency", which was wrong and materially understated it.)* This is why
§3's predicate is root-aware rather than unconditional: a user who never generates
an MCP client never installs any of it. A root that **does** contain an MCP client
carries the whole tree for all its clients, which is accepted.

Consequence to handle either way: `tests/generate.test.ts` hard-asserts
`bun install` exits 0 with no offline skip, so any run that installs the SDK gets
slower and more network-fragile. Add an offline skip there, matching
`generated-runs.test.ts`'s existing pattern.

**zod** is both a dependency and a peer (`^3.25 || ^4.0`) and the SDK imports
`zod/v4` internally. Declare it explicitly, pin **inside that range**, and ensure
a single instance: a duplicated zod breaks schema identity.

**Confirm against installed typings, not these notes:** the exact `registerTool`
signature; `StreamableHTTPServerTransportOptions` field names; and whether
`@modelcontextprotocol/sdk/server/mcp.js` resolves under `moduleResolution:
"bundler"` via the package's catch-all `"./*"` export (the files exist; the
`types` condition through a glob is a real probe risk). `[uncertain]`

**Why vanilla SDK, not FastMCP.** Its headline feature is **in-server** auth, but
this design puts remote auth at the transport boundary (Access) plus a listener
token, so that machinery is redundant here; and it is a wrapper tracking the SDK
during the SDK's own 1.x→2.0 transition. *(An earlier draft also claimed vanilla
was safe-by-default on DNS rebinding. That was false, see Security; the reason is
withdrawn, not quietly kept.)*

## Design

### 1. Selecting MCP mode

- `generate.ts` gains `--mcp`, controlling **only** whether `<site>/mcp.ts` is
  emitted for that site.
- `generateClient(manifestPath, outRoot)` takes two positional args today with
  **29 call sites** (28 in `tests/`, one in `src/generate.ts`). Add an options
  object with a default so they keep compiling.
- `REGENERATE_SH` is a fixed const; it becomes a template so `--mcp` is
  self-perpetuating.
- **`--mcp` requires a `commands.json`.** A client without one uses the uncurated
  fallback CLI, and `buildServer` requires curation. Generating `--mcp` for such a
  client must **fail at generation time** with a clear message, not emit an
  `mcp.ts` that ENOENTs at startup.
- `SKILL.md` Step 9 needs an MCP branch.

### 2. `lib/mcp-server.ts` (generic; copied when the root uses MCP, see §3)

Exports `buildServer(clientDir, opts)`, which:

1. Loads `client.json` via `validateManifest` **imported from
   `lib/manifest-schema`** (`lib/manifest.ts` is deliberately excluded from
   `RUNTIME_FILES` and a test asserts it is never copied), and `commands.json` via
   `validateCommandsFile`.
2. Runs **`assertResolvable`** and **refuses to start** on failure.
3. Registers one tool per **read** command, plus `whoami` **only if
   `commands.identity` is present** (`runWhoami` throws without it, and the
   emitted CLI already omits it conditionally).

**Two mechanisms, two jobs, no contradiction.** `assertResolvable` already throws
when a command targets a write endpoint without `write: true`, so a hand-edited
`commands.json` **fails startup** rather than silently registering a mutation as a
read. The structural method filter (read/write decided by the endpoint's HTTP
method from `client.json`, never by the `write` field) is the belt-and-braces
second layer that decides registration for a file that *did* validate. The
corresponding test asserts **startup fails loudly**, not that a tool is silently
skipped.

**Skipped writes are reported over the protocol** (server instructions /
description), because under stdio a client discards stderr. **stdout is the
JSON-RPC channel under stdio**, so no module the MCP path touches may write to it.
*(Correction: an earlier draft claimed no copied `lib/` file writes to stdout.
False, `session.ts:510` does `console.log` in `runLifecycle`. MCP never calls
`runLifecycle`, so the risk is theoretical, but the stdout test must be scoped to
the modules the MCP path actually loads, or it is red on day one.)*

### 3. `<site>/mcp.ts` (thin, emitted) and packaging

Transport from argv: `StdioServerTransport` by default, or
`StreamableHTTPServerTransport` under `--http --port <n>` bound to `127.0.0.1`.

**One `McpServer` per Streamable HTTP session**, per SDK practice, and **sessions
must be reaped** on `onsessionclosed`/`close()`, or instances accumulate for the
process lifetime, the same leak class §7 flags for the cache.

**Packaging is root-aware, not flag-aware.** `generateClient` writes
`package.json`, `tsconfig.json` and `lib/` to **`outRoot`, the shared
`rkt-clients` root**, on every run, and the emitted `tsconfig.json` has no
`include`/`exclude`, so the probe compiles every `.ts` under the root. A naive
"conditional on `--mcp`" therefore breaks two ways: regenerating a *non*-MCP
client would rewrite the shared `package.json` **without** the SDK while another
client's `mcp.ts` is still on disk (probe fails, MCP client stops running), and
`write()` never deletes, so the flag would be one-way.

**The predicate.** Both the dependency and `lib/mcp-server.ts` are keyed on one
function:

```
mcpInUse(outRoot, thisRunUsesMcp) =
  thisRunUsesMcp || any <site>/mcp.ts exists under outRoot
```

The `thisRunUsesMcp` disjunct is load-bearing for **ordering**: on the run that
first adds `--mcp`, the scan happens before `<site>/mcp.ts` has been written, so
scanning alone would miss it and omit the dependency it is about to need.

- `mcpInUse` true → SDK + zod in `package.json`, `mcp-server.ts` copied into `lib/`.
- `mcpInUse` false → both omitted, **and `lib/mcp-server.ts` is deleted if
  present**. This is the one place generation must remove a file: `write()` only
  creates, so without the delete an orphaned `mcp-server.ts` would import an
  uninstalled SDK and fail the probe forever. The file is generator-owned (it
  carries the "Do not edit here" header), so deleting it is safe; deleting
  anything else is not, and nothing else may be deleted.

**Turning MCP off is a documented two-step**, because `<site>/mcp.ts` is
user-facing and is never auto-deleted: remove `<site>/mcp.ts`, then regenerate.
The scan then reports false and the dependency and adapter are cleaned up. Say
this in `SKILL.md`; a user who merely drops the flag will correctly see no change.

**Install ordering.** `regenerate.sh` runs only `generate.ts`; only `install.sh`
runs `bun install`. The first regeneration after this ships writes a new
`package.json` into a root whose `node_modules` lacks the SDK, so the closure
probe fails until someone installs. `regenerate.sh` must run `bun install` (or
say so loudly), and the packaging test must cover this ordering, not just
"two clients present".

### 4. Tool shape

| MCP field | Source |
|---|---|
| name | `command.name` |
| description | `command.summary` |
| `annotations` | `{ readOnlyHint: true }` |
| `inputSchema` | exposed params (below), plus `_limit` and `_offset` |

**Exposed params.** Join `call.params` (a `Record<string,string>`) to the
endpoint's `ParamSpec` list by name:

- **literal value** → exposed as an optional override, typed from the matching
  `ParamSpec.type`. **Only expose params that have a matching `ParamSpec`**:
  `buildRequest` drops any param with no spec, so exposing one advertises an
  argument that provably does nothing.
- **`@arg:<name>`** → exposed as a **required** argument. `@arg:` is valid in
  `call.params`, not just bodies; hiding it makes `resolveToken` throw on every
  call.
- **`@me`, `@today`, and `@today±<n><d|w|m|y>`** → **hidden**, resolved
  server-side. The offset form is a token too and must not be misread as a literal.
- **`@@<literal>`** → the escape form. A pinned literal starting with `@` is
  authored `@@x`; treat it as a literal, not a token.

**Agent-supplied values are literals, never re-tokenized.** `runCommand` merges
overrides into `call.params` and pushes **every** value through `resolveToken`, so
an agent passing `@me` would assert the operator's identity, exactly what hiding
`@me` was meant to prevent, and any legitimate value starting with `@` (a handle,
a search string) would throw. The adapter must therefore escape agent-supplied
values (`@` → `@@`) before merging, or pass them by a path that bypasses token
resolution. This is a **security control**, not ergonomics.

**Endpoint params absent from `call.params`** fall back to their recorded
`example`, same as the CLI. An agent has no `--help`; name this in the description
where it matters.

**Tool names are validated by the adapter.** `registerTool` on 1.29.0 only *warns*
on a malformed name (`validateAndWarnToolName`), so the adapter owns rejection.
Duplicate registration does throw, so a curated command named `whoami` collides;
detect and fail with the offending name.

### 5. Result path (rev-3: minimal, no refactor)

**The rev-2 shared-pipeline refactor is withdrawn.** It was the right diagnosis
and the wrong size: it would have changed `--json` output for every enveloped,
joined or sorted command while the spec simultaneously demanded byte-identical CLI
output (mutually exclusive); it ignored that `fullPayload` is deliberately built
from **unprojected** rows and pinned by an existing test; and it would have
collapsed two genuinely different `redact` implementations (column-name equality
in table mode, dotted-path in JSON mode) into one, changing behaviour in both
directions.

**What is actually needed.** `runCommand`'s table branch **already computes**
exactly the data MCP wants:

```ts
rows = extractRows(...) -> applyJoins(...) -> sortRows(...)
maskedRows = maskSecretValues(rows, secrets)
fullPayload = renderJson(maskedRows, { redact })   // dotted-path redaction over ROWS: correct
```

So: **add one field to `RunResult`** carrying the shaped, masked, **redacted**
rows as data (i.e. `redactClone(maskedRows, redact)`), populated only on the
row-shaped branch. The adapter renders it. CLI rendering is untouched, so
byte-identity is trivially true rather than a fought-for property.

**`output.kind: "json"` commands.** These take the JSON branch and never compute
rows, so MCP returns the raw body for them, matching CLI `--json` semantics
exactly. `columns` is optional for json-kind commands anyway, so there is nothing
to project by. State this in the skill: a command intended for MCP consumption
should be authored row-shaped.

**Folded in: fix the `--json` redaction bug (scoped).** Today the JSON branch runs
`redactClone` against the **raw envelope**, and `setPath` only assigns when the
final key exists at that level, so a declared `redact: ["attendee.email"]` against
`{"data":{"items":[…]}}` matches **nothing**. Declared redactions are silently
dropped. The surgical fix: in the JSON branch, when `cmd.output.rows` is set,
apply redaction **in place at the rows path** instead of at the envelope root,
leaving the output shape unchanged. This changes `--json` output **only** where a
declared redaction should have applied and did not, which is the bug by
definition. Everything else stays byte-identical and that remains testable.

### 6. Overflow

The CLI caps output and spills to a file in two places: `finishRun` on capping,
and `runCommand` on a `>=400` response. Both emit a host filesystem path.

MCP mode:
- **does not call `finishRun`** (stated, not inferred);
- caps rows using the existing `MAX_ROWS` / `MAX_BYTES` constants;
- returns an actionable truncation notice: rows returned, more available,
  `_offset`/`_limit` to page;
- writes **no spill file**; the error-path spill needs an opt-out on `RunOpts`
  (default = today's behavior) set false by the adapter. Do not suppress it by
  rewriting the hint downstream, which still writes the file.

**`_offset` is adapter-side.** It does not exist in the codebase and `RunFlags`
does not gain it: the adapter slices the surfaced rows after `runCommand` returns.
`_limit` is likewise applied by the adapter over rows, so it composes with
`output.sort` deterministically (sort happens inside `runCommand`, before
slicing). An out-of-range _offset returns an empty page plus the notice, not an
error.

**Other per-call disk writes exist** and are not spills but must be understood as
concurrent-server behaviour: the identity cache (`identity.ts`, on a cold
`whoami`/`@me`) and the secrets file on renewal. Both use `${path}.${process.pid}.tmp`
temp files, which are unique per *process*, not per call, so two concurrent calls
collide and one error handler removes the other's temp file. Serialize these
writes in-process (§7).

**Honest limitation:** `_limit`/`_offset` are applied after the fetch. Paging
reduces context cost, not network cost. Not real pagination.

### 7. Process lifetime

Every assumption below is safe for a one-shot CLI and wrong for a server.

**No browser launch from a tool call (enforced).** `createCaller` auto-calls
`renew()` on any 401 read, and `renew()` falls through to `reauthViaProfile`,
which launches Chrome (preferring `chromium.launch({ storageState })` when a
storage-state file exists), polls up to 45s and rewrites secrets. MCP mode must
**disable the browser tier** via an explicit option: attempt the non-interactive
OIDC refresh if available, otherwise return §8's error.

**One scheduler per server process, with the response cache disabled or TTL'd.**
*(Correction: rev 2 said "per tool call". That fixes the cache and silently
deletes the rate limiter.)* `createScheduler` also owns request serialisation and
the 400-1300 ms human-shaped delay, with a `first` flag that skips the delay for
the first request only; a per-call scheduler makes every call `first`, giving zero
inter-call pacing and unbounded parallelism across concurrent tools. That is
precisely the detection risk "First target" warns about. So: keep one scheduler
for the process (pacing and serialisation preserved) and add a cache-control
option, since the cache is a URL-keyed `Map` evicted only on non-2xx and would
otherwise return the first response forever and grow unbounded.

**Credentials re-read per call.** `createCaller` captures `initialSecret` in a
closure; the CLI re-reads only because each invocation is a new process. Read
secrets at the start of each tool call, or §8's remediation is a lie.

**Single-flight renewal and serialized secret writes.** Two concurrent 401s would
both enter `renew()` and race two `writeSecret` calls (and the pid-scoped temp
files of §6). Disabling the browser tier removes the Chrome half; guard the OIDC
path and the secret/identity writes with an in-process promise guard. Do **not**
add `lock.ts` to `RUNTIME_FILES` for this.

### 8. Errors

- 401 with no non-interactive renewal: state the session expired and `<site>
  login` must run **on the host machine**. Because secrets are re-read per call
  (§7), say accurately that the next call picks up the new credential; do not tell
  the operator to restart if that is not required.
- HTTP errors: status plus a redacted body head, **no spill file, no host path**.
- Credentials never appear in a result. Note that today every rendered string also
  passes through the text-level `redactAll` in addition to `maskSecretValues`;
  the adapter must apply **both** to its rendered output, at the point of
  serialisation.

## Security model

**DNS-rebinding protection is OFF by default.** *(Correction: rev 1 asserted the
opposite three times.)* On 1.29.0 `enableDnsRebindingProtection` defaults to
`false` and is inert unless `allowedHosts`/`allowedOrigins` are populated;
auto-enablement exists only in a helper this design does not use, and the options
are marked `@deprecated` in favour of the shipped
`server/middleware/hostHeaderValidation` middleware. Enable it explicitly, or use
that middleware, and populate the lists.

**Rebinding allowlists and the tunnel are in tension, and the resolution is
explicit.** `validateRequestHeaders` does exact-string matching on `Host`/`Origin`.
A request through `cloudflared` carries the **public tunnel hostname**, so an
allowlist of `127.0.0.1:<port>` rejects every remote call, while adding the tunnel
hostname re-admits the name being protected. Resolution: the allowlist contains
loopback **plus** the operator's own tunnel hostname when tunnelling, and the
**bearer token, not the allowlist, is the authentication** for remote calls.
Rebinding protection defends the local-browser case; it was never an auth
mechanism. Document both lists explicitly rather than implying one covers the other.

**The listener is fail-closed, and the token is never printed.** *(Correction: rev
2 said "generated and printed on first run" while also refusing to start without
it, which is self-contradictory and would echo a secret, against the repo's
never-echo-secrets posture and its existing leak tests.)* `--http` **requires**
`RKT_MCP_TOKEN` in the environment and **refuses to start without it**; it is
never generated, never printed, and never included in an error message. Document
generating one out-of-band. Compare with a constant-time comparison. This matters
because `cloudflared tunnel --url` yields a **public** hostname with no Access in
front by default, so "Access is the gate" is an ops promise the code cannot keep
alone.

**Prompt injection is an accepted, documented risk.** Every read tool returns
attacker-influenceable text from the target site: event descriptions, bios,
comments, and on the phase-2 Instagram target, DMs. That text lands verbatim in
the agent's context beside its other tools. Read-only scope bounds what *this*
server can be made to do, not what the agent's other tools can. v1 mitigations are
limited and honest: read-only tools, a curated surface, `redact`, and a `SKILL.md`
warning that tool output is untrusted content. Claim no more.

**Startup failures are only as visible as stderr.** §2 moves the skipped-write
count onto the protocol precisely because stdio clients discard stderr, but the
fail-loud paths (tool-name validation, `assertResolvable`, missing token) have no
protocol channel: the process exits before a session exists. Accept this, exit
non-zero with a precise stderr message, and document that a client showing
"server failed to start" means running the entrypoint manually to read it.

**Credential custody is unchanged**, which is the point: secrets stay on the
operator's machine and the browser tier keeps working *for the CLI*, where a human
is present. **`whoami` is exposed deliberately.**

### Why writes wait

Full mode's gate is dry-run-by-default plus explicit `--commit`, designed around
the agent having no TTY. Under MCP that inverts: the agent is the caller, so
`commit: true` is one token away. Build mode, env flag and curation survive; the
deliberate human second act does not. The replacement is
`annotations.destructiveHint`, consumed by MCP *clients* to prompt the human, but
its quality depends entirely on each client's UI. Reads first.

## Testing

- **Result surfacing:** the new `RunResult` field carries extracted, joined,
  sorted, masked, redacted rows; CLI table and `--json` output are **byte-identical**
  except the one intended change below.
- **Redaction fix:** a declared `redact` on an **enveloped** response is honored in
  `--json` mode (the bug); a root-level redact and a no-redact command are
  unchanged; output shape is unchanged.
- **Registration:** expected tool count and names; `readOnlyHint: true`; `whoami`
  only with an identity block; a malformed or colliding tool name fails loudly.
- **Fail-closed curation:** a `commands.json` whose command targets a POST endpoint
  without `write: true` **fails startup** with a clear message.
- **Schema:** `@arg:` exposed and required; `@me`, `@today`, `@today+14d` hidden;
  `@@x` treated as a literal; a `call.params` key with no `ParamSpec` is **not**
  exposed; `_limit`/`_offset` present.
- **Token injection:** an agent-supplied param value of `@me` is sent as the
  literal string `@me`, not resolved to the operator's identity.
- **Overflow:** truncation notice; `_offset` pages; out-of-range _offset yields an
  empty page; no spill file and no host path in any result or error.
- **Process lifetime:** two identical successive tool calls hit the network twice;
  inter-call pacing is preserved (scheduler is not per-call); a tool call after the
  secrets file changes uses the new secret; a 401 never launches a browser.
- **Transport/security:** HTTP refuses to start without `RKT_MCP_TOKEN`; the token
  never appears in output or errors; rebinding protection is enabled with populated
  allowlists.
- **stdout hygiene:** no module on the MCP path writes to stdout (scoped to modules
  MCP loads, since `session.ts` legitimately does).
- **Integration:** `InMemoryTransport.createLinkedPair()` drives `tools/list` and
  `tools/call` against a stubbed caller.
- **Packaging (the scan predicate):** closure probe passes with an MCP and a
  non-MCP client present, **and after regenerating the non-MCP one** (the scan
  must keep the SDK); a root with no MCP client has neither the dependency nor
  `lib/mcp-server.ts`; the first `--mcp` run installs the dependency despite
  `mcp.ts` not existing when the scan runs (ordering); removing `<site>/mcp.ts`
  and regenerating **deletes** `lib/mcp-server.ts` and drops the dependency, and
  the probe still passes; no file other than `lib/mcp-server.ts` is ever deleted.
- **Install ordering:** the probe passes after a regenerate that precedes
  `bun install`.
- **Generation guard:** `--mcp` on a client with no `commands.json` fails at
  generation time.

## Requirement → design map

| Requirement | Where |
|---|---|
| MCP is generation-time; derivation untouched | §1 |
| `--mcp` survives regeneration; fails without curation | §1 |
| Curated tools only, conditional `whoami` | §2, §4 |
| Bad curation fails startup; registration filter is structural | §2 |
| Correct `validateManifest` import; stdout stays clean | §2 |
| Agent cannot inject `@me` or other tokens | §4 |
| No ghost arguments | §4 |
| Curation applies without refactoring rendering | §5 |
| `--json` redaction bug fixed, scoped | §5 |
| Agent-actionable overflow; no disk spill | §6 |
| No browser launch; pacing preserved; no stale cache or secret | §7 |
| Concurrent writes serialized | §6, §7 |
| Auth errors accurate | §8 |
| Rebinding protection on; allowlist/tunnel tension resolved | Security |
| Remote path fail-closed; token never printed | Security |
| Prompt injection acknowledged, not overclaimed | Security |
| Shared-root packaging holds, including install ordering | §3 |
| Non-MCP roots stay lean; MCP off is a clean two-step | §3 predicate + delete |
| Dependency cost stated accurately | SDK version |
| Writes excluded and justified | Non-goals, Why writes wait |

## First target

**luma proves the mechanism.** REST-ish JSON, identity resolves, low stakes. *(Its
`whoami` was verified live in an earlier session; that is session evidence, not
reproducible from the repo. `[uncertain]`)*

**Instagram is phase 2**, harder for reasons unrelated to MCP:

1. **Endpoint collapse.** Its web surface is largely `POST /graphql/query` with
   rotating `doc_id`s. `synthesize.ts` groups by method + origin + path shape, so
   many operations collapse into one endpoint with an opaque body. Per-operation
   tools need a *derivation*-side answer, not an adapter-side one.
2. **Detection.** Agent-driven call patterns look nothing like occasional human CLI
   use, and the failure mode is a checkpoint on a personal account. Operator's
   call, but a real cost, and the reason to arrive with a proven mechanism. Note
   §7's scheduler decision is load-bearing here.

## Deferred / future work

- Write tools under `destructiveHint`, once read mode is proven.
- A remotely hosted server (credential custody, browserless renewal). Re-evaluate
  FastMCP there: if that model uses in-server OAuth rather than an Access front
  door, its auth becomes relevant.
- Unifying the two `redact` implementations (column-name equality vs dotted path).
  Deliberately not attempted here; it is a real inconsistency but changing it is a
  behaviour change to the CLI that deserves its own spec.
- Server-side pagination, if a target exposes real cursors.
- Operation-aware grouping in `synthesize.ts` for GraphQL-style APIs (the
  Instagram blocker).
- MCP resources and prompts. Tools only for now.
