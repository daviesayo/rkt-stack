# derive-client Command Surface, Plan B1: Resolver Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure library behind task commands: the `commands.json` schema and validator, the param-token resolver (`@me`, `@today±<n><unit>`), identity/`whoami` resolution, the join planner with `onError`, and the drift detector. All unit-tested against fixtures, no codegen, no browser.

**Architecture:** Six focused `lib/` modules, each pure and independently testable. They consume the existing Plan-A runtime (scheduler, transport, render, session) but add no codegen and touch no CLI. Plan B2 emits a CLI that calls these; this plan makes the calls real and correct first.

**Tech Stack:** Bun 1.3.11, TypeScript, `bun test`. No new dependencies.

**Source spec:** `docs/specs/2026-07-21-derive-client-command-surface-design.md`
**Predecessors:** Plan A (scheduler/session/render, merged), plugin 0.6.0.

## What B1 ships, and what it does not

**Ships:** the `commands.json` types + validator, token resolver, identity resolver (the engine behind `whoami`), join planner, drift detector — a tested library. No user-visible command yet.

**Does NOT ship here:** task-command codegen, the two design modes in SKILL.md, the drift report's presentation, the version cut. All B2. B1 makes no change a generated client can run; it is the substrate B2 emits against.

## Global Constraints

Everything from Plan A still applies. Restated because a task implementer sees only their own task:

