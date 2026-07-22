# derive-client: heuristic navigation for generated clients

Date: 2026-07-22
Status: implemented
Scope: `plugins/rkt/skills/derive-client/scripts/src/lib/codegen.ts`, the shared
runtime under `scripts/src/lib/` that generated clients import, and the
generated `cli.ts` output. No changes to record/derive/scaffold flows, to the
`commands.json` or manifest schemas, or to the SKILL.md workflow steps.

## Problem

Generated clients are CLIs consumed primarily by agents. Today they assume a
human reader: per-command help does not exist, most errors print a message and
exit 1 with no recovery path, output has no success/cost metadata, and large
JSON responses stream fully into the caller's context. Agents using these
clients thrash: they retry blindly on failure, re-dump help, and blow context
on big list responses.

Design source: the "heuristic navigation" principles from a Manus backend
lead's post (progressive help disclosure, errors as navigation, consistent
output metadata, overflow handling). Applied here to the generated CLI runtime
only.

## Two CLI variants, two feature tiers

Codegen emits two variants with very different plumbing, and they get
different tiers of this design:

- **Task CLI** (`emitTaskCli`, exists when `commands.json` is present): parses
  responses, renders tables via `render.ts`, supports `--json`/`--raw`/
  `--limit`, resolves `@` tokens. Gets **all four behaviors** (help levels,
  navigational errors, footer with row counts, row+byte overflow).
- **Endpoint CLI** (`emitEndpointCli`, the pre-`commands.json` fallback):
  prints the redacted response body as a raw string, no parsing, no global
  flags. Gets a **reduced tier**: navigational errors, footer with
  `bytes` (never `rows`), and byte-based overflow (50 KB) spilling the raw
  redacted body. It does not gain `--json`/`--limit`/token help; its Level 1
  help shows the endpoint's method, path template, and params only.

Where a section below says "task CLI only", the endpoint CLI is deliberately
excluded.

## Goals

1. An agent can discover any command's exact usage in at most two cheap calls.
2. Every failure message states what went wrong and what to do next.
3. Every invocation reports exit status, duration, and result size uniformly.
4. No invocation can put an unbounded payload into the caller's context by
   default, and no unredacted data is written to disk by default.

Non-goals: collapsing the client into a single `run()` tool; per-client
AGENTS.md docs; changes to recording, deriving, credential handling, or the
`commands.json` / manifest schemas.

## Design

### 1. Progressive help (three levels)

- **Level 0** — `cli.ts` with no args or `help`: the existing command list.
  The task CLI already prints each task's `summary` (from `commands.json`)
  here; no change beyond adding one trailing line pointing at Level 1:
  `run: <cli> <command> --help for params and an example`. The endpoint CLI
  list (method + path per endpoint) likewise gains only that pointer line.
- **Level 1** — `cli.ts <task> --help` (new): for that command only.
  - Task CLI: required and optional params with declared defaults from
    `call.params`, which params are overridable, `@`-token support (`@me`,
    `@today`, `@today±<n><d|w|m|y>`), output columns (table mode), global
    flags, and one runnable example line synthesized at generation time from
    the declared params with values redacted.
  - Endpoint CLI: method, path template, path/query params with recorded
    example values redacted, and one runnable example line.
- **Level 2** — invocation with a missing **required path param** (the only
  class of param that is required today; task-CLI declared params are
  pre-populated from `commands.json` and query params are optional): print
  `missing required param: --<name>` followed by that command's Level 1 help,
  exit code 2. Never the flat global dump. This adds up-front validation in
  the generated CLI argument layer; `buildRequest`'s existing throw remains
  the backstop.

All help text is emitted by codegen at regenerate time; no runtime lookups.

### 2. Errors as navigation

Two pieces, respecting the existing throw-based library contract (library
functions like `runCommand` and `createCaller` throw and are unit-tested via
`expect(...).toThrow`; they must keep throwing, not exit):

- **`CliError`** (shared runtime): `class CliError extends Error { exitCode:
  number; hint: string }`. Library error sites that today throw bare `Error`
  with a known recovery path migrate to `CliError`; unknown failures keep
  throwing plain `Error`.
- **`fail(message, hint, exitCode)`** (generated CLI layer only): prints
  `message`, then `hint: <hint>`, to stderr and exits. The generated CLI's
  top-level catch maps `CliError` → `fail(e.message, e.hint, e.exitCode)` and
  plain `Error` → exit 1 with a generic "re-run with --dry-run to inspect the
  request" hint. Argument-parsing errors call `fail` directly.

Specific mappings:

- Unknown command → nearest-match suggestion (prefix match, else minimum
  edit distance over command names) plus the Level 0 command list. Exit 2.
- 401 after all renewal tiers exhausted (stored credential → OIDC refresh →
  headless browser re-auth) → hint `run: <cli> login` and
  `check: <cli> auth status`. Exit 4.
- 403 → **no renewal is attempted today (renewal triggers on 401 only) and
  that stays true**: exit 1 with hint "the session may lack permission for
  this resource; if the whole client fails, try: <cli> login".
- Other HTTP 4xx/5xx → status line, first 2000 chars of the redacted body,
  and the path to the full spilled redacted body on disk. Exit 1.
- Endpoint missing from `client.json` (drift) → existing message, with hint
  `regenerate this client: bash <site>/regenerate.sh`. Exit 1.
