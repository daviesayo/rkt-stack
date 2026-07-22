# derive-client: heuristic navigation for generated clients

Date: 2026-07-22
Status: draft
Scope: `plugins/rkt/skills/derive-client/scripts/src/lib/codegen.ts`, the shared
runtime under `scripts/src/lib/` that generated clients import, and the
generated `cli.ts` output. No changes to record/derive/scaffold flows or to the
SKILL.md workflow steps.

## Problem

Generated clients are CLIs consumed primarily by agents. Today they assume a
human reader: help is one flat dump, most errors print a message and exit 1
with no recovery path, output has no success/cost metadata, and large JSON
responses stream fully into the caller's context. Agents using these clients
thrash: they retry blindly on failure, re-dump help, and blow context on big
list responses.

Design source: the "heuristic navigation" principles from a Manus backend
lead's post (progressive help disclosure, errors as navigation, consistent
output metadata, overflow handling). Applied here to the generated CLI runtime
only.

## Goals

1. An agent can discover any command's exact usage in at most two cheap calls.
2. Every failure message states what went wrong and what to do next.
3. Every invocation reports exit status, duration, and result size uniformly.
4. No invocation can put an unbounded payload into the caller's context by
   default, and no unredacted data is written to disk by default.

Non-goals: collapsing the client into a single `run()` tool; per-client
AGENTS.md docs; changes to recording, deriving, credential handling, or the
`commands.json` schema.

## Design

### 1. Progressive help (three levels)

- **Level 0** — `cli.ts` with no args or `help`: the existing command list,
  with each task line carrying its `summary` from `commands.json` (already in
  the manifest, currently unused in help). Session commands unchanged.
- **Level 1** — `cli.ts <task> --help` (new): for that command only — required
  and optional params with defaults and `@`-token support (`@me`, `@today`,
  `@today±<n><d|w|m|y>`), output columns (table mode), global flags, and one
  runnable example line synthesized at generation time from the recorded param
  example with values redacted.
- **Level 2** — invocation missing a required param: print
  `missing required param: --<name>` followed by that command's Level 1 help,
  exit code 2. Never the flat global dump.

All help text is emitted by codegen at regenerate time; no runtime lookups.

### 2. Errors as navigation

A single runtime helper enforces the property:

```ts
function fail(message: string, hint: string, code?: number): never
```

`hint` is a required argument; every generated and runtime error site routes
through `fail()`. Specific mappings:

- Unknown command → nearest-match suggestion (Levenshtein or prefix match)
  plus the Level 0 command list. Exit 2.
- 401/403 after all refresh tiers exhausted → hint `run: <cli> login` and
  `check: <cli> auth status`. Exit 4.
- Other HTTP 4xx/5xx → status line, first 2000 chars of the redacted body,
  and the path to the full spilled (redacted) body on disk. Exit 1.
- Endpoint missing from `client.json` (drift) → existing message, routed
  through `fail()` with hint `regenerate this client (regenerate.sh)`. Exit 1.
- `--full`/`--raw`/param misuse → the relevant Level 1 help. Exit 2.

### 3. Metadata footer

After every command, one line on **stderr**:

```
[exit:0 | 1.4s | 132 rows | full: ~/.rkt-clients/out/<site>/<ts>.json]
```

- `rows` appears when the result is an array; `bytes` otherwise.
- `full:` appears only when a spill file was written (see §4).
- stdout remains pure response data; `--json | jq .` pipelines are unchanged.
- Exit codes: 0 success, 1 runtime/HTTP error, 2 usage error, 4 auth failure.

### 4. Overflow mode

- Default caps on stdout in both table and `--json` mode: 200 rows or 50 KB,
  whichever is hit first.
- When capped, the full payload is written to
  `~/.rkt-clients/out/<site>/<timestamp>-<command>.json` and the footer carries
  the path. A hint line (stderr) suggests: narrow with `--limit` or a declared
  `--<param>`, or query the spill file with `jq`.
- Spilled payloads are redacted exactly as stdout would be; only `--raw`
  produces an unredacted spill, mirroring the existing stdout contract.
  Spill files are written mode 0600.
- New global flag `--full` disables the cap (complete payload to stdout, no
  spill) for scripted pipelines.
- `--limit <n>` keeps its meaning; when the result fits within caps no spill
  file is written.
- Hygiene: after writing a spill, prune to the newest 20 files per site
  directory.

### 5. Placement

- `fail()`, footer emission, overflow/spill, and prune live in the shared
  runtime (`$OUT/lib/`, sourced from `scripts/src/lib/`), so all clients
  update on regenerate.
- Help-text synthesis (Levels 0–2, examples) lives in `codegen.ts`.
- Both generated CLI variants (endpoint CLI and task CLI) get all four
  behaviors.

## Testing

Extend the existing `tests/test-*.sh` harness with a fixture manifest +
commands.json:

1. Level 1 help renders params, columns, and a redacted example.
2. Missing required param → Level 1 help + exit 2.
3. Unknown command → suggestion + exit 2.
4. Footer format on success and on failure (stderr, stdout untouched).
5. Oversized fixture response → truncated stdout, spill file exists, spill is
   redacted, footer carries the path; `--full` emits everything and no spill.
6. `--json` output under the cap still parses with `jq .` and byte-matches
   today's output (backward compatibility).
7. Prune keeps 20 newest spill files.

## Compatibility

- stdout for in-cap responses is byte-identical to today.
- New stderr footer may surprise scripts that treat any stderr as fatal; none
  of ours do, and exit codes remain authoritative.
- Exit code 2/4 introduction is a behavior change from blanket exit 1;
  documented in CHANGELOG under Unreleased.

## Requirement → design map

| Goal | Section |
|---|---|
| Two-call discovery | §1 |
| Errors carry next step | §2 |
| Uniform metadata | §3 |
| Bounded context, redacted disk | §4 |
| All clients benefit on regenerate | §5 |