- Runtime artifacts live under the resolved rkt root only. `RKT_CLIENTS_ROOT` overrides the root **only when `NODE_ENV === "test"`**.
- Read mode issues GET and HEAD only. Joins are GET lookups and must not weaken this.
- Secrets and session state at `0600` in a `0700` dir, never in a repo, never printed. Credential masking is always-on; field redaction is `--raw`-toggled (Plan A's `render.ts`).
- Safety checks key on structure or shape, never on names.
- Tests are idempotent, use temp directories, and clean up. Typecheck (`bunx tsc --noEmit`) must pass; it runs in the wrapper. Cast a fake `fetch` as `unknown as typeof fetch`, never `as typeof fetch` (Bun's `fetch` type requires `preconnect`).
- **No version bump in B1.** Both manifests stay at `0.6.0`; entries accumulate under `## [Unreleased]`. B2's final task cuts `0.7.0`.

All paths are relative to `plugins/rkt/skills/derive-client/scripts/` unless prefixed with `plugins/` or `tests/`.

---

## File Structure

**Created:**
- `src/lib/commands-schema.ts` — `CommandsFile` types + `validateCommandsFile`, mirroring `manifest-schema.ts`.
- `src/lib/tokens.ts` — param-token grammar: parse and resolve `@me`/`@today...`, `@@` escape.
- `src/lib/identity.ts` — resolve the signed-in user's id and display fields; read/write the identity cache.
- `src/lib/join.ts` — plan and execute joins over result rows, with `onError`.
- `src/lib/drift.ts` — compare a `commands.json` against a `client.json`, report broken and new-surface.
- `tests/commands-schema.test.ts`, `tests/tokens.test.ts`, `tests/identity.test.ts`, `tests/join.test.ts`, `tests/drift.test.ts`
- `tests/fixtures/commands.example.json` — a valid fixture used across tests.

**Modified:** none. B1 adds modules; it changes no existing file. (B2 wires them into codegen and the skill.)

---

## Task 1: commands.json schema and validator

**Files:**
- Create: `src/lib/commands-schema.ts`
- Create: `tests/commands-schema.test.ts`
- Create: `tests/fixtures/commands.example.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the types below and `validateCommandsFile(value: unknown): CommandsFile` (throws on invalid, naming the offending field). `SCHEMA_VERSION = 1` for this artifact (distinct from the manifest's version 2).

```ts
export interface IdentitySpec {
  endpoint: string;      // client.json endpoint id, id-free (/me-style)
  idField: string;       // field in the response holding the user's id
  display: string[];     // fields naming the user, for whoami
}
export interface JoinSpec {
  key: string;           // row field holding the reference (must be scalar)
  endpoint: string;      // endpoint id to look up
  select: string[];      // fields to keep from the looked-up response
  as: string;            // attach under this name on the row
  onError: "blank" | "key" | "fail";
}
export interface CommandOutput {
  kind: "table" | "json";
  columns?: string[];    // required when kind === "table"
  sort?: string;
}
export interface CommandSpec {
  name: string;
  summary: string;
  call: { endpoint: string; params?: Record<string, string> };
  join?: JoinSpec[];
  output: CommandOutput;
  redact?: string[];
}
export interface CommandsFile {
  schemaVersion: number;
  site: string;
  identity?: IdentitySpec;
  commands: CommandSpec[];
}
export const COMMANDS_SCHEMA_VERSION = 1;
```

- [ ] **Step 1: Create the fixture**

`tests/fixtures/commands.example.json`:

```json
{
  "schemaVersion": 1,
  "site": "example",
  "identity": { "endpoint": "get.api.v1.employees.me", "idField": "id", "display": ["first_name", "email"] },
  "commands": [
    {
      "name": "shifts",
      "summary": "List your upcoming shifts",
      "call": { "endpoint": "get.scheduling.getShifts", "params": { "start": "@today", "end": "@today+14d" } },
      "join": [
        { "key": "client_id", "endpoint": "get.api.v1.clients.id", "select": ["name"], "as": "client", "onError": "blank" }
      ],
      "output": { "kind": "table", "columns": ["date", "client.name", "address"], "sort": "date" },
      "redact": ["address"]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { COMMANDS_SCHEMA_VERSION, validateCommandsFile } from "../src/lib/commands-schema";

const valid = () => JSON.parse(require("fs").readFileSync(`${import.meta.dir}/fixtures/commands.example.json`, "utf8"));

test("accepts a valid commands file", () => {
  const cf = validateCommandsFile(valid());
  expect(cf.schemaVersion).toBe(COMMANDS_SCHEMA_VERSION);
  expect(cf.commands[0].name).toBe("shifts");
  expect(cf.commands[0].join?.[0].onError).toBe("blank");
});

test("rejects an unsupported schema version, naming the field", () => {
  expect(() => validateCommandsFile({ ...valid(), schemaVersion: 99 })).toThrow(/schemaVersion/i);
});

test("rejects a command with no name", () => {
  const cf = valid(); delete cf.commands[0].name;
  expect(() => validateCommandsFile(cf)).toThrow(/name/i);
});

test("rejects a table output with no columns", () => {
  const cf = valid(); cf.commands[0].output = { kind: "table" };
  expect(() => validateCommandsFile(cf)).toThrow(/columns/i);
});

test("rejects an onError outside the allowed set", () => {
  const cf = valid(); cf.commands[0].join[0].onError = "explode";
  expect(() => validateCommandsFile(cf)).toThrow(/onError/i);
});

test("defaults onError to blank when omitted", () => {
  const cf = valid(); delete cf.commands[0].join[0].onError;
  expect(validateCommandsFile(cf).commands[0].join?.[0].onError).toBe("blank");
});

test("rejects a non-array commands field", () => {
  expect(() => validateCommandsFile({ schemaVersion: 1, site: "x", commands: {} })).toThrow(/commands/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/commands-schema.test.ts`
Expected: FAIL at module resolution for `../src/lib/commands-schema`.

- [ ] **Step 4: Implement the validator**

```ts
export const COMMANDS_SCHEMA_VERSION = 1;

// ... (the interfaces above) ...

function fail(field: string, why: string): never {
  throw new Error(`commands.json: ${field} ${why}`);
}

function validateJoin(j: unknown, cmd: string): JoinSpec {
  const o = j as Partial<JoinSpec>;
  if (typeof o?.key !== "string") fail(`${cmd}.join[].key`, "must be a string");
  if (typeof o.endpoint !== "string") fail(`${cmd}.join[].endpoint`, "must be a string");
  if (!Array.isArray(o.select)) fail(`${cmd}.join[].select`, "must be an array");
  if (typeof o.as !== "string") fail(`${cmd}.join[].as`, "must be a string");
  const onError = o.onError ?? "blank";
  if (!["blank", "key", "fail"].includes(onError)) fail(`${cmd}.join[].onError`, "must be blank, key, or fail");
  return { key: o.key, endpoint: o.endpoint, select: o.select as string[], as: o.as, onError };
}

function validateCommand(c: unknown): CommandSpec {
  const o = c as Partial<CommandSpec>;
  if (typeof o?.name !== "string" || o.name.length === 0) fail("commands[].name", "must be a non-empty string");
  if (typeof o.summary !== "string") fail(`${o.name}.summary`, "must be a string");
  if (typeof o.call?.endpoint !== "string") fail(`${o.name}.call.endpoint`, "must be a string");
  const output = o.output as CommandOutput | undefined;
  if (output?.kind !== "table" && output?.kind !== "json") fail(`${o.name}.output.kind`, "must be table or json");
  if (output.kind === "table" && !Array.isArray(output.columns)) fail(`${o.name}.output.columns`, "required for a table");
  const join = Array.isArray(o.join) ? o.join.map((j) => validateJoin(j, o.name!)) : undefined;
  return {
    name: o.name,
    summary: o.summary,
    call: { endpoint: o.call.endpoint, params: o.call.params ?? {} },
    join,
    output,
    redact: Array.isArray(o.redact) ? (o.redact as string[]) : [],
  };
}

export function validateCommandsFile(value: unknown): CommandsFile {
  const o = value as Partial<CommandsFile>;
  if (typeof o !== "object" || o === null) fail("root", "must be an object");
  if (o.schemaVersion !== COMMANDS_SCHEMA_VERSION) fail("schemaVersion", `must be ${COMMANDS_SCHEMA_VERSION}`);
  if (typeof o.site !== "string") fail("site", "must be a string");
  if (!Array.isArray(o.commands)) fail("commands", "must be an array");
  let identity: IdentitySpec | undefined;
  if (o.identity) {
    const i = o.identity as Partial<IdentitySpec>;
    if (typeof i.endpoint !== "string" || typeof i.idField !== "string" || !Array.isArray(i.display)) {
      fail("identity", "needs endpoint, idField, and display[]");
    }
    identity = { endpoint: i.endpoint, idField: i.idField, display: i.display as string[] };
  }
  return { schemaVersion: o.schemaVersion, site: o.site, identity, commands: o.commands.map(validateCommand) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/commands-schema.test.ts && bunx tsc --noEmit`
Expected: PASS, 7 tests, silent typecheck.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/commands-schema.ts plugins/rkt/skills/derive-client/scripts/tests/commands-schema.test.ts plugins/rkt/skills/derive-client/scripts/tests/fixtures/commands.example.json
git commit -m "feat(derive-client): commands.json schema and validator"
```

---

## Task 2: Param-token resolver

**Files:**
- Create: `src/lib/tokens.ts`
- Create: `tests/tokens.test.ts`

**Interfaces:**
- Consumes: nothing (identity resolution is injected).
- Produces: `resolveToken(value: string, ctx: TokenContext, now: Date): Promise<string>` and `isToken(value: string): boolean`.

```ts
export interface TokenContext {
  /** Resolves @me lazily; throws if no identity is configured. */
  resolveMe: () => Promise<string>;
  /** IANA tz or undefined for local. */
  timezone?: string;
}
```

Rules from the spec, exactly: a value is a token only if it begins with `@`; `@@x` escapes to the literal `@x`; the legal set is `@me` and `@today[±<n><unit>]` where unit ∈ `d|w|m|y` (absent = days); anything else `@`-prefixed is a hard error naming the token. Dates render `YYYY-MM-DD` in the given timezone (or local).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { isToken, resolveToken } from "../src/lib/tokens";

const NOW = new Date("2026-07-21T12:00:00Z");
const ctx = { resolveMe: async () => "924" };

test("isToken is true only for a leading @", () => {
  expect(isToken("@today")).toBe(true);
  expect(isToken("hello")).toBe(false);
  expect(isToken("a@b")).toBe(false);
});

test("a literal passes through unchanged", async () => {
  expect(await resolveToken("2026-W30", ctx, NOW)).toBe("2026-W30");
});

test("@@ escapes to a single leading @", async () => {
  expect(await resolveToken("@@handle", ctx, NOW)).toBe("@handle");
});

test("@me resolves via the context", async () => {
  expect(await resolveToken("@me", ctx, NOW)).toBe("924");
});

test("@today renders the date in UTC", async () => {
  expect(await resolveToken("@today", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-07-21");
});

test("@today+14d adds fourteen days", async () => {
  expect(await resolveToken("@today+14d", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-08-04");
});

test("a bare number means days", async () => {
  expect(await resolveToken("@today+14", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-08-04");
});

test("units w/m/y are supported", async () => {
  expect(await resolveToken("@today-1w", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-07-14");
  expect(await resolveToken("@today+1m", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-08-21");
  expect(await resolveToken("@today+1y", { ...ctx, timezone: "UTC" }, NOW)).toBe("2027-07-21");
});

test("an unknown token is a hard error naming it", async () => {
  await expect(resolveToken("@tomorrow", ctx, NOW)).rejects.toThrow(/@tomorrow/);
  await expect(resolveToken("@today+14x", ctx, NOW)).rejects.toThrow(/@today\+14x/);
});

test("@me with no identity surfaces the resolver's error", async () => {
  const noId = { resolveMe: async () => { throw new Error("no identity configured"); } };
  await expect(resolveToken("@me", noId, NOW)).rejects.toThrow(/identity/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/tokens.test.ts`
Expected: FAIL at module resolution for `../src/lib/tokens`.

- [ ] **Step 3: Implement**

```ts
export interface TokenContext {
  resolveMe: () => Promise<string>;
  timezone?: string;
}

export function isToken(value: string): boolean {
  return value.startsWith("@");
}

const TODAY = /^@today(?:([+-])(\d+)([dwmy]?))?$/;

function formatDate(d: Date, tz?: string): string {
  // en-CA yields YYYY-MM-DD; timeZone applies the offset.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function applyOffset(base: Date, sign: string, n: number, unit: string): Date {
  const d = new Date(base);
  const k = sign === "-" ? -n : n;
  switch (unit || "d") {
    case "d": d.setUTCDate(d.getUTCDate() + k); break;
    case "w": d.setUTCDate(d.getUTCDate() + k * 7); break;
    case "m": d.setUTCMonth(d.getUTCMonth() + k); break;
    case "y": d.setUTCFullYear(d.getUTCFullYear() + k); break;
  }
  return d;
}

export async function resolveToken(value: string, ctx: TokenContext, now: Date): Promise<string> {
  if (!isToken(value)) return value;
  if (value.startsWith("@@")) return value.slice(1); // escape

  if (value === "@me") return ctx.resolveMe();

  const m = TODAY.exec(value);
  if (m) {
    const base = m[1] ? applyOffset(now, m[1], Number(m[2]), m[3]) : now;
    return formatDate(base, ctx.timezone ?? process.env.TZ);
  }

  throw new Error(`unresolvable param token ${value}: not one of @me, @today, @today±<n><d|w|m|y>`);
}
```

Note the month arithmetic uses `setUTCMonth`, so `@today+1m` on Jan 31 lands in early March (JS date rollover) — acceptable and documented; a future refinement can clamp. The tests use mid-month dates that do not trigger rollover.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/tokens.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck. If `@today+1m` differs by a timezone day, confirm `timezone: "UTC"` is set in the test context (it is).

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/tokens.ts plugins/rkt/skills/derive-client/scripts/tests/tokens.test.ts
git commit -m "feat(derive-client): param-token resolver (@me, @today offsets)"
```

---

## Task 3: Identity resolution and cache

**Files:**
- Create: `src/lib/identity.ts`
- Create: `tests/identity.test.ts`

**Interfaces:**
- Consumes: `IdentitySpec` from `commands-schema`, `identityCacheFile` from `lib/session` (Plan A), `getPath` from `lib/render` (Plan A), `readSecrets` from `lib/secrets`.
- Produces:
  - `resolveIdentity(site, identity, fetchEndpoint): Promise<{ id: string; display: Record<string, unknown> }>` — reads the on-disk cache, else calls `fetchEndpoint` against `identity.endpoint`, extracts `idField` and `display`, writes the cache (0600), returns it.
  - `whoamiLine(display: Record<string, unknown>, fields: string[]): string` — formats the `whoami` output.
  - `fetchEndpoint` is `(endpointId: string) => Promise<unknown>` — injected so tests do not hit the network.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIdentity, whoamiLine } from "../src/lib/identity";

let root: string;
const ORIG = process.env.RKT_CLIENTS_ROOT;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rkt-id-"));
  process.env.RKT_CLIENTS_ROOT = root;
  process.env.NODE_ENV = "test";
});
afterEach(async () => {
  if (ORIG === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIG;
  await rm(root, { recursive: true, force: true });
});

const spec = { endpoint: "get.me", idField: "id", display: ["first_name", "email"] };

test("resolves identity from the endpoint and caches it", async () => {
  let calls = 0;
  const fetchEndpoint = async () => { calls++; return { id: 924, first_name: "Ada", email: "ada@x.test" }; };
  const first = await resolveIdentity("s", spec, fetchEndpoint);
  expect(first.id).toBe("924");
  expect(first.display.first_name).toBe("Ada");
  const second = await resolveIdentity("s", spec, fetchEndpoint);
  expect(second.id).toBe("924");
  expect(calls).toBe(1); // served from cache the second time
});

test("whoamiLine formats the display fields", () => {
  expect(whoamiLine({ first_name: "Ada", email: "ada@x.test" }, ["first_name", "email"])).toBe("Ada (ada@x.test)");
});

test("throws a clear error when the id field is absent", async () => {
  const fetchEndpoint = async () => ({ first_name: "Ada" });
  await expect(resolveIdentity("s", spec, fetchEndpoint)).rejects.toThrow(/idField 'id'/i);
});

test("the cache file is written at 0600", async () => {
  const { stat } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  await resolveIdentity("s", spec, async () => ({ id: 1 }));
  const info = await stat(identityCacheFile("s"));
  expect(info.mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/identity.test.ts`
Expected: FAIL at module resolution for `../src/lib/identity`.

- [ ] **Step 3: Implement**

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IdentitySpec } from "./commands-schema";
import { identityCacheFile } from "./session";
import { getPath } from "./render";

interface IdentityCache {
  id: string;
  display: Record<string, unknown>;
}

export type FetchEndpoint = (endpointId: string) => Promise<unknown>;

export async function resolveIdentity(
  site: string,
  spec: IdentitySpec,
  fetchEndpoint: FetchEndpoint,
): Promise<IdentityCache> {
  const path = identityCacheFile(site);
  try {
    return JSON.parse(await readFile(path, "utf8")) as IdentityCache;
  } catch {
    /* not cached */
  }

  const body = await fetchEndpoint(spec.endpoint);
  const idRaw = getPath(body, spec.idField);
  if (idRaw == null) {
    throw new Error(`identity endpoint returned no idField '${spec.idField}'`);
  }
  const display: Record<string, unknown> = {};
  for (const f of spec.display) display[f] = getPath(body, f);
  const cache: IdentityCache = { id: String(idRaw), display };

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
  return cache;
}

export function whoamiLine(display: Record<string, unknown>, fields: string[]): string {
  const parts = fields.map((f) => display[f]).filter((v) => v != null).map(String);
  if (parts.length === 0) return "unknown";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} (${parts.slice(1).join(", ")})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/identity.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/identity.ts plugins/rkt/skills/derive-client/scripts/tests/identity.test.ts
git commit -m "feat(derive-client): identity resolution with on-disk cache"
```

---

## Task 4: Join planner and executor

**Files:**
- Create: `src/lib/join.ts`
- Create: `tests/join.test.ts`

**Interfaces:**
- Consumes: `JoinSpec` from `commands-schema`, `getPath` from `lib/render`.
- Produces: `applyJoins(rows: Record<string, unknown>[], joins: JoinSpec[], lookup: Lookup): Promise<Record<string, unknown>[]>` where `Lookup` is `(endpointId: string, key: string) => Promise<unknown>`. `lookup` is injected (in production it is a scheduler-backed fetch; the scheduler's per-run dedup makes N rows over M targets cost M lookups). Each row is cloned and given `row[as] = { selected fields }`. `onError` governs a failed lookup.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { applyJoins } from "../src/lib/join";

const join = { key: "client_id", endpoint: "get.clients.id", select: ["name"], as: "client", onError: "blank" as const };

test("attaches selected fields from the lookup under `as`", async () => {
  const rows = [{ date: "d1", client_id: 7 }, { date: "d2", client_id: 8 }];
  const lookup = async (_ep: string, key: string) => ({ name: `C${key}`, secret: "x" });
  const out = await applyJoins(rows, [join], lookup);
  expect(out[0].client).toEqual({ name: "C7" }); // only `select` fields kept
  expect(out[1].client).toEqual({ name: "C8" });
});

test("dedups: distinct keys drive distinct lookups", async () => {
  const rows = [{ client_id: 7 }, { client_id: 7 }, { client_id: 8 }];
  const seen: string[] = [];
  const lookup = async (_ep: string, key: string) => { seen.push(key); return { name: key }; };
  await applyJoins(rows, [join], lookup);
  expect(seen.sort()).toEqual(["7", "8"]); // 7 looked up once despite two rows
});

test("rejects an array-valued key rather than mis-joining", async () => {
  const rows = [{ client_id: [1, 2] }];
  await expect(applyJoins(rows, [join], async () => ({}))).rejects.toThrow(/array-valued/i);
});

test("onError blank leaves the attachment empty", async () => {
  const rows = [{ client_id: 7 }];
  const lookup = async () => { throw new Error("404"); };
  const out = await applyJoins(rows, [join], lookup);
  expect(out[0].client).toEqual({});
});

test("onError key falls back to the raw key value", async () => {
  const rows = [{ client_id: 7 }];
  const j = { ...join, onError: "key" as const };
  const out = await applyJoins(rows, [j], async () => { throw new Error("404"); });
  expect(out[0].client).toBe("7");
});

test("onError fail aborts the whole command", async () => {
  const rows = [{ client_id: 7 }];
  const j = { ...join, onError: "fail" as const };
  await expect(applyJoins(rows, [j], async () => { throw new Error("404"); })).rejects.toThrow(/404|join/i);
});

test("a missing key resolves to blank without a lookup", async () => {
  const rows = [{ date: "d1" }];
  let called = false;
  const lookup = async () => { called = true; return {}; };
  const out = await applyJoins(rows, [join], lookup);
  expect(out[0].client).toEqual({});
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/join.test.ts`
Expected: FAIL at module resolution for `../src/lib/join`.

- [ ] **Step 3: Implement**

```ts
import type { JoinSpec } from "./commands-schema";
import { getPath } from "./render";

export type Lookup = (endpointId: string, key: string) => Promise<unknown>;

async function resolveOne(
  keyValue: string,
  join: JoinSpec,
  lookup: Lookup,
  cache: Map<string, Promise<unknown>>,
): Promise<unknown> {
  let p = cache.get(keyValue);
  if (!p) {
    p = lookup(join.endpoint, keyValue);
    cache.set(keyValue, p);
  }
  const body = await p;
  const picked: Record<string, unknown> = {};
  for (const f of join.select) picked[f] = getPath(body, f);
  return picked;
}

export async function applyJoins(
  rows: Record<string, unknown>[],
  joins: JoinSpec[],
  lookup: Lookup,
): Promise<Record<string, unknown>[]> {
  const out = rows.map((r) => ({ ...r }));
  for (const join of joins) {
    // One cache per join so distinct keys => distinct lookups, repeats shared.
    const cache = new Map<string, Promise<unknown>>();
    for (const row of out) {
      const raw = getPath(row, join.key);
      if (raw == null) {
        row[join.as] = join.onError === "key" ? "" : {};
        continue;
      }
      if (Array.isArray(raw)) {
        throw new Error(`join key '${join.key}' is array-valued; joins need a scalar reference`);
      }
      const keyValue = String(raw);
      try {
        row[join.as] = await resolveOne(keyValue, join, lookup, cache);
      } catch (err) {
        if (join.onError === "fail") throw err;
        row[join.as] = join.onError === "key" ? keyValue : {};
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/join.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/join.ts plugins/rkt/skills/derive-client/scripts/tests/join.test.ts
git commit -m "feat(derive-client): join planner with dedup and onError"
```

---

## Task 5: Drift detector

**Files:**
- Create: `src/lib/drift.ts`
- Create: `tests/drift.test.ts`

**Interfaces:**
- Consumes: `CommandsFile` from `commands-schema`, `ClientManifest` from `manifest-schema`.
- Produces: `detectDrift(commands: CommandsFile, manifest: ClientManifest): DriftReport` where

```ts
export interface DriftReport {
  broken: { command: string; endpoint: string }[];   // command references an endpoint no longer in the manifest
  newSurface: string[];                                // manifest endpoint ids referenced by no command
}
```

Pure comparison. A command's referenced endpoints are its `call.endpoint`, every `join[].endpoint`, and `identity.endpoint`. This backs B2's re-derive drift report; here it is a tested function.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { detectDrift } from "../src/lib/drift";

const manifest = (ids: string[]) => ({
  schemaVersion: 2, site: "x", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
  userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null,
  endpoints: ids.map((id) => ({ id, method: "GET", pathTemplate: "/" + id, params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null })),
});

const commands = (calls: string[]) => ({
  schemaVersion: 1, site: "x",
  commands: calls.map((ep, i) => ({ name: `c${i}`, summary: "", call: { endpoint: ep, params: {} }, output: { kind: "json" as const }, redact: [] })),
});

test("flags a command whose endpoint vanished", () => {
  const d = detectDrift(commands(["get.gone"]), manifest(["get.here"]));
  expect(d.broken).toEqual([{ command: "c0", endpoint: "get.gone" }]);
});

test("flags manifest endpoints no command references", () => {
  const d = detectDrift(commands(["get.used"]), manifest(["get.used", "get.new"]));
  expect(d.newSurface).toEqual(["get.new"]);
});

test("counts join and identity endpoints as referenced", () => {
  const cf = {
    schemaVersion: 1, site: "x",
    identity: { endpoint: "get.me", idField: "id", display: [] },
    commands: [{
      name: "c", summary: "",
      call: { endpoint: "get.a", params: {} },
      join: [{ key: "k", endpoint: "get.b", select: [], as: "j", onError: "blank" as const }],
      output: { kind: "json" as const }, redact: [],
    }],
  };
  const d = detectDrift(cf, manifest(["get.a", "get.b", "get.me"]));
  expect(d.broken).toEqual([]);
  expect(d.newSurface).toEqual([]);
});

test("a clean match reports no drift", () => {
  const d = detectDrift(commands(["get.a"]), manifest(["get.a"]));
  expect(d.broken).toEqual([]);
  expect(d.newSurface).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/drift.test.ts`
Expected: FAIL at module resolution for `../src/lib/drift`.

- [ ] **Step 3: Implement**

```ts
import type { CommandsFile } from "./commands-schema";
import type { ClientManifest } from "./manifest-schema";

export interface DriftReport {
  broken: { command: string; endpoint: string }[];
  newSurface: string[];
}

export function detectDrift(commands: CommandsFile, manifest: ClientManifest): DriftReport {
  const have = new Set(manifest.endpoints.map((e) => e.id));
  const referenced = new Set<string>();
  const broken: DriftReport["broken"] = [];

  const note = (command: string, endpoint: string) => {
    referenced.add(endpoint);
    if (!have.has(endpoint)) broken.push({ command, endpoint });
  };

  if (commands.identity) note("identity", commands.identity.endpoint);
  for (const c of commands.commands) {
    note(c.name, c.call.endpoint);
    for (const j of c.join ?? []) note(c.name, j.endpoint);
  }

  const newSurface = manifest.endpoints.map((e) => e.id).filter((id) => !referenced.has(id));
  return { broken, newSurface };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/drift.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/drift.ts plugins/rkt/skills/derive-client/scripts/tests/drift.test.ts
git commit -m "feat(derive-client): drift detector for commands vs manifest"
```

---

## Task 6: Full gate and CHANGELOG

**Files:**
- Modify: `plugins/rkt/CHANGELOG.md`

- [ ] **Step 1: Run the full repo gate**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
(cd plugins/rkt/skills/derive-client/scripts && bun test && bunx tsc --noEmit)
LANG=en_US.UTF-8 bash -c 'for t in tests/test-*.sh; do bash "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"; done'
claude plugin validate plugins/rkt
```

Expected: all unit tests pass, silent typecheck, all 12 wrapper tests OK, validation passes. Run from the main checkout, not a worktree.

- [ ] **Step 2: Add CHANGELOG entries under [Unreleased]**

Under the existing `## [Unreleased]` heading (no version; B2 releases):

```markdown
### Added

- Command-surface resolver core (internal, not yet surfaced in a CLI): a
  `commands.json` schema and validator, a param-token resolver (`@me`,
  `@today` with `±<n><d|w|m|y>` offsets and an `@@` escape), identity
  resolution with an on-disk cache, a join planner that dedups lookups and
  honours a per-command `onError` policy, and a drift detector comparing a
  `commands.json` against a re-derived `client.json`.
```

- [ ] **Step 3: Commit**

```bash
git add plugins/rkt/CHANGELOG.md
git commit -m "docs(derive-client): changelog for the resolver core"
```

---

## Requirement → task map

| Spec requirement | Task |
| --- | --- |
| `commands.json` schema and validator | 1 |
| `identity` needs an id-free endpoint + `idField` | 1 (schema), 3 (resolution) |
| `onError` defaults to blank; blank/key/fail | 1 (default), 4 (behavior) |
| Param tokens: `@`-only, `@@` escape, hard error on unknown | 2 |
| `@me` lazy + cached; `@today±<n><d\|w\|m\|y>`; local/TZ | 2, 3 (the `@me` cache) |
| `whoami` reads identity endpoint + display | 3 |
| Joins dedup lookups (M targets, not N rows) | 4 |
| Array-valued join key is a validation error | 4 |
| Partial-join `onError`: blank / key / fail | 4 |
| Drift report: broken commands, new surface | 5 |
| No version bump in B1 | 6 (CHANGELOG only) |

**Deferred to Plan B2, by design:** task-command codegen (emit a CLI from `commands.json` + `client.json` calling these functions), the two design modes in SKILL.md (Q&A default, `draft` selectable), the drift report's user-facing presentation on re-derive, `commands.json`-is-never-overwritten enforcement in the generator, the live smoke against a real site, and the `0.7.0` release.

## Open risks carried into execution

1. **`@today+1m` month rollover.** `setUTCMonth` rolls Jan 31 + 1m into early March. Documented in Task 2; the tests avoid rollover dates. If a real command hits it, clamp to end-of-month in a follow-up rather than now.
2. **Timezone of `@today`.** Resolved via `Intl.DateTimeFormat` with the context tz or `process.env.TZ`. A site that demands UTC while the host is not UTC needs the command's params to pin `TZ`; B2's design docs should mention it. Not a B1 defect.
3. **Join cache is per-`applyJoins`-call.** Correct for one command invocation. B2 must construct a fresh join execution per command run so dedup does not bleed across unrelated commands; noted for B2.
