# derive-client Command Surface, Plan B2: Task CLI, Modes, and Release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the B1 resolver core into a user-visible feature: a generated CLI whose commands are domain tasks (with joins, tokens, shaped output, and redaction), a working `whoami`, the two design modes in the skill, drift-aware regeneration that never overwrites `commands.json`, and the `0.7.0` release that ships the whole command surface.

**Architecture:** Two new shared-runtime modules — `runtime.ts` (a `Caller` that owns the scheduler and the tiered 401 renewal, extracted from the duplicated inline blocks in `call.ts`/`cli.ts`) and `command-runner.ts` (orchestrates tokens → call → joins → sort → render for one task command) — plus small additions to `render.ts`, `identity.ts`, `session.ts`, and `commands-schema.ts`. `codegen.ts` gains a `commands.json`-aware emission path; `generate.ts` loads/validates/protects `commands.json` and prints a drift report. A `scaffold-commands.ts` helper gives draft mode a deterministic, valid starting point. The skill's `SKILL.md` gains the two modes.

**Tech Stack:** Bun 1.3.11, TypeScript (strict), `bun test`. No new dependencies (`playwright` is already a generated-client dependency).

**Source spec:** `docs/specs/2026-07-21-derive-client-command-surface-design.md`
**Predecessors:** Plan A (scheduler/session/render, merged), Plan B1 (resolver core: `commands-schema`, `tokens`, `identity`, `join`, `drift` — merged as PR #11), plugin 0.6.0.

## What B2 ships

- A generated CLI that runs task commands from `commands.json`: token-resolved params, joins with dedup and `onError`, table/json output with sort, limit, and field redaction, plus a real `help`/quickstart.
- `whoami`, and `auth status` that shows the signed-in user once `whoami` has run.
- The shared `Caller` tiered-renewal, reused by `call.ts`, the generated task CLI, joins, and identity (the endpoint-per-command fallback CLI keeps its existing inline copy for now).
- Two design modes in `SKILL.md` (Q&A default, `draft` selectable via a bare positional arg) and a `scaffold-commands.ts` backbone for draft mode.
- Drift-aware regeneration: `commands.json` is loaded, validated, and never overwritten; a drift report prints on every regenerate; broken references stop CLI emission with a clear message.
- The `0.7.0` release cutting the accumulated `[Unreleased]` entries.

## What B2 does NOT ship (deferred, by design)

- **Numbered selectors and `use <selector>`** (luma-style `shifts` list → `shift 1`). This is a stateful per-site selection store, beyond the "domain tasks + whoami" deliverable. Documented as a known gap (see the spec's Generated CLI conventions); a follow-up plan can add it.
- **Automated credential login** (spec open item 1). `login` still needs a human at the keyboard.
- **Legacy 200-with-HTML-error detection** (spec open item 2).
- **Refresh-window countdown** (spec open item 4): `auth status` prints `unknown` for it, as in Plan A.

## Global Constraints

Everything from Plans A and B1 still applies. Restated because a task implementer sees only their own task:

- Runtime artifacts live under the resolved rkt root only. `RKT_CLIENTS_ROOT` overrides the root **only when `NODE_ENV === "test"`**.
- Read mode issues GET and HEAD only. Joins and identity lookups are GET and must not weaken this.
- Secrets, session state, and the identity cache at `0600` in a `0700` dir, never in a repo, never printed. Credential masking (`redactAll`/`maskHeaders`) is always-on; field redaction (the `redact` list) is `--raw`-toggled.
- Safety checks key on structure or shape, never on names.
- Tests are idempotent, use temp directories, and clean up. Typecheck (`bunx tsc --noEmit`) must pass; it runs in the wrapper. Cast a fake `fetch` as `unknown as typeof fetch`, never `as typeof fetch` (Bun's `fetch` type requires `preconnect`).
- **No client-specific names anywhere.** No site name, vendor, or client (e.g. any real customer) may appear in any script, comment, fixture, or doc. The skill and its scripts are generic; fixtures use `example`-style placeholders. This is a hard review gate on every task.
- **Endpoint id format (verified, do not re-derive):** `buildManifest` forms ids as `<method-lowercase>.<path-segments-dotted>` with `{param}` segments collapsed to the bare param name — e.g. `GET /api/v1/employees/{id}` → `get.api.v1.employees.id`, `GET /api/v1/employees/me` → `get.api.v1.employees.me`. `commands.json` references (`call.endpoint`, `join[].endpoint`, `identity.endpoint`) are matched against `manifest.endpoints[].id` by exact string equality. No casing translation.
- **Version bump happens once, in the final task.** Until Task 10, both manifests stay at `0.6.0` and entries accumulate under `## [Unreleased]`.

All paths are relative to `plugins/rkt/skills/derive-client/scripts/` unless prefixed with `plugins/` or `tests/`.

---

## File Structure

**Created:**
- `src/lib/runtime.ts` — `createCaller(manifest, scheduler, secret, deps?)`: issue a read endpoint by id with tiered 401 renewal; the single renewal path.
- `src/lib/command-runner.ts` — `runCommand`, `runWhoami`, `makeResolveMe`: orchestrate one task command end to end against an injected `Caller`.
- `src/scaffold-commands.ts` — emit a valid starter `commands.json` from a manifest (draft-mode backbone).
- Tests: `tests/runtime.test.ts`, `tests/command-runner.test.ts`, `tests/scaffold-commands.test.ts`, an `emitCli` task-mode block in `tests/codegen.test.ts` (Task 6), and the end-to-end task-CLI run in `tests/generated-runs.test.ts` (Task 7).

**Modified:**
- `src/lib/commands-schema.ts` — add optional `output.rows`; add `assertResolvable(commands, endpoints)`.
- `src/lib/render.ts` — add `sortRows(rows, column)`.
- `src/lib/identity.ts` — store a formatted `label` in the identity cache.
- `src/lib/session.ts` — `auth status` reads the identity cache for the "Signed in as" line.
- `src/lib/codegen.ts` — `emitCli(manifest, commands?)` gains a task-CLI emission path.
- `src/generate.ts` — load/validate/protect `commands.json`, print a drift report, add the new runtime files to the allowlist.
- `src/call.ts` — rewire onto `createCaller` (proves the extraction, removes the duplicated renewal).
- `tests/generate.test.ts` — extend `EXPECTED_RUNTIME`; add `commands.json` protection + drift tests.
- `tests/identity.test.ts`, `tests/session.test.ts` — cover the `label` additions.
- `plugins/rkt/skills/derive-client/SKILL.md` — the two design modes and command-surface docs.
- `plugins/rkt/CHANGELOG.md`, `plugins/rkt/.claude-plugin/plugin.json`, `plugins/rkt/.codex-plugin/plugin.json` — the `0.7.0` cut (Task 10 only).

---

## Task 1: Schema — `output.rows` and `assertResolvable`

**Files:**
- Modify: `src/lib/commands-schema.ts`
- Modify: `tests/commands-schema.test.ts`

**Interfaces:**
- Consumes: `ManifestEndpoint` from `manifest-schema` (type-only, so copying `commands-schema.ts` into a generated client stays self-contained — `import type` is erased at compile).
- Produces:
  - `CommandOutput` gains `rows?: string` (a dotted path to the row array for a table; optional, additive, no schema-version bump).
  - `assertResolvable(commands: CommandsFile, endpoints: Pick<ManifestEndpoint, "id" | "params">[]): void` — throws (naming the command and endpoint) when a `call`/`join`/`identity` endpoint id is not in the manifest, or when a `join` lookup endpoint does not have exactly one path param to receive the join key.

- [ ] **Step 1: Write the failing tests**

Append to `tests/commands-schema.test.ts`:

```ts
import { assertResolvable } from "../src/lib/commands-schema";

const ep = (id: string, pathParams: number) => ({
  id,
  params: Array.from({ length: pathParams }, (_, i) => ({
    name: i === 0 ? "id" : `id${i + 1}`,
    in: "path" as const,
    type: "string" as const,
  })),
});

test("passes an optional output.rows path through", () => {
  const cf = valid();
  cf.commands[0].output = { kind: "table", columns: ["a"], rows: "data" };
  expect(validateCommandsFile(cf).commands[0].output.rows).toBe("data");
});

test("assertResolvable accepts commands whose endpoints all exist", () => {
  const cf = validateCommandsFile(valid());
  expect(() =>
    assertResolvable(cf, [
      ep("get.api.v1.employees.me", 0),
      ep("get.scheduling.getShifts", 0),
      ep("get.api.v1.clients.id", 1),
    ]),
  ).not.toThrow();
});

test("assertResolvable rejects a call endpoint the manifest lacks", () => {
  const cf = validateCommandsFile(valid());
  expect(() => assertResolvable(cf, [ep("get.api.v1.employees.me", 0)])).toThrow(
    /get\.scheduling\.getShifts/,
  );
});

test("assertResolvable rejects a join lookup that is not single-path-param", () => {
  const cf = validateCommandsFile(valid());
  expect(() =>
    assertResolvable(cf, [
      ep("get.api.v1.employees.me", 0),
      ep("get.scheduling.getShifts", 0),
      ep("get.api.v1.clients.id", 2), // two path params: ambiguous target for the join key
    ]),
  ).toThrow(/exactly one path param/i);
});

test("assertResolvable rejects an identity endpoint that is not id-free", () => {
  const cf = validateCommandsFile(valid()); // identity -> get.api.v1.employees.me
  expect(() =>
    assertResolvable(cf, [
      ep("get.api.v1.employees.me", 1), // a path param means it is not the /me-style id-free route
      ep("get.scheduling.getShifts", 0),
      ep("get.api.v1.clients.id", 1),
    ]),
  ).toThrow(/identity.*id-free|id-free/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/commands-schema.test.ts`
Expected: FAIL — `assertResolvable` is not exported; the `rows` test fails.

- [ ] **Step 3: Implement**

In `src/lib/commands-schema.ts`, add `rows?: string;` to `CommandOutput`:

```ts
export interface CommandOutput {
  kind: "table" | "json";
  columns?: string[];    // required when kind === "table"
  sort?: string;
  rows?: string;         // dotted path to the row array for a table; absent = body-is-array, or a lone object is one row
}
```

In `validateCommand`, this is an **additive** change: keep the existing element-wise `validateStringArray(output.columns, …)` call intact (an existing test — `columns: ["date", null]` expecting `/output\.columns\[1\]/` — depends on it), and validate `rows` if present. The current return is `output: { ...output, columns }`; the `...output` spread already carries `sort` and `rows`, so only add the `rows` type check:

```ts
  const output = o.output as CommandOutput | undefined;
  if (output?.kind !== "table" && output?.kind !== "json") fail(`${o.name}.output.kind`, "must be table or json");
  if (output.kind === "table" && !Array.isArray(output.columns)) fail(`${o.name}.output.columns`, "required for a table");
  const columns =
    output.kind === "table" ? validateStringArray(output.columns, `${o.name}.output.columns`) : output.columns;
  const rows =
    output.rows === undefined
      ? undefined
      : typeof output.rows === "string"
        ? output.rows
        : fail(`${o.name}.output.rows`, "must be a string");
```

and change the returned output to `output: { ...output, columns, rows }` (leaving the rest of `validateCommand` — `join`, `redact`, `call.params` — exactly as it is).

At the top add the type-only import, and at the bottom add `assertResolvable`:

```ts
import type { ManifestEndpoint } from "./manifest-schema";

export function assertResolvable(
  commands: CommandsFile,
  endpoints: Pick<ManifestEndpoint, "id" | "params">[],
): void {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const need = (cmd: string, endpoint: string): Pick<ManifestEndpoint, "id" | "params"> => {
    const ep = byId.get(endpoint);
    if (!ep) {
      throw new Error(
        `commands.json: ${cmd} references endpoint '${endpoint}', which is not in client.json`,
      );
    }
    return ep;
  };

  if (commands.identity) {
    const idEp = need("identity", commands.identity.endpoint);
    // The spec makes identity an id-free (/me-style) route: no path params, so
    // whoami and @me can fire without a bootstrap id. Enforce it at generation.
    if (idEp.params.some((p) => p.in === "path")) {
      throw new Error(
        `commands.json: identity endpoint '${commands.identity.endpoint}' must be id-free ` +
          `(a /me-style route with no path params), but it takes a path param`,
      );
    }
  }
  for (const c of commands.commands) {
    need(c.name, c.call.endpoint);
    for (const j of c.join ?? []) {
      const ep = need(c.name, j.endpoint);
      const pathParams = ep.params.filter((p) => p.in === "path");
      if (pathParams.length !== 1) {
        throw new Error(
          `commands.json: ${c.name}.join lookup '${j.endpoint}' must have exactly one path param ` +
            `to receive the join key, but has ${pathParams.length}`,
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/commands-schema.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/commands-schema.ts plugins/rkt/skills/derive-client/scripts/tests/commands-schema.test.ts
git commit -m "feat(derive-client): output.rows path and commands-vs-manifest resolvability check"
```

---

## Task 2: render — `sortRows`

**Files:**
- Modify: `src/lib/render.ts`
- Modify: `tests/render.test.ts`

**Interfaces:**
- Consumes: `getPath` (already in `render.ts`).
- Produces: `sortRows(rows: Record<string, unknown>[], column: string): Record<string, unknown>[]` — a new array sorted by the dotted `column`; numbers compare numerically, everything else by locale string; null/undefined sort last.

- [ ] **Step 1: Write the failing test**

Append to `tests/render.test.ts`:

```ts
import { sortRows } from "../src/lib/render";

test("sortRows orders numbers numerically", () => {
  const out = sortRows([{ n: 10 }, { n: 2 }, { n: 1 }], "n");
  expect(out.map((r) => r.n)).toEqual([1, 2, 10]);
});

test("sortRows orders strings by locale and sorts missing values last", () => {
  const out = sortRows([{ s: "b" }, {}, { s: "a" }], "s");
  expect(out.map((r) => r.s)).toEqual(["a", "b", undefined]);
});

test("sortRows reads a dotted path and does not mutate the input", () => {
  const input = [{ c: { name: "z" } }, { c: { name: "a" } }];
  const out = sortRows(input, "c.name");
  expect(out.map((r) => (r.c as { name: string }).name)).toEqual(["a", "z"]);
  expect((input[0].c as { name: string }).name).toBe("z"); // input untouched
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/render.test.ts`
Expected: FAIL — `sortRows` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/render.ts`:

```ts
/** Return a copy of rows sorted by a dotted column. Numbers compare numerically;
 *  everything else by locale string. null/undefined sort last. */
export function sortRows(
  rows: Record<string, unknown>[],
  column: string,
): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const x = getPath(a, column);
    const y = getPath(b, column);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/render.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/render.ts plugins/rkt/skills/derive-client/scripts/tests/render.test.ts
git commit -m "feat(derive-client): sortRows for table output"
```

---

## Task 3: runtime — `createCaller` (the single tiered-renewal path)

**Files:**
- Create: `src/lib/runtime.ts`
- Create: `tests/runtime.test.ts`
- Modify: `src/call.ts` (rewire onto `createCaller`)

**Why this exists:** the tiered 401 renewal (stored credential → OIDC refresh grant → headless browser re-auth, with write-back) is currently duplicated verbatim in `src/call.ts` and inside the string emitted by `codegen.ts`. B2 needs that same renewal from four call sites (manual `call`, the generated task CLI, join lookups, identity fetch). Duplicating it a third and fourth time is the wrong move for a security-sensitive block that writes rotated tokens. `createCaller` is that renewal, extracted once and shared. It owns the scheduler it is given, so join dedup works across every request in a run.

**Honest scope note:** this task rewires `call.ts` and the **task** CLI onto `createCaller`. The endpoint-per-command **fallback** CLI (`emitEndpointCli`, the no-`commands.json` path) keeps its existing inline renewal unchanged in B2 — retiring that copy is deferred so this task stays contained and the 0.6.0 fallback is not disturbed. So B2 unifies the task path but leaves the legacy fallback's copy pending; the requirement map says "task path" rather than claiming a single global renewal.

**Interfaces:**
- Consumes: `ClientManifest`/`ManifestEndpoint` (type), `Scheduler`, `buildRequest`/`issue` (transport), `REFRESH_TOKEN_KEY`/`writeSecret` (secrets), `refreshViaOidc` (refresh), `reauthViaProfile` (reauth). Renewal collaborators are injectable via `deps` for tests.
- Produces:

```ts
export interface CallerDeps {
  refreshViaOidc?: typeof import("./refresh").refreshViaOidc;
  reauthViaProfile?: typeof import("./reauth").reauthViaProfile;
  writeSecret?: typeof import("./secrets").writeSecret;
  log?: (msg: string) => void;
}
export interface Caller {
  /** Issue a read endpoint by id with resolved string params; renews once on 401. */
  call(endpointId: string, params: Record<string, string>): Promise<{ status: number; body: string }>;
  /** call() + JSON.parse, for identity and join lookups. Throws on non-2xx or non-JSON. */
  fetchJson(endpointId: string): Promise<unknown>;
  /** The current (possibly renewed) credential bundle, for redaction. */
  readonly secret: Record<string, string> | null;
}
export function createCaller(
  manifest: ClientManifest,
  scheduler: Scheduler,
  initialSecret: Record<string, string> | null,
  deps?: CallerDeps,
): Caller;
```

- [ ] **Step 1: Write the failing test**

Create `tests/runtime.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { Scheduler, SchedulerResponse } from "../src/lib/scheduler";
import { createCaller } from "../src/lib/runtime";
import { REFRESH_TOKEN_KEY } from "../src/lib/secrets";

const baseManifest = () => ({
  schemaVersion: 2,
  site: "example",
  baseUrl: "https://x.test",
  recordedAt: "",
  harSha256: "",
  userAgent: "UA",
  clientHints: {},
  auth: { kind: "bearer" as const, location: "authorization", mintedBy: null, expiry: null },
  authBundle: {
    credentials: [{ kind: "bearer" as const, location: "authorization", mintedBy: null, expiry: null }],
    earliestExpiry: null,
  },
  refresh: {
    kind: "oidc" as const,
    tokenEndpoint: "https://idp/token",
    clientId: "public",
    accessTokenCookie: null,
    expiresIn: 300,
    refreshExpiresIn: 3600,
  },
  endpoints: [
    {
      id: "get.data",
      method: "GET",
      pathTemplate: "/data",
      params: [],
      responseShape: { type: "unknown" as const },
      source: "xhr" as const,
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
});

// A scheduler that returns queued responses in order and records the auth header seen.
function fakeScheduler(statuses: SchedulerResponse[], seen: string[]): Scheduler {
  let i = 0;
  return {
    run: async (req) => {
      seen.push(req.headers["authorization"] ?? "");
      return statuses[Math.min(i++, statuses.length - 1)];
    },
  };
}

test("passes a 2xx straight through", async () => {
  const seen: string[] = [];
  const sched = fakeScheduler([{ status: 200, body: "{}", headers: {} }], seen);
  const caller = createCaller(baseManifest(), sched, { authorization: "Bearer old" });
  const res = await caller.call("get.data", {});
  expect(res.status).toBe(200);
  expect(seen).toEqual(["Bearer old"]);
});

test("on 401 refreshes via OIDC and retries with the new token", async () => {
  const seen: string[] = [];
  const sched = fakeScheduler(
    [
      { status: 401, body: "no", headers: {} },
      { status: 200, body: "ok", headers: {} },
    ],
    seen,
  );
  const writes: Record<string, string>[] = [];
  const caller = createCaller(
    baseManifest(),
    sched,
    { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" },
    {
      // expiresIn is required on RefreshedTokens (refresh.ts); omitting it fails strict tsc.
      refreshViaOidc: async () => ({ accessToken: "new", refreshToken: "r2", expiresIn: null }),
      writeSecret: async (_site, values) => {
        writes.push(values as Record<string, string>);
      },
    },
  );
  const res = await caller.call("get.data", {});
  expect(res.status).toBe(200);
  expect(seen).toEqual(["Bearer old", "Bearer new"]); // retried with the refreshed token
  expect(writes[0][REFRESH_TOKEN_KEY]).toBe("r2"); // rotated refresh token persisted
  expect(caller.secret?.authorization).toBe("Bearer new");
});

test("falls back to browser re-auth when OIDC refuses", async () => {
  const seen: string[] = [];
  const sched = fakeScheduler(
    [
      { status: 401, body: "no", headers: {} },
      { status: 200, body: "ok", headers: {} },
    ],
    seen,
  );
  const caller = createCaller(
    baseManifest(),
    sched,
    { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" },
    {
      refreshViaOidc: async () => null,
      reauthViaProfile: async () => ({ values: { authorization: "Bearer browser" } }),
      writeSecret: async () => {},
    },
  );
  const res = await caller.call("get.data", {});
  expect(res.status).toBe(200);
  expect(seen[1]).toBe("Bearer browser");
});

test("fetchJson throws a clear error on a non-2xx", async () => {
  const sched = fakeScheduler([{ status: 500, body: "boom", headers: {} }], []);
  const caller = createCaller(baseManifest(), sched, null, { writeSecret: async () => {} });
  await expect(caller.fetchJson("get.data")).rejects.toThrow(/HTTP 500/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/runtime.test.ts`
Expected: FAIL at module resolution for `../src/lib/runtime`.

- [ ] **Step 3: Implement `src/lib/runtime.ts`**

```ts
import type { ClientManifest, ManifestEndpoint } from "./manifest-schema";
import type { Scheduler } from "./scheduler";
import { buildRequest, issue } from "./transport";
import { REFRESH_TOKEN_KEY, writeSecret as realWriteSecret } from "./secrets";
import { refreshViaOidc as realRefresh } from "./refresh";
import { reauthViaProfile as realReauth } from "./reauth";

export interface CallerDeps {
  refreshViaOidc?: typeof realRefresh;
  reauthViaProfile?: typeof realReauth;
  writeSecret?: typeof realWriteSecret;
  log?: (msg: string) => void;
}

export interface Caller {
  call(endpointId: string, params: Record<string, string>): Promise<{ status: number; body: string }>;
  fetchJson(endpointId: string): Promise<unknown>;
  readonly secret: Record<string, string> | null;
}

export function createCaller(
  manifest: ClientManifest,
  scheduler: Scheduler,
  initialSecret: Record<string, string> | null,
  deps: CallerDeps = {},
): Caller {
  const refresh = deps.refreshViaOidc ?? realRefresh;
  const reauth = deps.reauthViaProfile ?? realReauth;
  const writeSecret = deps.writeSecret ?? realWriteSecret;
  const log = deps.log ?? ((m: string) => console.error(m));
  let secret = initialSecret;

  function endpointById(id: string): ManifestEndpoint {
    const ep = manifest.endpoints.find((e) => e.id === id);
    if (!ep) throw new Error(`endpoint ${id} is missing from client.json; regenerate this client`);
    return ep;
  }

  // Tiered renewal: OIDC refresh first (one POST), browser re-auth second
  // (a headless Chrome launch that survives an expired refresh token). Returns
  // true when `secret` was replaced with a fresh, persisted bundle.
  async function renew(): Promise<boolean> {
    if (!secret) return false;
    let renewed: Record<string, string> | null = null;

    if (manifest.refresh?.kind === "oidc" && secret[REFRESH_TOKEN_KEY]) {
      log("credential rejected (401); refreshing via OIDC...");
      const r = await refresh(manifest.refresh, secret[REFRESH_TOKEN_KEY], manifest.userAgent);
      if (r) {
        renewed = { ...secret };
        const cookieName = manifest.refresh.accessTokenCookie;
        if (cookieName) renewed[`cookie:${cookieName}`] = r.accessToken;
        const bearer = manifest.authBundle?.credentials.find((c) => c.kind === "bearer");
        if (bearer) renewed[bearer.location] = `Bearer ${r.accessToken}`;
        if (r.refreshToken) renewed[REFRESH_TOKEN_KEY] = r.refreshToken;
      } else {
        log("OIDC refresh refused; falling back to browser re-auth...");
      }
    }

    if (!renewed) {
      const entryUrl =
        manifest.refresh?.kind === "browser" ? manifest.refresh.entryUrl : `${manifest.baseUrl}/`;
      const wanted = (manifest.authBundle?.credentials ?? []).map((c) => c.location);
      log("re-authenticating with the recorded browser profile...");
      let harvested = null;
      try {
        harvested = await reauth(manifest.site, entryUrl, wanted);
      } catch (err) {
        // A missing dependency is not an expired session; say which it is.
        log((err as Error).message);
      }
      if (harvested) renewed = { ...secret, ...harvested.values };
    }

    if (!renewed) return false;
    await writeSecret(manifest.site, renewed);
    secret = renewed;
    return true;
  }

  async function call(endpointId: string, params: Record<string, string>) {
    const ep = endpointById(endpointId);
    let built = buildRequest(manifest, ep, params, secret);
    let res = await issue(built, scheduler);
    if (res.status === 401 && secret && (await renew())) {
      built = buildRequest(manifest, ep, params, secret);
      res = await issue(built, scheduler);
    }
    return res;
  }

  async function fetchJson(endpointId: string): Promise<unknown> {
    const { status, body } = await call(endpointId, {});
    if (status >= 400) throw new Error(`endpoint ${endpointId} returned HTTP ${status}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`endpoint ${endpointId} did not return JSON`);
    }
  }

  return {
    call,
    fetchJson,
    get secret() {
      return secret;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/runtime.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Rewire `src/call.ts` onto `createCaller`**

Replace the imports of `refreshViaOidc`, `reauthViaProfile`, and the inline 401 block. The new `call.ts` keeps its CLI shell (arg parsing, scrape guard, dry-run, expiry warning, error printing) and delegates issuing + renewal to the caller.

Change the import block near the top to:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifest } from "./lib/manifest";
import { assertUnderRktRoot } from "./lib/paths";
import { createScheduler } from "./lib/scheduler";
import { maskHeaders, readSecrets, redactAll } from "./lib/secrets";
import { createCaller } from "./lib/runtime";
import { buildRequest, type BuiltRequest } from "./lib/transport";
```

Replace everything from `// Throws for any non-GET/HEAD endpoint.` through the end of `main()`'s issue/renewal logic (the block that built the scheduler, issued, and ran the inline 401 tiers) with:

```ts
  // Throws for any non-GET/HEAD endpoint.
  const params = parseParams(process.argv);

  if (process.argv.includes("--dry-run")) {
    const built = buildRequest(manifest, endpoint, params, secret);
    console.log(formatDryRunPreview(built, secret));
    return;
  }

  const scheduler = createScheduler();
  const caller = createCaller(manifest, scheduler, secret);
  const { status, body } = await caller.call(endpoint.id, params);

  if (status >= 400) {
    console.error(`HTTP ${status}`);
    console.error(redactAll(body, caller.secret).slice(0, 2000));
    process.exit(1);
  }
  console.log(redactAll(body, caller.secret));
```

`parseParams`, `formatDryRunPreview`, `arg`, and the pre-flight checks (`readSecrets`, the `manifest.auth && !secret` guard, the expiry warning, the scrape guard) stay exactly as they are. `buildRequest` stays imported for the dry-run preview.

- [ ] **Step 6: Run the affected suites**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/call.test.ts tests/runtime.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck. If `tests/call.test.ts` asserted on the removed inline log strings, update those assertions to the caller's equivalents (the `log` text is identical: "credential rejected (401); refreshing via OIDC...", etc.).

- [ ] **Step 7: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/runtime.ts plugins/rkt/skills/derive-client/scripts/tests/runtime.test.ts plugins/rkt/skills/derive-client/scripts/src/call.ts
git commit -m "feat(derive-client): shared Caller with tiered 401 renewal; rewire call.ts onto it"
```

---

## Task 4: command-runner — one task command, end to end

**Files:**
- Create: `src/lib/command-runner.ts`
- Create: `tests/command-runner.test.ts`

**Interfaces:**
- Consumes: `CommandSpec`/`IdentitySpec` (commands-schema), `ClientManifest` (manifest-schema, type), `applyJoins`/`Lookup` (join), `resolveIdentity`/`whoamiLine` (identity), `resolveToken`/`TokenContext` (tokens), `getPath`/`renderJson`/`renderTable`/`sortRows` (render).
- Produces:

```ts
export interface RunnerCaller {
  call(endpointId: string, params: Record<string, string>): Promise<{ status: number; body: string }>;
  fetchJson(endpointId: string): Promise<unknown>;
}
export interface RunFlags { json: boolean; raw: boolean; limit?: number; }
export interface RunOpts {
  manifest: ClientManifest;
  site: string;
  caller: RunnerCaller;
  identity?: IdentitySpec;
  flags: RunFlags;
  timezone?: string;
  now: Date;
  overrideParams?: Record<string, string>;
}
export function makeResolveMe(site: string, identity: IdentitySpec | undefined, caller: RunnerCaller): () => Promise<string>;
export function runWhoami(site: string, identity: IdentitySpec | undefined, caller: RunnerCaller): Promise<string>;
export function runCommand(cmd: CommandSpec, opts: RunOpts): Promise<string>;
```

Semantics fixed here so codegen (Task 6) only wires:
- Params are `cmd.call.params` overlaid with `opts.overrideParams` (CLI `--name value`), then each value is token-resolved (`@me`, `@today...`, `@@` escape).
- `@me` resolves through one memoized `resolveIdentity` per run (the spec's per-process in-memory memo, layered over identity's on-disk cache). No identity block → `@me` and `whoami` reject with a clear message.
- `json` output: the primary response, redacted (or raw), limited if an array. Joins are a table concern and are not applied to `--json` output; documented, not silent.
- `table` output: rows located via `output.rows` (dotted path → array; absent → body-is-array, or a lone object becomes one row), joins applied with dedup+`onError`, sorted by `output.sort`, limited, rendered with column redaction.
- Join lookups map the single scalar key into the lookup endpoint's sole path param (Task 1's `assertResolvable` guarantees exactly one at generation time).

- [ ] **Step 1: Write the failing test**

Create `tests/command-runner.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { RunnerCaller } from "../src/lib/command-runner";
import { makeResolveMe, runCommand, runWhoami } from "../src/lib/command-runner";

const manifest = {
  schemaVersion: 2, site: "example", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
  userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null,
  endpoints: [
    { id: "get.shifts", method: "GET", pathTemplate: "/shifts", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
    { id: "get.clients.id", method: "GET", pathTemplate: "/clients/{id}", params: [{ name: "id", in: "path" as const, type: "string" as const }], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
    { id: "get.me", method: "GET", pathTemplate: "/me", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
  ],
};

// A caller whose responses are keyed by endpoint id; records calls for assertions.
function caller(bodies: Record<string, unknown>, calls: { ep: string; params: Record<string, string> }[] = []): RunnerCaller {
  return {
    call: async (ep, params) => { calls.push({ ep, params }); return { status: 200, body: JSON.stringify(bodies[ep]) }; },
    fetchJson: async (ep) => bodies[ep],
  };
}

const NOW = new Date("2026-07-21T12:00:00Z");
const baseOpts = (c: RunnerCaller) => ({ manifest, site: "example", caller: c, flags: { json: false, raw: false }, timezone: "UTC", now: NOW });

test("renders a table, joining and redacting", async () => {
  const c = caller({
    "get.shifts": [{ date: "d2", client_id: 7, address: "1 St" }, { date: "d1", client_id: 7, address: "2 Ave" }],
    "get.clients.id": { name: "Acme", secret: "x" },
  });
  const cmd = {
    name: "shifts", summary: "",
    call: { endpoint: "get.shifts", params: {} },
    join: [{ key: "client_id", endpoint: "get.clients.id", select: ["name"], as: "client", onError: "blank" as const }],
    output: { kind: "table" as const, columns: ["date", "client.name", "address"], sort: "date" },
    redact: ["address"],
  };
  const out = await runCommand(cmd, baseOpts(c));
  const lines = out.split("\n");
  expect(lines[0]).toMatch(/date\s+client\.name\s+address/);
  expect(lines[1]).toContain("d1"); // sorted ascending
  expect(lines[1]).toContain("Acme"); // joined
  expect(lines[1]).toContain("[REDACTED]"); // address masked by default
});

test("dedups join lookups across rows", async () => {
  const calls: { ep: string; params: Record<string, string> }[] = [];
  const c = caller({ "get.shifts": [{ client_id: 7 }, { client_id: 7 }], "get.clients.id": { name: "A" } }, calls);
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: {} },
    join: [{ key: "client_id", endpoint: "get.clients.id", select: ["name"], as: "client", onError: "blank" as const }],
    output: { kind: "table" as const, columns: ["client.name"] }, redact: [],
  };
  await runCommand(cmd, baseOpts(c));
  expect(calls.filter((x) => x.ep === "get.clients.id").length).toBe(1);
});

test("locates rows via output.rows", async () => {
  const c = caller({ "get.shifts": { data: [{ date: "d1" }] } });
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: {} },
    output: { kind: "table" as const, columns: ["date"], rows: "data" }, redact: [],
  };
  const out = await runCommand(cmd, baseOpts(c));
  expect(out).toContain("d1");
});

test("resolves @today params before calling", async () => {
  const calls: { ep: string; params: Record<string, string> }[] = [];
  const c = caller({ "get.shifts": [] }, calls);
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: { start: "@today", end: "@today+14d" } },
    output: { kind: "table" as const, columns: ["date"] }, redact: [],
  };
  await runCommand(cmd, baseOpts(c));
  expect(calls[0].params).toEqual({ start: "2026-07-21", end: "2026-08-04" });
});

test("resolves @me from the identity endpoint", async () => {
  const calls: { ep: string; params: Record<string, string> }[] = [];
  const c = caller({ "get.me": { id: 924 }, "get.shifts": [] }, calls);
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: { employee: "@me" } },
    output: { kind: "json" as const }, redact: [],
  };
  await runCommand(cmd, { ...baseOpts(c), identity: { endpoint: "get.me", idField: "id", display: ["id"] } });
  expect(calls.find((x) => x.ep === "get.shifts")?.params.employee).toBe("924");
});

test("@me without an identity block is a clear error", async () => {
  const c = caller({ "get.shifts": [] });
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: { employee: "@me" } },
    output: { kind: "json" as const }, redact: [],
  };
  await expect(runCommand(cmd, baseOpts(c))).rejects.toThrow(/identity/i);
});

test("json output redacts by default and passes raw through", async () => {
  const c = caller({ "get.me": { id: 1, ssn: "secret" } });
  const cmd = { name: "me", summary: "", call: { endpoint: "get.me", params: {} }, output: { kind: "json" as const }, redact: ["ssn"] };
  const masked = await runCommand(cmd, baseOpts(c));
  expect(masked).toContain("[REDACTED]");
  const raw = await runCommand(cmd, { ...baseOpts(c), flags: { json: false, raw: true } });
  expect(raw).toContain("secret");
});

test("runWhoami formats the identity display", async () => {
  const c = caller({ "get.me": { id: 1, first_name: "Ada", email: "ada@x.test" } });
  const line = await runWhoami("example", { endpoint: "get.me", idField: "id", display: ["first_name", "email"] }, c);
  expect(line).toBe("Ada (ada@x.test)");
});
```

Note: `runWhoami`/`makeResolveMe` write the identity cache via `resolveIdentity`, so these tests need the `RKT_CLIENTS_ROOT`/`NODE_ENV=test` temp-dir harness from `tests/identity.test.ts`. Add the same `beforeEach`/`afterEach` block at the top of this file (copy it from `tests/identity.test.ts`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/command-runner.test.ts`
Expected: FAIL at module resolution for `../src/lib/command-runner`.

- [ ] **Step 3: Implement `src/lib/command-runner.ts`**

```ts
import type { CommandSpec, IdentitySpec } from "./commands-schema";
import type { ClientManifest } from "./manifest-schema";
import { applyJoins, type Lookup } from "./join";
import { resolveIdentity, whoamiLine } from "./identity";
import { resolveToken, type TokenContext } from "./tokens";
import { getPath, renderJson, renderTable, sortRows } from "./render";

export interface RunnerCaller {
  call(endpointId: string, params: Record<string, string>): Promise<{ status: number; body: string }>;
  fetchJson(endpointId: string): Promise<unknown>;
}

export interface RunFlags {
  json: boolean;
  raw: boolean;
  limit?: number;
}

export interface RunOpts {
  manifest: ClientManifest;
  site: string;
  caller: RunnerCaller;
  identity?: IdentitySpec;
  flags: RunFlags;
  timezone?: string;
  now: Date;
  overrideParams?: Record<string, string>;
}

/** One memoized identity resolution per run, layered over identity's on-disk cache. */
export function makeResolveMe(
  site: string,
  identity: IdentitySpec | undefined,
  caller: RunnerCaller,
): () => Promise<string> {
  let memo: Promise<string> | undefined;
  return () => {
    if (!identity) {
      return Promise.reject(
        new Error("@me needs an identity block in commands.json; this client has none"),
      );
    }
    return (memo ??= resolveIdentity(site, identity, (id) => caller.fetchJson(id)).then((r) => r.id));
  };
}

export async function runWhoami(
  site: string,
  identity: IdentitySpec | undefined,
  caller: RunnerCaller,
): Promise<string> {
  if (!identity) throw new Error("this client has no identity endpoint; whoami is unavailable");
  const r = await resolveIdentity(site, identity, (id) => caller.fetchJson(id));
  return whoamiLine(r.display, identity.display);
}

function solePathParam(manifest: ClientManifest, endpointId: string): string {
  const ep = manifest.endpoints.find((e) => e.id === endpointId);
  const pathParams = (ep?.params ?? []).filter((p) => p.in === "path");
  if (pathParams.length !== 1) {
    throw new Error(`join lookup ${endpointId} must have exactly one path param`);
  }
  return pathParams[0].name;
}

function extractRows(body: unknown, rowsPath?: string): Record<string, unknown>[] {
  const src = rowsPath ? getPath(body, rowsPath) : body;
  if (Array.isArray(src)) return src as Record<string, unknown>[];
  if (rowsPath) throw new Error(`output.rows '${rowsPath}' did not resolve to an array`);
  if (src && typeof src === "object") return [src as Record<string, unknown>];
  return [];
}

async function resolveParams(
  params: Record<string, string>,
  ctx: TokenContext,
  now: Date,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = await resolveToken(v, ctx, now);
  return out;
}

export async function runCommand(cmd: CommandSpec, opts: RunOpts): Promise<string> {
  const { manifest, site, caller, identity, flags, now } = opts;
  const ctx: TokenContext = {
    resolveMe: makeResolveMe(site, identity, caller),
    timezone: opts.timezone,
  };
  const merged = { ...(cmd.call.params ?? {}), ...(opts.overrideParams ?? {}) };
  const params = await resolveParams(merged, ctx, now);

  const { status, body } = await caller.call(cmd.call.endpoint, params);
  if (status >= 400) throw new Error(`HTTP ${status} from ${cmd.call.endpoint}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${cmd.name}: response was not JSON`);
  }

  const redact = cmd.redact ?? [];

  if (cmd.output.kind === "json") {
    let data = parsed;
    if (typeof flags.limit === "number" && Array.isArray(data)) {
      data = (data as unknown[]).slice(0, flags.limit);
    }
    return renderJson(data, { redact, raw: flags.raw });
  }

  let rows = extractRows(parsed, cmd.output.rows);
  if (cmd.join?.length) {
    const lookup: Lookup = (endpointId, key) => {
      const name = solePathParam(manifest, endpointId);
      return caller.call(endpointId, { [name]: key }).then((r) => {
        if (r.status >= 400) throw new Error(`join lookup ${endpointId} HTTP ${r.status}`);
        return JSON.parse(r.body);
      });
    };
    rows = await applyJoins(rows, cmd.join, lookup);
  }
  if (cmd.output.sort) rows = sortRows(rows, cmd.output.sort);
  if (typeof flags.limit === "number") rows = rows.slice(0, flags.limit);
  return renderTable(rows, cmd.output.columns ?? [], { redact, raw: flags.raw });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/command-runner.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/command-runner.ts plugins/rkt/skills/derive-client/scripts/tests/command-runner.test.ts
git commit -m "feat(derive-client): command-runner orchestrating tokens, joins, sort, render"
```

---

## Task 5: identity cache `label` + `auth status` "Signed in as"

**Files:**
- Modify: `src/lib/identity.ts`
- Modify: `src/lib/session.ts`
- Modify: `tests/identity.test.ts`
- Modify: `tests/session.test.ts`

**Why:** Plan A's `auth status` prints "Signed in as unknown (run whoami)" always, because `session.ts` has the manifest but not the `commands.json` `identity.display` order needed to format a name. B2 closes this by having `resolveIdentity` (which does have `spec.display`) write a formatted `label` into the identity cache, and having `auth status` read it.

**Interfaces:**
- `identity.ts`: `IdentityCache` gains `label: string`. `resolveIdentity` computes `label = whoamiLine(display, spec.display)` and writes it. Return type gains `label`.
- `session.ts`: add `readIdentityLabel(site: string): Promise<string | null>` (reads the identity cache file, returns `label` or null); `runLifecycle`'s `auth status` uses it for the `identity` argument to `formatAuthStatus`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/identity.test.ts`:

```ts
test("stores a formatted label in the cache", async () => {
  const { readFile } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  const s = { endpoint: "get.me", idField: "id", display: ["first_name", "email"] };
  await resolveIdentity("s", s, async () => ({ id: 1, first_name: "Ada", email: "ada@x.test" }));
  const cached = JSON.parse(await readFile(identityCacheFile("s"), "utf8"));
  expect(cached.label).toBe("Ada (ada@x.test)");
});
```

Append to `tests/session.test.ts` (reuse that file's existing temp-root harness; if it lacks one, copy the `beforeEach`/`afterEach` from `tests/identity.test.ts`):

```ts
import { readIdentityLabel } from "../src/lib/session";

test("readIdentityLabel returns the cached label, or null when absent", async () => {
  const { writeFile, mkdir, chmod } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  const { secretsDir } = await import("../src/lib/paths");
  expect(await readIdentityLabel("nobody")).toBeNull();
  await mkdir(secretsDir(), { recursive: true, mode: 0o700 });
  await chmod(secretsDir(), 0o700);
  await writeFile(identityCacheFile("someone"), JSON.stringify({ id: "1", display: {}, label: "Ada (ada@x.test)" }), { mode: 0o600 });
  expect(await readIdentityLabel("someone")).toBe("Ada (ada@x.test)");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/identity.test.ts tests/session.test.ts`
Expected: FAIL — no `label` in the cache; `readIdentityLabel` not exported.

- [ ] **Step 3: Implement `identity.ts`**

**Add no import.** `whoamiLine` is already a hoisted `function` declaration in this same module (`identity.ts:58`), so it is in scope inside `resolveIdentity` with no import and no reordering. Leave the existing import block exactly as it is. Only two edits:

1. Add `label` to the cache interface:

```ts
interface IdentityCache {
  id: string;
  display: Record<string, unknown>;
  label: string;
}
```

2. Where the cache object is built, compute the label with the local `whoamiLine`:

```ts
  const display: Record<string, unknown> = {};
  for (const f of spec.display) display[f] = getPath(body, f);
  const cache: IdentityCache = { id: String(idRaw), display, label: whoamiLine(display, spec.display) };
```

The atomic-write block is unchanged.

- [ ] **Step 4: Implement `session.ts`**

Add `readFile` to the `node:fs/promises` import at the top:

```ts
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
```

Add the reader:

```ts
/** The formatted "Name (email)" label whoami wrote, or null before whoami has run. */
export async function readIdentityLabel(site: string): Promise<string | null> {
  try {
    const raw = await readFile(identityCacheFile(site), "utf8");
    const c = JSON.parse(raw) as { label?: string };
    return typeof c.label === "string" ? c.label : null;
  } catch {
    return null;
  }
}
```

In `runLifecycle`'s `auth status` branch, replace the `identity: null` argument:

```ts
  const label = await readIdentityLabel(manifest.site);
  const lines = formatAuthStatus(
    { identity: label ? { name: label } : null, accessExpiry, refreshWindow: null, storageStateMtime: mtime },
    Date.now(),
  );
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/identity.test.ts tests/session.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/identity.ts plugins/rkt/skills/derive-client/scripts/src/lib/session.ts plugins/rkt/skills/derive-client/scripts/tests/identity.test.ts plugins/rkt/skills/derive-client/scripts/tests/session.test.ts
git commit -m "feat(derive-client): identity cache label feeds auth status Signed-in-as line"
```

---

## Task 6: codegen — emit a task CLI from `commands.json`

**Files:**
- Modify: `src/lib/codegen.ts`
- Modify: `tests/codegen.test.ts`

**Interfaces:**
- Consumes: `CommandsFile` (commands-schema, type).
- Produces: `emitCli(manifest: ClientManifest, commands?: CommandsFile): string`. With `commands`, emit the task CLI below. Without, the existing endpoint-per-command CLI, unchanged (the 0.6.0 / no-`commands.json` fallback). `emitTypes` is unchanged; `generate.ts` still writes `types.ts`.

The task CLI dispatches lifecycle first (`runLifecycle`, unchanged), then `whoami` (only when an identity block exists), then task commands via `runCommand` against a `createCaller`. Global flags: `--json`, `--raw`, `--limit <n>`. `--dry-run` is not offered in task mode (a task is a composed operation, not a single request; `call.ts`/the fallback CLI keep `--dry-run`).

**Task boundary note:** this task is tested at the **unit** level — it asserts on the *string* `emitCli` returns, so it goes green from `codegen.ts` alone with no dependency on Task 7. The full generate → loopback-server → subprocess integration test lives in Task 7, after `generate.ts` is wired to load `commands.json` and copy the new runtime files. This keeps each task's commit green.

- [ ] **Step 1: Write the failing test**

Append to `tests/codegen.test.ts`:

```ts
import { emitCli } from "../src/lib/codegen";

const taskManifest = {
  schemaVersion: 2, site: "example", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
  userAgent: "UA", clientHints: {}, auth: null, authBundle: null, refresh: null,
  endpoints: [
    { id: "get.me", method: "GET", pathTemplate: "/me", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
    { id: "get.shifts", method: "GET", pathTemplate: "/shifts", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
  ],
};
const taskCommands = {
  schemaVersion: 1, site: "example",
  identity: { endpoint: "get.me", idField: "id", display: ["first_name", "email"] },
  commands: [{ name: "shifts", summary: "List shifts", call: { endpoint: "get.shifts", params: {} }, output: { kind: "table" as const, columns: ["date"] }, redact: [] }],
};

test("emitCli with commands emits a task CLI that delegates to the runtime", () => {
  const src = emitCli(taskManifest as never, taskCommands as never);
  expect(src).toContain('"name": "shifts"'); // task command embedded, not the endpoint name
  expect(src).toContain("List shifts");
  expect(src).toContain("runCommand");
  expect(src).toContain("createCaller");
  expect(src).toContain('"../lib/command-runner"');
  expect(src).toContain("whoami"); // identity present -> whoami offered
});

test("emitCli with an identity-less commands file omits whoami", () => {
  const src = emitCli(taskManifest as never, { ...taskCommands, identity: undefined } as never);
  expect(src).toContain("runCommand");
  expect(src).not.toMatch(/name === "whoami"/);
});

test("emitCli without commands keeps the endpoint-per-command CLI", () => {
  const src = emitCli(taskManifest as never);
  expect(src).toContain("COMMANDS"); // endpoint-per-command table
  expect(src).not.toContain("runCommand");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts`
Expected: FAIL — `emitCli` ignores its second argument today, so the task assertions fail (no `runCommand`, no embedded task name).

- [ ] **Step 3: Implement the task-CLI branch in `codegen.ts`**

Add the import and change the signature:

```ts
import type { ClientManifest, JsonShape, ManifestEndpoint } from "./manifest-schema";
import type { CommandsFile } from "./commands-schema";
```

```ts
export function emitCli(manifest: ClientManifest, commands?: CommandsFile): string {
  for (const endpoint of manifest.endpoints) {
    if (!READ_METHODS.has(endpoint.method.toUpperCase())) {
      throw new Error(
        `cannot generate ${endpoint.method} ${endpoint.pathTemplate}: read mode emits GET and HEAD only`,
      );
    }
  }
  if (commands) return emitTaskCli(manifest, commands);
  return emitEndpointCli(manifest);
}
```

Rename the current body of `emitCli` (everything after the READ_METHODS guard) into a new `function emitEndpointCli(manifest: ClientManifest): string { ... }`, unchanged.

Add the task emitter. The embedded `COMMANDS`/`IDENTITY` are the already-validated `commands.json` contents; the emitted code imports the shared runtime and delegates all logic to `runCommand`/`runWhoami`, so the emitted string stays thin:

```ts
function emitTaskCli(manifest: ClientManifest, commands: CommandsFile): string {
  const identityLiteral = commands.identity ? JSON.stringify(commands.identity) : "undefined";
  return `${GENERATED_HEADER(manifest)}
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../lib/manifest-schema";
import { createScheduler } from "../lib/scheduler";
import { createCaller } from "../lib/runtime";
import { runCommand, runWhoami } from "../lib/command-runner";
import type { CommandSpec, IdentitySpec } from "../lib/commands-schema";
import { readSecrets } from "../lib/secrets";
import { runLifecycle } from "../lib/session";

const COMMANDS: CommandSpec[] = ${JSON.stringify(commands.commands, null, 2)};
const IDENTITY: IdentitySpec | undefined = ${identityLiteral};
const SITE = ${JSON.stringify(manifest.site)};

function hasFlag(name: string): boolean {
  return process.argv.includes(\`--\${name}\`);
}
function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(\`--\${name}\`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function usage(): never {
  console.error("usage: bun cli.ts <command> [--param value ...] [--json] [--raw] [--limit n]");
  console.error("");
  console.error("session:");
  console.error("  login                    sign in and save the session");
  console.error("  logout                   remove the saved session and secrets");
  console.error("  auth status              show token TTL and session age");
  if (IDENTITY) console.error("  whoami                   show the signed-in user");
  console.error("");
  console.error("commands:");
  for (const c of COMMANDS) console.error(\`  \${c.name.padEnd(22)} \${c.summary}\`);
  process.exit(1);
}

async function main() {
  const manifestPath = fileURLToPath(new URL("./client.json", import.meta.url));
  if (await runLifecycle(process.argv[2], process.argv[3], manifestPath)) return;

  const name = process.argv[2];
  if (!name || name.startsWith("-")) usage();

  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const secret = await readSecrets(manifest.site);
  // Same pre-flight the manual and fallback CLIs carry: a clear "run login"
  // beats a confusing 401 when the site needs auth but nothing is stored.
  if (manifest.auth && !secret) {
    console.error(\`no stored credential for "\${manifest.site}". Run: bun cli.ts login\`);
    process.exit(1);
  }
  const scheduler = createScheduler();
  const caller = createCaller(manifest, scheduler, secret);

  if (name === "whoami") {
    console.log(await runWhoami(SITE, IDENTITY, caller));
    return;
  }

  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    console.error(\`unknown command: \${name}\`);
    usage();
  }

  // Override declared params from --name value; global flags are never treated as params.
  const overrideParams: Record<string, string> = {};
  for (const key of Object.keys(cmd.call.params ?? {})) {
    const v = flagValue(key);
    if (v !== undefined) overrideParams[key] = v;
  }

  const limitRaw = flagValue("limit");
  const limitNum = limitRaw !== undefined ? Number(limitRaw) : NaN;
  const flags = {
    json: hasFlag("json"),
    raw: hasFlag("raw"),
    // Ignore a non-numeric --limit rather than silently slicing to an empty result.
    limit: Number.isFinite(limitNum) ? limitNum : undefined,
  };
  // --json forces JSON output of the primary response (redaction still applies).
  const toRun = flags.json ? { ...cmd, output: { ...cmd.output, kind: "json" as const } } : cmd;

  const out = await runCommand(toRun, {
    manifest,
    site: SITE,
    caller,
    identity: IDENTITY,
    flags,
    now: new Date(),
    overrideParams,
  });
  console.log(out);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts && bunx tsc --noEmit`
Expected: PASS — the three new `emitCli` assertions and the existing codegen tests, silent typecheck. This is green from `codegen.ts` alone; no Task 7 dependency (the end-to-end run lives in Task 7).

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/codegen.ts plugins/rkt/skills/derive-client/scripts/tests/codegen.test.ts
git commit -m "feat(derive-client): emit a task CLI from commands.json"
```

---

## Task 7: generate — load, validate, and protect `commands.json`; drift report; allowlist

**Files:**
- Modify: `src/generate.ts`
- Modify: `tests/generate.test.ts`
- Modify: `tests/generated-runs.test.ts` (the end-to-end task-CLI run, now that generate is wired)

**Interfaces:**
- Consumes: `validateCommandsFile`/`assertResolvable` (commands-schema), `detectDrift` (drift), `emitCli(manifest, commands?)` (codegen).
- Produces: `generateClient` that, when `<siteDir>/commands.json` exists, validates it, checks resolvability, prints a drift report, and emits the task CLI — **never writing `commands.json`**. When it is absent, the endpoint-per-command fallback is emitted. A malformed `commands.json` is a hard error, not a silent fallback. When drift has broken references, `client.json`/`types.ts` are refreshed but CLI emission stops with a clear message.

- [ ] **Step 1: Write the failing tests**

Append to `tests/generate.test.ts`. First extend the allowlist constant:

```ts
const EXPECTED_RUNTIME = [
  "paths.ts",
  "manifest-schema.ts",
  "secrets.ts",
  "scheduler.ts",
  "transport.ts",
  "refresh.ts",
  "reauth.ts",
  "session.ts",
  "render.ts",
  "commands-schema.ts",
  "tokens.ts",
  "identity.ts",
  "join.ts",
  "runtime.ts",
  "command-runner.ts",
];
```

Then add:

```ts
test("emits a task CLI from commands.json and never overwrites it", async () => {
  const out = join(workRoot, "clients-cmds");
  await generateClient(manifestPath, out); // creates site dir "example"
  const cmdsPath = join(out, "example", "commands.json");
  const commands = {
    schemaVersion: 1, site: "example",
    commands: [{ name: "roster", summary: "the roster", call: { endpoint: "get.api.roster.id", params: { id: "1" } }, output: { kind: "json" }, redact: [] }],
  };
  await writeFile(cmdsPath, JSON.stringify(commands) + "\n");
  await generateClient(manifestPath, out);
  const cli = await readFile(join(out, "example", "cli.ts"), "utf8");
  expect(cli).toContain('"roster"'); // task name, not the endpoint-per-command name
  // commands.json is byte-for-byte preserved
  expect(await readFile(cmdsPath, "utf8")).toBe(JSON.stringify(commands) + "\n");
});

test("refuses a malformed commands.json rather than falling back", async () => {
  const out = join(workRoot, "clients-badcmds");
  await generateClient(manifestPath, out);
  await writeFile(join(out, "example", "commands.json"), "{ not json");
  await expect(generateClient(manifestPath, out)).rejects.toThrow();
});

test("stops CLI emission and refreshes client.json when a command references a dead endpoint", async () => {
  const out = join(workRoot, "clients-drift");
  await generateClient(manifestPath, out);
  const commands = {
    schemaVersion: 1, site: "example",
    commands: [{ name: "gone", summary: "", call: { endpoint: "get.nope", params: {} }, output: { kind: "json" }, redact: [] }],
  };
  await writeFile(join(out, "example", "commands.json"), JSON.stringify(commands));
  await expect(generateClient(manifestPath, out)).rejects.toThrow(/get\.nope|no longer in client\.json/i);
  // client.json still refreshed
  expect(JSON.parse(await readFile(join(out, "example", "client.json"), "utf8")).site).toBe("example");
});
```

Also add the end-to-end task-CLI run to `tests/generated-runs.test.ts`. It generates a client whose `baseUrl` is a loopback server (transport allows `127.0.0.1` http), writes a `commands.json`, regenerates, and runs the task CLI as a subprocess. **Every spawned subprocess must inherit `NODE_ENV=test` and `RKT_CLIENTS_ROOT=<temp>`** so its identity cache and secrets land in the temp sandbox, not the user's real `~/.rkt-clients/` (`paths.ts` honors `RKT_CLIENTS_ROOT` only under `NODE_ENV==="test"`); without this the `whoami` subprocess writes a 0600 cache into the real home and the test is neither hermetic nor idempotent.

```ts
import { generateClient } from "../src/generate";

test("a generated task CLI runs commands, joins, redacts, and answers whoami", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/me") return Response.json({ id: 5, first_name: "Ada", email: "ada@x.test" });
      if (url.pathname === "/shifts") return Response.json([{ date: "d1", client_id: 9, address: "1 St" }, { date: "d2", client_id: 9, address: "2 Ave" }]);
      if (url.pathname.startsWith("/clients/")) return Response.json({ name: "Acme", secret: "x" });
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  const root = await mkdtemp(join(tmpdir(), "rkt-task-"));
  // Every spawned CLI inherits these so its identity cache / secrets stay in the sandbox.
  const env = { ...process.env, NODE_ENV: "test", RKT_CLIENTS_ROOT: root };
  try {
    const rec = join(root, "recording");
    await mkdir(rec, { recursive: true });
    const manifest = {
      schemaVersion: 2, site: "task", baseUrl: base, recordedAt: "", harSha256: "",
      userAgent: "UA", clientHints: {}, auth: null, authBundle: null, refresh: null,
      endpoints: [
        { id: "get.me", method: "GET", pathTemplate: "/me", params: [], responseShape: { type: "unknown" }, source: "xhr", fragile: false, selectors: null, writeSemantics: null },
        { id: "get.shifts", method: "GET", pathTemplate: "/shifts", params: [], responseShape: { type: "unknown" }, source: "xhr", fragile: false, selectors: null, writeSemantics: null },
        { id: "get.clients.id", method: "GET", pathTemplate: "/clients/{id}", params: [{ name: "id", in: "path", type: "number" }], responseShape: { type: "unknown" }, source: "xhr", fragile: false, selectors: null, writeSemantics: null },
      ],
    };
    await writeFile(join(rec, "client.json"), JSON.stringify(manifest));
    const out = join(root, "clients");
    await generateClient(join(rec, "client.json"), out); // first pass creates the site dir
    const commands = {
      schemaVersion: 1, site: "task",
      identity: { endpoint: "get.me", idField: "id", display: ["first_name", "email"] },
      commands: [{
        name: "shifts", summary: "List shifts",
        call: { endpoint: "get.shifts", params: {} },
        join: [{ key: "client_id", endpoint: "get.clients.id", select: ["name"], as: "client", onError: "blank" }],
        output: { kind: "table", columns: ["date", "client.name", "address"], sort: "date" },
        redact: ["address"],
      }],
    };
    await writeFile(join(out, "task", "commands.json"), JSON.stringify(commands));
    await generateClient(join(rec, "client.json"), out); // second pass emits the task CLI

    const cli = join(out, "task", "cli.ts");

    const help = Bun.spawn(["bun", cli], { stdout: "pipe", stderr: "pipe", env });
    const helpText = await new Response(help.stderr).text();
    await help.exited;
    expect(helpText).toContain("shifts");
    expect(helpText).toContain("List shifts");
    expect(helpText).toContain("whoami");

    const who = Bun.spawn(["bun", cli, "whoami"], { stdout: "pipe", stderr: "pipe", env });
    const whoText = await new Response(who.stdout).text();
    expect(await who.exited).toBe(0);
    expect(whoText.trim()).toBe("Ada (ada@x.test)");

    const run = Bun.spawn(["bun", cli, "shifts"], { stdout: "pipe", stderr: "pipe", env });
    const runText = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    expect(runText).toContain("Acme"); // joined
    expect(runText).toContain("[REDACTED]"); // address redacted by default
    expect(runText.indexOf("d1")).toBeLessThan(runText.indexOf("d2")); // sorted

    const raw = Bun.spawn(["bun", cli, "shifts", "--raw"], { stdout: "pipe", stderr: "pipe", env });
    const rawText = await new Response(raw.stdout).text();
    await raw.exited;
    expect(rawText).toContain("1 St"); // --raw shows the address
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/generate.test.ts tests/generated-runs.test.ts`
Expected: FAIL — the allowlist copy misses the new files; `commands.json` is ignored (the CLI still lists endpoint-per-command names, so `whoami`/`shifts` are unknown).

- [ ] **Step 3: Implement `generate.ts`**

Add the new runtime files to `RUNTIME_FILES` (and update the header comment to name them; re-run the closure probe if you add more):

```ts
const RUNTIME_FILES = [
  "paths.ts",
  "manifest-schema.ts",
  "secrets.ts",
  "scheduler.ts",
  "transport.ts",
  "refresh.ts",
  "reauth.ts",
  "session.ts",
  "render.ts",
  "commands-schema.ts",
  "tokens.ts",
  "identity.ts",
  "join.ts",
  "runtime.ts",
  "command-runner.ts",
];
```

Add imports:

```ts
import { emitCli, emitTypes } from "./lib/codegen";
import { validateManifest } from "./lib/manifest";
import { assertResolvable, validateCommandsFile, type CommandsFile } from "./lib/commands-schema";
import { detectDrift } from "./lib/drift";
```

Add a drift printer that takes an already-computed report (so `detectDrift` runs once per generate):

```ts
function reportDrift(site: string, drift: ReturnType<typeof detectDrift>): void {
  if (drift.broken.length === 0 && drift.newSurface.length === 0) {
    console.error(`No drift: commands.json matches client.json for "${site}".`);
    return;
  }
  console.error(`Drift report for "${site}":`);
  for (const b of drift.broken) console.error(`  broken   ${b.command} -> ${b.endpoint} (no longer in client.json)`);
  for (const id of drift.newSurface) console.error(`  new      ${id} (no command references it yet)`);
}
```

In `generateClient`, after writing `client.json` and `types.ts` but before writing `cli.ts`, branch on the presence of `commands.json`:

```ts
  // Site directory.
  const siteDir = join(outRoot, manifest.site);
  await write(join(siteDir, "client.json"), `${JSON.stringify(manifest, null, 2)}\n`, written);
  await write(join(siteDir, "types.ts"), emitTypes(manifest), written);

  // commands.json is the user's: read it, never write it. Absent => 0.6.0 fallback.
  let commands: CommandsFile | undefined;
  try {
    commands = validateCommandsFile(JSON.parse(await readFile(join(siteDir, "commands.json"), "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`commands.json for "${manifest.site}" is invalid: ${(err as Error).message}`);
    }
  }

  if (commands) {
    const drift = detectDrift(commands, manifest);
    reportDrift(manifest.site, drift);
    if (drift.broken.length > 0) {
      throw new Error(
        `commands.json references ${drift.broken.length} endpoint(s) no longer in client.json; ` +
          `edit commands.json and regenerate. client.json was refreshed.`,
      );
    }
    assertResolvable(commands, manifest.endpoints); // join arity, id-free identity
  }

  await write(join(siteDir, "cli.ts"), emitCli(manifest, commands), written);

  return { siteDir, written };
```

(`readFile` is already imported at the top of `generate.ts`.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/generate.test.ts tests/generated-runs.test.ts && bunx tsc --noEmit`
Expected: PASS across both suites (this is where the Task 6 task-CLI test finally goes green), silent typecheck. If the generated-client `tsc` sub-test flags a missing lib file, a required runtime file is absent from the allowlist — add it and re-run.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/generate.ts plugins/rkt/skills/derive-client/scripts/tests/generate.test.ts plugins/rkt/skills/derive-client/scripts/tests/generated-runs.test.ts
git commit -m "feat(derive-client): generate task CLI from a protected commands.json with a drift report"
```

---

## Task 8: scaffold-commands — the draft-mode backbone

**Files:**
- Create: `src/scaffold-commands.ts`
- Create: `tests/scaffold-commands.test.ts`

**Interfaces:**
- Consumes: `ClientManifest` (type), `commandNames` (codegen), `CommandsFile` (commands-schema, type).
- Produces: `scaffoldCommands(manifest: ClientManifest): CommandsFile` — one `json`-output command per endpoint (readable names via `commandNames`, no joins, empty redact), with `identity` guessed only when an endpoint id ends in `.me` and has no path params, else omitted. `main()` reads `--manifest`, writes `--out` (refusing to overwrite an existing file), so draft mode gets a deterministic, valid starting `commands.json` with correct endpoint ids.

- [ ] **Step 1: Write the failing test**

Create `tests/scaffold-commands.test.ts`:

```ts
import { expect, test } from "bun:test";
import { scaffoldCommands } from "../src/scaffold-commands";
import { validateCommandsFile } from "../src/lib/commands-schema";

const manifest = (extra: unknown[] = []) => ({
  schemaVersion: 2, site: "example", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
  userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null,
  endpoints: [
    { id: "get.api.shifts", method: "GET", pathTemplate: "/api/shifts", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
    ...extra,
  ],
});

test("scaffolds a valid commands.json with one json command per endpoint", () => {
  const cf = scaffoldCommands(manifest() as never);
  expect(() => validateCommandsFile(cf)).not.toThrow();
  expect(cf.commands.map((c) => c.name)).toContain("api-shifts");
  expect(cf.commands[0].output.kind).toBe("json");
  expect(cf.identity).toBeUndefined();
});

test("guesses identity from an id-free .me endpoint", () => {
  const me = { id: "get.api.employees.me", method: "GET", pathTemplate: "/api/employees/me", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null };
  const cf = scaffoldCommands(manifest([me]) as never);
  expect(cf.identity?.endpoint).toBe("get.api.employees.me");
  // the identity endpoint is not also emitted as a plain command
  expect(cf.commands.some((c) => c.call.endpoint === "get.api.employees.me")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/scaffold-commands.test.ts`
Expected: FAIL at module resolution for `../src/scaffold-commands`.

- [ ] **Step 3: Implement `src/scaffold-commands.ts`**

```ts
/**
 * Emit a valid starter commands.json from a derived manifest.
 *
 * Usage: bun src/scaffold-commands.ts --manifest <path/to/client.json> --out <path/to/commands.json>
 *
 * This is the draft-mode backbone: it guarantees correct endpoint ids and a
 * schema-valid file the agent (or the user) then refines with joins, tables,
 * and redactions. It refuses to overwrite an existing commands.json.
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { commandNames } from "./lib/codegen";
import { validateManifest } from "./lib/manifest";
import type { ClientManifest } from "./lib/manifest-schema";
import type { CommandsFile } from "./lib/commands-schema";

export function scaffoldCommands(manifest: ClientManifest): CommandsFile {
  const names = commandNames(manifest.endpoints);
  const identityEp = manifest.endpoints.find(
    (e) => /\.me$/.test(e.id) && e.params.every((p) => p.in !== "path"),
  );
  const commands = manifest.endpoints
    .filter((e) => e.id !== identityEp?.id)
    .map((e) => ({
      name: names.get(e.id)!,
      summary: `${e.method} ${e.pathTemplate}`,
      call: { endpoint: e.id, params: {} as Record<string, string> },
      output: { kind: "json" as const },
      redact: [] as string[],
    }));

  return {
    schemaVersion: 1,
    site: manifest.site,
    identity: identityEp ? { endpoint: identityEp.id, idField: "id", display: [] } : undefined,
    commands,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const manifestPath = arg("manifest");
  const out = arg("out");
  if (!manifestPath || !out) {
    console.error("usage: bun src/scaffold-commands.ts --manifest <path> --out <commands.json path>");
    process.exit(1);
  }
  if (await access(out).then(() => true).catch(() => false)) {
    console.error(`refusing to overwrite existing ${out}; commands.json is yours to edit`);
    process.exit(1);
  }
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  await writeFile(out, `${JSON.stringify(scaffoldCommands(manifest), null, 2)}\n`);
  console.error(`Wrote a draft commands.json with ${scaffoldCommands(manifest).commands.length} command(s) to ${out}`);
  console.error("Edit it to add joins, table output, and redactions, then run generate.ts.");
}

if (import.meta.main) {
  await main();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/scaffold-commands.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/scaffold-commands.ts plugins/rkt/skills/derive-client/scripts/tests/scaffold-commands.test.ts
git commit -m "feat(derive-client): scaffold-commands draft-mode backbone"
```

---

## Task 9: SKILL.md — the two design modes and command-surface docs

**Files:**
- Modify: `plugins/rkt/skills/derive-client/SKILL.md`

Doc-only. No code, no tests. The genericity gate applies: no client or vendor names anywhere.

- [ ] **Step 1: Update the scope note**

Replace the "This plan-1 skill covers `read` mode only..." paragraph (near line 28) with:

```markdown
This skill records a session, derives a `client.json` endpoint manifest, and
generates a standalone typed CLI. It has two design modes for shaping that CLI
into domain tasks (below). `full` (read + write) mode arrives in a later plan.
```

- [ ] **Step 2: Add a "Design modes" section**

Insert a new section immediately before `## Step 0: Consent gate`:

```markdown
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
```

- [ ] **Step 3: Replace Step 9's tail and add Steps 10-11**

After the existing Step 9 (generate the typed client), append these subsections. Keep Step 9's existing body; add:

```markdown
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
```

- [ ] **Step 4: Genericity sweep**

Search the whole skill directory for any client, vendor, or site name and remove it:

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
grep -rniE 'alayacare|<any-real-client-or-vendor-name>' plugins/rkt/skills/derive-client/ || echo "clean"
```

Expected: `clean`. Anything found is a Global-Constraint violation and must be replaced with an `example`-style placeholder.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/SKILL.md
git commit -m "docs(derive-client): two design modes and the command-surface workflow"
```

---

## Task 10: Full gate, live smoke, and the 0.7.0 release

**Files:**
- Modify: `plugins/rkt/CHANGELOG.md`
- Modify: `plugins/rkt/.claude-plugin/plugin.json`
- Modify: `plugins/rkt/.codex-plugin/plugin.json`

- [ ] **Step 1: Run the full repo gate**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
(cd plugins/rkt/skills/derive-client/scripts && bun test && bunx tsc --noEmit)
LANG=en_US.UTF-8 bash -c 'for t in tests/test-*.sh; do bash "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"; done'
claude plugin validate plugins/rkt
```

Expected: all unit tests pass (grep the summary line for `0 fail`, do not trust a truncated tail), silent typecheck, all wrapper tests `OK`, validation passes. Run from the main checkout, not a worktree.

- [ ] **Step 2: Live smoke (owner-run, against a real recorded site)**

This is the "build the real thing" gate; it is manual because it needs a signed-in browser. On a client the owner has already recorded and generated with a `commands.json`:

1. `bun "$OUT/<site>/cli.ts" login` — a browser opens; sign in; it reports the session saved.
2. `bun "$OUT/<site>/cli.ts" whoami` — prints the signed-in user's name/email.
3. `bun "$OUT/<site>/cli.ts" auth status` — the "Signed in as" line now names the user; "Access token expires in …" shows a real countdown; "Refresh window unknown".
4. `bun "$OUT/<site>/cli.ts" <a join-bearing task>` — returns shaped, sorted, redacted data; compare against the browser by **shape**, not value.
5. `bun "$OUT/<site>/cli.ts" <task> --raw` — the redacted fields appear.

Record the outcome in the PR description. Do not claim the release is verified without this pass.

- [ ] **Step 3: Cut 0.7.0 in the CHANGELOG**

In `plugins/rkt/CHANGELOG.md`, rename `## [Unreleased]` to `## [0.7.0] - 2026-07-21` and consolidate its entries (the Plan A lifecycle work, the B1 resolver core, and this plan's command surface) under it. Add a concise summary line for B2:

```markdown
### Added

- Task-oriented generated CLIs: a user-owned `commands.json` shapes endpoints
  into domain commands with param tokens (`@me`, `@today` offsets), joins that
  dedup lookups and honour a per-command `onError`, table/json output with
  sort, `--limit`, and field redaction that is on by default (`--raw` opts
  out). New `whoami`, and `auth status` now names the signed-in user. Two design
  modes (interactive default, `draft`) and a `scaffold-commands` starting point.
  Regeneration reads a drift report and never overwrites `commands.json`.
```

- [ ] **Step 4: Bump both manifests to 0.7.0**

Set `"version": "0.7.0"` in both `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json` (they must stay in lockstep).

- [ ] **Step 5: Re-validate and commit**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
claude plugin validate plugins/rkt
git add plugins/rkt/CHANGELOG.md plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json
git commit -m "chore(release): derive-client command surface, v0.7.0"
git tag -a v0.7.0 -m "v0.7.0"
```

- [ ] **Step 6: Seek approval before pushing**

Do not push the branch or the tag without explicit approval (AGENTS.md Release Flow). After approval: `git push origin <branch> v0.7.0`, then open the PR.

---

## Requirement → task map

| Spec requirement | Task |
| --- | --- |
| Commands are domain tasks, not endpoint clones | 4 (runner), 6 (codegen) |
| Two design modes, both produce `commands.json`, bare positional arg | 8 (scaffold), 9 (SKILL.md) |
| One command may call several endpoints (joins), dedup | 4 (runner wires B1 `applyJoins`); scheduler dedup via shared caller (3) |
| Joins stay within human-shaped rate limiting | 3 (one scheduler owned by the caller, shared across joins) |
| Session lifecycle wired per client; `whoami` | 5 (auth status name), 6 (whoami emission) |
| `auth status` shows token TTL; refresh window `unknown` | 5 |
| `login` self-sufficient, no re-record | Plan A `runLifecycle` (unchanged), surfaced in task CLI (6) |
| `commands.json` is the user's, never overwritten; drift report | 7 |
| CLI conventions: help, `--json`, `--raw`, `--limit`, redaction | 4 (runner), 6 (emitted CLI) |
| Redacted by default in every output mode, `--raw` to opt out | 4 |
| Param tokens `@me`/`@today`, `@@` escape | 4 (wires B1 `tokens`), 5 (`@me` via identity) |
| Table output with columns, sort, and a locatable row array | 1 (`output.rows`), 2 (`sortRows`), 4 |
| Array-valued join key / bad `onError` rejected | B1 (`join`/schema); arity checked at generation (1) |
| A 0.6.0 client keeps working; regeneration upgrades it | 6 (fallback path), 7 (absent-`commands.json` fallback) |
| Shared tiered-renewal for the task path (no per-site hand-roll) | 3 (`createCaller`; legacy fallback CLI keeps its inline copy, deferred) |
| Live smoke; 0.7.0 release | 10 |

## Deferred / known gaps (surfaced, not silently dropped)

1. **Numbered selectors and `use <selector>`** — a stateful selection store; deferred to a follow-up. Documented in "What B2 does NOT ship".
2. **`--json` does not apply joins** — it returns the redacted primary response. Joins are a table concern; documented in Task 4's semantics and the SKILL.md.
3. **`@today+1m` month rollover** (B1 carry-over) — `setUTCMonth` rolls Jan 31 into early March; clamp is a future refinement.
4. **Automated credential login, 200-with-HTML errors, refresh-window countdown** — spec open items 1, 2, 4; unchanged, still deferred.

## Self-review

- **Spec coverage:** every row in the requirement map points at a task; the deferred list names every conscious omission with its reason.
- **Type consistency:** `Caller` (runtime) and `RunnerCaller` (command-runner) share the `call`/`fetchJson` shape; the emitted CLI's `createCaller` result satisfies `RunnerCaller` structurally. `CommandSpec`/`IdentitySpec`/`CommandOutput` come from B1's `commands-schema` (with `rows` added in Task 1). Endpoint-id form is pinned in Global Constraints and matched by exact equality everywhere.
- **No placeholders:** every code step shows complete code; every test step shows the assertions; every run step names the command and expected result. The only intentional `<...>` are shell placeholders the user fills (`<site-slug>`, `$OUT`), matching the existing SKILL.md style.
- **Per-task green (ordering):** each task now commits green on its own. Task 6 is unit-tested at the `emitCli`-string level (no generate dependency); the end-to-end generate → loopback → subprocess run lives in Task 7, after `generate.ts` is wired to load `commands.json` and copy the new runtime files. No task ships a knowingly-red commit.
- **Test hermeticity:** every subprocess a test spawns inherits `NODE_ENV=test` + `RKT_CLIENTS_ROOT=<temp>` (Task 7), and every in-process test that resolves identity uses the temp-root `beforeEach`/`afterEach` (Tasks 4, 5), so no test writes into the user's real `~/.rkt-clients/`.