- Flag/param misuse → the relevant Level 1 help. Exit 2.

### 3. Metadata footer

After every command, one line on **stderr**:

```
[exit:0 | 1.4s | 132 rows | full: ~/.rkt-clients/out/<site>/<ts>-<command>.json]
```

- Task CLI: `N rows` when the shaped result is an array, else `N bytes`.
  Endpoint CLI: always `N bytes` (it never parses).
- `full:` appears only when a spill file was written (§4).
- stdout remains pure response data; `--json | jq .` pipelines are unchanged.
- Exit codes: 0 success, 1 runtime/HTTP error, 2 usage error, 4 auth failure
  (exhausted 401 renewal).

### 4. Overflow mode

- Default caps on stdout: task CLI 200 rows or 50 KB (whichever first, both
  table and `--json` mode); endpoint CLI 50 KB.
- When capped, the full payload is written to
  `~/.rkt-clients/out/<site>/<timestamp>-<command>.json`, mode 0600, and the
  footer carries the path. A stderr hint line suggests: narrow with `--limit`
  or a declared `--<param>`, or query the spill file with `jq`.
- **What spills:** the same logical data stdout is showing, in JSON form. For
  task-CLI table commands that is the shaped rows (post-extraction, post-join,
  post-sort, post-redaction) as JSON. For `--json` mode, the rendered JSON
  itself (which serializes the whole parsed response, not extracted rows — so
  table-mode and json-mode spills legitimately differ for commands with
  `output.rows` or joins). For the endpoint CLI, the raw redacted body text.
  With `--raw`, the spill is unredacted like stdout; that is the only path to
  an unredacted file on disk, mirroring the existing stdout contract.
- New global flag `--full` (task CLI only) disables the cap: complete payload
  to stdout, no spill.
- `--limit <n>` keeps its meaning; when the result fits within caps, no spill
  file is written.
- Hygiene: after writing a spill, prune the site's out-dir to the newest 20
  files. Best-effort: ignore ENOENT races from concurrent invocations.

### 5. Placement and contracts

- `CliError`, footer formatting, overflow decision + spill + prune live in
  the shared runtime (`$OUT/lib/`, sourced from `scripts/src/lib/`), so all
  clients update on regenerate.
- `paths.ts` gains an `outDir(site)` helper under `rktRoot()`, so the
  existing root-confinement check (`assertUnderRktRoot`) covers spill files
  and the `RKT_CLIENTS_ROOT` test redirect applies.
- **`runCommand` return contract changes** from `string` to a structured
  result, e.g. `{ rendered: string; rowCount?: number; fullPayload: unknown }`.
  Capping and spilling happen in a small wrapper around it in the shared
  runtime, not inside `render.ts` (rendering stays pure). The generated task
  CLI consumes the structured result; existing unit tests update to match.
- Help-text synthesis (Levels 0–2, examples, nearest-match tables) lives in
  `codegen.ts`.
- `fail()` is emitted into the generated CLI by codegen (it terminates the
  process, so it must not live in unit-tested library code).

## Testing

Behavioral tests go in the **bun test suite** (`scripts/tests/*.test.ts`),
which sets `NODE_ENV=test` + `RKT_CLIENTS_ROOT` so `rktRoot()` redirects to a
temp dir — generated-CLI subprocess runs must be launched from within bun
tests with those env vars exported, never from the bash harness (which is a
structural grep checker and must stay that way; running the CLI from bash
would write spill files into the developer's real `~/.rkt-clients/`).

Fixture: a manifest + commands.json pair and a local stub HTTP server.

1. Level 1 help renders params, columns, and a redacted example (both
   variants).
2. Missing required path param → Level 1 help + exit 2.
3. Unknown command → suggestion + exit 2.
4. Footer format on success and on failure (stderr only; stdout untouched).
5. Oversized fixture response → truncated stdout, spill file exists under the
   redirected root, spill content is the shaped rows as JSON (table mode) or
   the rendered JSON (json mode), spill is redacted, footer carries the path;
   `--full` emits everything and writes no spill.
6. `--json` output under the cap still parses with `jq .` and byte-matches
   today's output (backward compatibility).
7. Prune keeps the 20 newest spill files.
8. Existing `runtime.test.ts` / `command-runner.test.ts` updated for
   `CliError` and the structured `runCommand` result; throw-based assertions
   keep working.

## Compatibility

- stdout for in-cap responses is byte-identical to today (task CLI table and
  `--json`; endpoint CLI raw body).
- New stderr footer may surprise scripts that treat any stderr as fatal; none
  of ours do, and exit codes remain authoritative.
- Exit codes 2 and 4 are new (previously blanket 1); 403 keeps exit 1.
  Documented in `plugins/rkt/CHANGELOG.md` under `## [Unreleased]`.
- `runCommand`'s return type change is internal to the plugin + generated
  lib; regeneration updates both sides together, and generated files carry
  the do-not-edit header, so no mixed-version skew within a client.

## Requirement → design map

| Goal | Section |
|---|---|
| Two-call discovery | §1 |
| Errors carry next step | §2 |
| Uniform metadata | §3 |
| Bounded context, redacted disk | §4 |
| All clients benefit on regenerate; test confinement | §5, Testing |
