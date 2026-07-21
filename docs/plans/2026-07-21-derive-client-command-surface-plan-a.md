# derive-client Command Surface, Plan A: Runtime Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every generated client session-lifecycle commands (`login`, `logout`, `auth status`), a request scheduler that can dedup and back off, output shaping with redaction, and a per-credential expiry so `auth status` shows a live token TTL.

**Architecture:** Replace the opaque-thunk `ratelimit.ts` with a `scheduler.ts` that owns the fetch (so it can key a dedup cache by URL and back off on status), update its three callers, add `session.ts` and `render.ts` to the shared runtime, teach `secrets.ts` to store a live per-credential expiry, and wire all three new files plus a no-`commands.json` fallback into the generator.

**Tech Stack:** Bun 1.3.11, TypeScript, `bun test`. No new dependencies (`playwright` is already a generated-client dependency).

**Source spec:** `docs/specs/2026-07-21-derive-client-command-surface-design.md`
**Predecessor:** plugin 0.6.0 (`docs/specs/2026-07-20-derive-client-skill-design.md`)

## What Plan A ships, and what it does not

**Ships, verifiable on a regenerated client with no `commands.json`:** `login`, `logout`, `auth status`. The scheduler, redaction-capable renderer, and per-credential expiry all land here.

**Does NOT ship here:** `whoami`, `@me`, `commands.json`, joins, task commands. `whoami` needs `identity` from `commands.json`, which is Plan B. `auth status`'s "Signed in as" line therefore prints `unknown (run whoami)` until Plan B lands.

## Global Constraints

Everything from the 0.6.0 runtime still applies. Restated because a task implementer sees only their own task:

- Runtime artifacts live under the resolved rkt root only, never cwd-relative. `RKT_CLIENTS_ROOT` overrides the root **only when `NODE_ENV === "test"`**.
- Read mode issues GET and HEAD only. The scheduler must not weaken this.
- Secrets and session state live at mode `0600` in a `0700` directory, never in a repo, never printed. Credential-value masking (`redactAll`/`maskHeaders`) is always-on and never disabled by `--raw`.
- Safety checks key on structure or shape, never on names (CLAUDE.md).
- Skills resolve bundled files via `RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"`.
- Tests are idempotent, use temp directories, and clean up. Typecheck (`bunx tsc --noEmit`) must pass; it runs in the wrapper.
- **No version bump in Plan A.** Both manifests stay at `0.6.0`; entries accumulate under `## [Unreleased]`. Plan B's final task cuts the version, per the amended `AGENTS.md` release policy.

All paths are relative to `plugins/rkt/skills/derive-client/scripts/` unless prefixed with `plugins/` or `tests/`.

---

## File Structure

**Created:**
- `src/lib/scheduler.ts` — request scheduler: owns fetch, pacing, per-run dedup cache, 429/503 backoff. Replaces `ratelimit.ts`.
- `src/lib/session.ts` — `login`, `logout`, `authStatus` logic (pure where possible; the browser launch reuses `reauth.ts`).
- `src/lib/render.ts` — table/json rendering and field redaction.
- `src/session.ts` — the `login`/`logout`/`auth status` CLI entry, emitted into generated clients.
- `tests/scheduler.test.ts`, `tests/session.test.ts`, `tests/render.test.ts`

**Modified:**
- `src/lib/transport.ts` — `issue` calls the scheduler instead of a thunk-limiter.
- `src/call.ts` — construct and pass the scheduler.
- `src/lib/codegen.ts` — emitted `cli.ts` uses the scheduler; emit the lifecycle commands.
- `src/lib/secrets.ts` — store and read a per-credential `expiry`; expose `storedAt`.
- `src/generate.ts` — `RUNTIME_FILES` gains the three new files and drops `ratelimit.ts`; emit lifecycle commands when no `commands.json` exists.
- `tests/generate.test.ts`, `tests/transport.test.ts` — adapt to the new scheduler and allowlist.
- `plugins/rkt/CHANGELOG.md` — `## [Unreleased]` entries.

**Deleted:**
- `src/lib/ratelimit.ts` and `tests/ratelimit.test.ts` — both in Task 3. The limiter's concerns move to `scheduler.ts`/`tests/scheduler.test.ts`. `tests/ratelimit.test.ts` imports `createLimiter` from the deleted module, so it must be removed in the same task or `bun test` and `tsc` fail at module resolution.

Note: `tests/refresh.test.ts` and `tests/manifest.test.ts` are **not** modified. `refresh.test.ts` imports only `applyCredentials` and `reauthViaProfile` (no limiter, no `issue`-with-thunk). `manifest.test.ts`'s import-closure test lists `./ratelimit` as an allowed import for `manifest-schema.ts`, but `manifest-schema.ts` has no runtime imports so that branch never executes; leave it.

---

## Task 1: Scheduler core (pacing + dedup)

**Files:**
- Create: `src/lib/scheduler.ts`
- Create: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createScheduler(options?: SchedulerOptions): Scheduler` where

```ts
export interface SchedulerOptions {
  minDelayMs?: number;   // default 400
  maxDelayMs?: number;   // default 1300
  fetchImpl?: typeof fetch; // injectable for tests
}
export interface SchedulerResponse { status: number; body: string; headers: Record<string, string>; }
export interface Scheduler {
  run(req: { url: string; method: string; headers: Record<string, string> }): Promise<SchedulerResponse>;
}
```

`run` serializes calls (concurrency 1), spaces successive calls by a random delay in `[min, max]` (first call not delayed), and **deduplicates GET/HEAD requests by URL within the scheduler's lifetime**: a repeated GET to the same URL returns the first response without a second fetch. Backoff is Task 2.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createScheduler } from "../src/lib/scheduler";

function fakeFetch(log: string[], status = 200) {
  return async (url: string | URL) => {
    log.push(String(url));
    return new Response("{}", { status, headers: { "content-type": "application/json" } });
  };
}

test("runs a request and returns status, body, headers", async () => {
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch([]) as typeof fetch });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(200);
  expect(r.body).toBe("{}");
  expect(r.headers["content-type"]).toBe("application/json");
});

test("dedups identical GETs within its lifetime", async () => {
  const log: string[] = [];
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch(log) as typeof fetch });
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/b", method: "GET", headers: {} });
  expect(log).toEqual(["https://x.test/a", "https://x.test/b"]);
});

test("does not dedup non-GET methods", async () => {
  const log: string[] = [];
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch(log) as typeof fetch });
  await s.run({ url: "https://x.test/a", method: "HEAD", headers: {} });
  await s.run({ url: "https://x.test/a", method: "HEAD", headers: {} });
  // HEAD is cacheable too; but a POST would not be. Assert HEAD dedups, POST does not.
  expect(log).toEqual(["https://x.test/a"]);
  await s.run({ url: "https://x.test/a", method: "POST", headers: {} });
  expect(log).toEqual(["https://x.test/a", "https://x.test/a"]);
});

test("serializes: never two fetches in flight at once", async () => {
  let active = 0, maxActive = 0;
  const slow = async (url: string | URL) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return new Response("{}", { status: 200 });
  };
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: slow as typeof fetch });
  await Promise.all([1, 2, 3, 4].map((n) => s.run({ url: `https://x.test/${n}`, method: "GET", headers: {} })));
  expect(maxActive).toBe(1);
});

test("spaces successive distinct calls by at least the minimum", async () => {
  const s = createScheduler({ minDelayMs: 40, maxDelayMs: 45, fetchImpl: fakeFetch([]) as typeof fetch });
  const start = Date.now();
  await s.run({ url: "https://x.test/1", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/2", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/3", method: "GET", headers: {} });
  expect(Date.now() - start).toBeGreaterThanOrEqual(75);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/scheduler.test.ts`
Expected: FAIL at module resolution for `../src/lib/scheduler`.

- [ ] **Step 3: Write the implementation**

```ts
export interface SchedulerOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SchedulerResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface SchedulerRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface Scheduler {
  run(req: SchedulerRequest): Promise<SchedulerResponse>;
}

const CACHEABLE = new Set(["GET", "HEAD"]);

/**
 * Serializes requests with human-shaped pacing, dedups cacheable requests by
 * URL for its lifetime, and (Task 2) backs off on 429/503. Owns the fetch so
 * it can see the URL for dedup and the status for backoff — the previous
 * opaque-thunk limiter could see neither.
 */
export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const min = options.minDelayMs ?? 400;
  const max = Math.max(options.maxDelayMs ?? 1300, min);
  const doFetch = options.fetchImpl ?? fetch;

  let tail: Promise<unknown> = Promise.resolve();
  let first = true;
  const cache = new Map<string, Promise<SchedulerResponse>>();

  function once(req: SchedulerRequest): Promise<SchedulerResponse> {
    const run = tail.then(async () => {
      if (first) {
        first = false;
      } else {
        const delay = min + Math.floor(Math.random() * (max - min + 1));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      const res = await doFetch(req.url, { method: req.method, headers: req.headers });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return { status: res.status, body: await res.text(), headers };
    });
    tail = run.catch(() => undefined);
    return run;
  }

  return {
    run(req) {
      const cacheable = CACHEABLE.has(req.method.toUpperCase());
      if (cacheable) {
        const hit = cache.get(req.url);
        if (hit) return hit;
      }
      const p = once(req);
      if (cacheable) cache.set(req.url, p);
      return p;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/scheduler.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/scheduler.ts plugins/rkt/skills/derive-client/scripts/tests/scheduler.test.ts
git commit -m "feat(derive-client): add request scheduler with pacing and dedup"
```

---

## Task 2: Scheduler backoff on 429/503

**Files:**
- Modify: `src/lib/scheduler.ts`
- Modify: `tests/scheduler.test.ts`

**Interfaces:**
- Adds `maxRetries?: number` (default 3) and `sleepImpl?: (ms: number) => Promise<void>` to `SchedulerOptions`. The sleep seam lets tests assert backoff *durations* without waiting on the wall clock; production defaults to a real `setTimeout`. The `Scheduler` shape is unchanged.

On a 429 or 503, the scheduler waits and retries the same request up to `maxRetries` times. Wait is `Retry-After` seconds when the header is present and numeric, else exponential backoff (500ms, 1000ms, 2000ms). A failed request is not cached, so a later call may retry cleanly.

- [ ] **Step 1: Write the failing test**

The `sleepImpl` seam records requested delays so the tests assert the backoff schedule and run instantly. Append to `tests/scheduler.test.ts`:

```ts
test("retries a 503 with exponential backoff, then succeeds", async () => {
  let calls = 0;
  const flaky = async () =>
    ++calls < 3 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 });
  const slept: number[] = [];
  const s = createScheduler({
    minDelayMs: 0, maxDelayMs: 0, maxRetries: 3,
    fetchImpl: flaky as typeof fetch,
    sleepImpl: async (ms) => { slept.push(ms); },
  });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(200);
  expect(calls).toBe(3);
  // Two retries: 500ms then 1000ms. Asserted, so the name is not a lie.
  expect(slept).toEqual([500, 1000]);
});

test("honors a numeric Retry-After header over the exponential schedule", async () => {
  let calls = 0;
  const flaky = async () =>
    ++calls < 2
      ? new Response("slow", { status: 429, headers: { "retry-after": "3" } })
      : new Response("{}", { status: 200 });
  const slept: number[] = [];
  const s = createScheduler({
    minDelayMs: 0, maxDelayMs: 0,
    fetchImpl: flaky as typeof fetch,
    sleepImpl: async (ms) => { slept.push(ms); },
  });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(200);
  expect(calls).toBe(2);
  expect(slept).toEqual([3000]); // Retry-After seconds, not the 500ms default
});

test("gives up after maxRetries and returns the last error response", async () => {
  const always503 = async () => new Response("busy", { status: 503 });
  const s = createScheduler({
    minDelayMs: 0, maxDelayMs: 0, maxRetries: 2,
    fetchImpl: always503 as typeof fetch,
    sleepImpl: async () => {},
  });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(503);
});

test("caches a response that succeeded after retries", async () => {
  let calls = 0;
  const flaky = async () =>
    ++calls < 2 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 });
  const s = createScheduler({
    minDelayMs: 0, maxDelayMs: 0, fetchImpl: flaky as typeof fetch, sleepImpl: async () => {},
  });
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} }); // 503 then 200 => calls 2
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} }); // served from cache
  expect(calls).toBe(2); // no third fetch
});

test("does not cache a failed response", async () => {
  let calls = 0;
  const recovering = async () => {
    calls++;
    return calls === 1 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 });
  };
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, maxRetries: 0, fetchImpl: recovering as typeof fetch });
  const first = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(first.status).toBe(503);
  const second = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(second.status).toBe(200); // not served from cache
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/scheduler.test.ts`
Expected: FAIL — retries are not implemented; the 503 tests see `calls === 1`.

- [ ] **Step 3: Update the implementation**

Add to `SchedulerOptions`: `maxRetries?: number;` and `sleepImpl?: (ms: number) => Promise<void>;`. In `createScheduler`, read `const maxRetries = options.maxRetries ?? 3;` and `const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));`. Replace the fetch section of `once` with a retry loop that uses `sleep`:

```ts
  const RETRYABLE = new Set([429, 503]);

  async function fetchWithBackoff(req: SchedulerRequest): Promise<SchedulerResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(req.url, { method: req.method, headers: req.headers });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const out = { status: res.status, body: await res.text(), headers };
      if (!RETRYABLE.has(res.status) || attempt >= maxRetries) return out;

      const retryAfter = Number(headers["retry-after"]);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
      if (waitMs > 0) await sleep(waitMs);
    }
  }
```

Note the `Retry-After` parse: `Number("")` is `0` and `Number.isFinite(0)` is true, so a present-but-empty header yields a 0ms wait, not the exponential default. That is intentional (an explicit "retry now"); an absent header is `undefined` → `Number(undefined)` is `NaN` → falls to exponential.

In `once`, call `await fetchWithBackoff(req)` in place of the inline fetch. After the whole `run` resolves, evict a non-2xx cached entry so a retry is possible:

```ts
    tail = run.catch(() => undefined);
    run.then((r) => {
      if (r.status < 200 || r.status >= 300) cache.delete(req.url);
    }).catch(() => cache.delete(req.url));
    return run;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/scheduler.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/scheduler.ts plugins/rkt/skills/derive-client/scripts/tests/scheduler.test.ts
git commit -m "feat(derive-client): add 429/503 backoff to the scheduler"
```

---

## Task 3: Point transport and callers at the scheduler; delete ratelimit.ts

**Files:**
- Modify: `src/lib/transport.ts`
- Modify: `src/call.ts`
- Modify: `src/lib/codegen.ts`
- Modify: `tests/transport.test.ts`
- Delete: `src/lib/ratelimit.ts`

**Interfaces:**
- `issue(built: BuiltRequest, scheduler: Scheduler): Promise<{ status: number; body: string }>` — second arg is now a `Scheduler`, not a thunk-limiter.
- Produces: no `createLimiter` anywhere; all three callers construct `createScheduler()`.

- [ ] **Step 1: Update the `issue` test first**

In `tests/transport.test.ts`, find the `issue`-related tests. Replace any limiter stub with a scheduler stub. Add:

```ts
import { createScheduler } from "../src/lib/scheduler";

test("issue calls the scheduler and returns status and body", async () => {
  const scheduler = createScheduler({
    minDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch,
  });
  const built = { url: "https://x.test/api", method: "GET", headers: {} };
  const { status, body } = await issue(built, scheduler);
  expect(status).toBe(200);
  expect(body).toBe('{"ok":true}');
});

test("issue still refuses a non-read method", async () => {
  const scheduler = createScheduler({ minDelayMs: 0, maxDelayMs: 0 });
  await expect(
    issue({ url: "https://x.test/api", method: "DELETE", headers: {} }, scheduler),
  ).rejects.toThrow(/GET and HEAD only/i);
});
```

Remove any existing test that passes a bare `limit` function to `issue`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/transport.test.ts`
Expected: FAIL — `issue`'s second parameter is still a thunk-limiter.

- [ ] **Step 3: Rewrite `issue`**

In `src/lib/transport.ts`, import the scheduler type and rewrite:

```ts
import type { Scheduler } from "./scheduler";

export async function issue(
  built: BuiltRequest,
  scheduler: Scheduler,
): Promise<{ status: number; body: string }> {
  if (!READ_METHODS.has(built.method.toUpperCase())) {
    throw new Error(
      `refusing ${built.method} ${built.url}: read mode issues GET and HEAD only`,
    );
  }
  const { status, body } = await scheduler.run({
    url: built.url,
    method: built.method,
    headers: built.headers,
  });
  return { status, body };
}
```

- [ ] **Step 4: Update `src/call.ts`**

Change the import `import { createLimiter } from "./lib/ratelimit";` to `import { createScheduler } from "./lib/scheduler";`. Change `const limiter = createLimiter();` to `const scheduler = createScheduler();`. Change both `issue(built, limiter)` calls to `issue(built, scheduler)`.

- [ ] **Step 5: Update `src/lib/codegen.ts`**

The emitted `cli.ts` string imports and uses the limiter. Change the emitted import from `import { createLimiter } from "../lib/ratelimit";` to `import { createScheduler } from "../lib/scheduler";`, the emitted `const limiter = createLimiter();` to `const scheduler = createScheduler();`, and both emitted `issue(built, limiter)` to `issue(built, scheduler)`. These are inside the template string; update the literal text.

- [ ] **Step 6: Delete the old limiter AND its orphaned test, then confirm nothing references it**

```bash
cd plugins/rkt/skills/derive-client/scripts
rm src/lib/ratelimit.ts tests/ratelimit.test.ts
# grep src AND tests: the orphaned test would otherwise fail module resolution.
grep -rn "ratelimit\|createLimiter" src/ tests/ && echo "STILL REFERENCED" || echo "clean"
```
Expected: `clean`. `tests/ratelimit.test.ts` imports `createLimiter` from the module just deleted; leaving it makes Step 7 fail at module resolution. Its five cases (pacing, serialization, first-call-not-delayed) are already covered by `tests/scheduler.test.ts` from Tasks 1-2, so nothing is lost.

- [ ] **Step 7: Run tests and typecheck**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test && bunx tsc --noEmit`
Expected: PASS, silent typecheck. `tests/refresh.test.ts` does NOT reference the limiter (only `applyCredentials` and `reauthViaProfile`), so it needs no change; if it fails, something else regressed.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(derive-client): replace thunk-limiter with the scheduler"
```

---

## Task 4: Per-credential expiry in secrets

**Files:**
- Modify: `src/lib/secrets.ts`
- Modify: `tests/secrets.test.ts`

**Interfaces:**
- `writeSecret(site, values)` unchanged in signature, but each value that is a JWT gets its `exp` decoded and stored; `storedAt` is retained.
- Produces: `readSecretMeta(site: string): Promise<{ values: Record<string, string>; storedAt: string | null; expiry: Record<string, string | null> } | null>` where `expiry` maps a value-location to an ISO timestamp (or null when the value is not a JWT). `readSecrets` keeps its current shape for existing callers.

This is what lets `auth status` show a live TTL: the manifest's `auth.expiry` is recording-time and useless at runtime, so the truth must come from the token actually stored now.

- [ ] **Step 1: Write the failing test**

Append to `tests/secrets.test.ts` (it already sets `RKT_CLIENTS_ROOT` to a temp dir; reuse that harness):

```ts
import { readSecretMeta } from "../src/lib/secrets";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

test("readSecretMeta decodes a JWT value's expiry", async () => {
  const exp = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
  await writeSecret("metatest", { "cookie:token": jwt({ exp }) });
  const meta = await readSecretMeta("metatest");
  expect(meta?.expiry["cookie:token"]).toBe("2026-08-01T00:00:00.000Z");
});

test("readSecretMeta reports null expiry for a non-JWT value", async () => {
  await writeSecret("metatest2", { "cookie:sid": "opaquevalue" });
  const meta = await readSecretMeta("metatest2");
  expect(meta?.expiry["cookie:sid"]).toBeNull();
});

test("readSecretMeta exposes storedAt", async () => {
  await writeSecret("metatest3", { "cookie:sid": "opaquevalue" });
  const meta = await readSecretMeta("metatest3");
  expect(typeof meta?.storedAt).toBe("string");
});

test("readSecrets still returns just the values for existing callers", async () => {
  await writeSecret("metatest4", { "cookie:sid": "opaquevalue" });
  expect(await readSecrets("metatest4")).toEqual({ "cookie:sid": "opaquevalue" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/secrets.test.ts`
Expected: FAIL at import — no export `readSecretMeta`.

- [ ] **Step 3: Implement**

Add a JWT-expiry decoder and `readSecretMeta` to `src/lib/secrets.ts`. Do not change `writeSecret`'s stored shape beyond what already exists (`values` + `storedAt`): expiry is derived on read, so no migration is needed.

```ts
/** Decode a JWT exp claim to an ISO timestamp, or null if the value is not a JWT. */
function jwtExpiry(value: string): string | null {
  const bare = value.replace(/^bearer\s+/i, "");
  const parts = bare.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload?.exp !== "number") return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}

export interface SecretMeta {
  values: Record<string, string>;
  storedAt: string | null;
  expiry: Record<string, string | null>;
}

export async function readSecretMeta(site: string): Promise<SecretMeta | null> {
  try {
    const body = JSON.parse(await readFile(secretsFile(site), "utf8")) as SecretBody;
    const values =
      body.values && typeof body.values === "object"
        ? body.values
        : typeof body.value === "string"
          ? { default: body.value }
          : null;
    if (!values) return null;
    const expiry: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(values)) expiry[k] = jwtExpiry(v);
    return { values, storedAt: body.storedAt ?? null, expiry };
  } catch {
    return null;
  }
}
```

If `SecretBody` does not already type `storedAt`, add `storedAt?: string;` to it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/secrets.ts plugins/rkt/skills/derive-client/scripts/tests/secrets.test.ts
git commit -m "feat(derive-client): expose per-credential expiry and storedAt"
```

---

## Task 5: auth status formatting

**Files:**
- Create: `src/lib/session.ts`
- Create: `tests/session.test.ts`

**Interfaces:**
- Consumes: `readSecretMeta`, `storageStateFile` from `lib/paths`.
- Produces: `formatAuthStatus(input: AuthStatusInput, now: number): string[]` — pure, returns one string per line. The CLI (`src/session.ts`, Task 7) gathers the input and prints. `AuthStatusInput` is:

```ts
export interface AuthStatusInput {
  identity: { name: string } | null;      // Plan A always passes null
  accessExpiry: string | null;            // ISO, live, from readSecretMeta
  refreshWindow: null;                     // not derivable; Plan A always null
  storageStateMtime: number | null;       // ms epoch, or null
}
```

Keeping formatting pure and separate from IO makes the TTL logic testable without a filesystem.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { formatAuthStatus } from "../src/lib/session";

const NOW = Date.parse("2026-07-21T12:00:00Z");

test("shows a live access-token countdown", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: "2026-07-21T12:03:42Z", refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Access token\s+expires in 3m 42s/.test(l))).toBe(true);
});

test("says expired when the token is in the past", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: "2026-07-21T11:59:00Z", refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Access token\s+expired/.test(l))).toBe(true);
});

test("prints unknown for a missing access expiry", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Access token\s+unknown/.test(l))).toBe(true);
});

test("refresh window is always unknown in Plan A", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Refresh window\s+unknown/.test(l))).toBe(true);
});

test("identity line prompts whoami when identity is null", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines[0]).toMatch(/unknown \(run whoami\)/i);
});

test("shows how long ago the browser session was saved", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: NOW - 2 * 3600_000 },
    NOW,
  );
  expect(lines.some((l) => /Browser session saved 2h ago/.test(l))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/session.test.ts`
Expected: FAIL at module resolution for `../src/lib/session`.

- [ ] **Step 3: Implement `formatAuthStatus`**

```ts
export interface AuthStatusInput {
  identity: { name: string } | null;
  accessExpiry: string | null;
  refreshWindow: null;
  storageStateMtime: number | null;
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  // Drop a trailing "0m" so exactly-N-hour durations read "2h", matching the
  // spec's sample output, not "2h 0m".
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

export function formatAuthStatus(input: AuthStatusInput, now: number): string[] {
  const lines: string[] = [];

  lines.push(
    input.identity ? `Signed in as ${input.identity.name}` : "Signed in as unknown (run whoami)",
  );

  if (!input.accessExpiry) {
    lines.push("Access token     unknown");
  } else {
    const delta = Date.parse(input.accessExpiry) - now;
    lines.push(delta <= 0 ? "Access token     expired" : `Access token     expires in ${humanDuration(delta)}`);
  }

  lines.push("Refresh window   unknown");

  lines.push(
    input.storageStateMtime == null
      ? "Browser session  none saved"
      : `Browser session saved ${humanDuration(now - input.storageStateMtime)} ago`,
  );

  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/session.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/session.ts plugins/rkt/skills/derive-client/scripts/tests/session.test.ts
git commit -m "feat(derive-client): add auth status line formatting"
```

---

## Task 6: login and logout logic

**Files:**
- Modify: `src/lib/session.ts`
- Modify: `tests/session.test.ts`

**Interfaces:**
- Consumes: `reauthViaProfile`-style launch is NOT reused directly (that harvests headless); `login` launches headed. Uses `profileDir`, `storageStateFile`, `secretsFile` from `lib/paths`.
- Produces: `logoutSite(site: string): Promise<{ removed: string[] }>` (pure-ish: deletes the three session files, reports which existed) and `loginSite(site: string, entryUrl: string, opts?: { launch?: Launcher }): Promise<boolean>` where `Launcher` is an injectable seam so the browser is not launched in unit tests. `login`'s real launcher lives here but is only exercised by the live smoke test.

- [ ] **Step 1: Write the failing test for logout**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logoutSite } from "../src/lib/session";

let root: string;
const ORIG = process.env.RKT_CLIENTS_ROOT;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rkt-logout-"));
  process.env.RKT_CLIENTS_ROOT = root;
  process.env.NODE_ENV = "test";
});
afterEach(async () => {
  if (ORIG === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIG;
  await rm(root, { recursive: true, force: true });
});

test("logout removes the secrets, storage-state, and identity files that exist", async () => {
  const { secretsFile, storageStateFile } = await import("../src/lib/paths");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(secretsFile("s"), "{}");
  await writeFile(storageStateFile("s"), "{}");
  const { removed } = await logoutSite("s");
  expect(removed).toContain(secretsFile("s"));
  expect(removed).toContain(storageStateFile("s"));
  await expect(access(secretsFile("s"))).rejects.toThrow();
});

test("logout is a no-op when nothing is stored", async () => {
  const { removed } = await logoutSite("never");
  expect(removed).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/session.test.ts`
Expected: FAIL — no export `logoutSite`.

- [ ] **Step 3: Implement `logoutSite` and `loginSite`**

Add to `src/lib/session.ts`. The identity cache path is defined here for Plan B's use and cleared now so a future `@me` cannot survive a logout:

```ts
import { rm, stat } from "node:fs/promises";
import { profileDir, secretsFile, storageStateFile, secretsDir } from "./paths";
import { sanitizeSite } from "./paths";

export function identityCacheFile(site: string): string {
  return `${secretsDir()}/${sanitizeSite(site)}.identity.json`;
}

export async function logoutSite(site: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const path of [secretsFile(site), storageStateFile(site), identityCacheFile(site)]) {
    try {
      await stat(path);
      await rm(path, { force: true });
      removed.push(path);
    } catch {
      /* not present */
    }
  }
  return removed.length ? { removed } : { removed: [] };
}

export interface Launcher {
  (site: string, entryUrl: string, statePath: string): Promise<boolean>;
}

/**
 * Open headed Chrome on the recorded profile, wait for the user to sign in,
 * save storageState. The launcher is injectable so unit tests never open a
 * browser; the real launcher is exercised by the live smoke test.
 */
export async function loginSite(
  site: string,
  entryUrl: string,
  opts: { launch?: Launcher } = {},
): Promise<boolean> {
  const launch = opts.launch ?? defaultLauncher;
  // Clear identity cache first: signing in as a different user must not leave
  // a stale @me pointing at the previous person.
  await rm(identityCacheFile(site), { force: true }).catch(() => {});
  return launch(site, entryUrl, storageStateFile(site));
}

const defaultLauncher: Launcher = async (site, entryUrl, statePath) => {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    return false;
  }
  const ctx = await pw.chromium.launchPersistentContext(profileDir(site), {
    channel: "chrome",
    headless: false,
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    // Wait until the user has left the identity provider (signed in), capped.
    await page
      .waitForURL((u) => !/identity|login|auth|realms/i.test(u.host + u.pathname), { timeout: 300_000 })
      .catch(() => {});
    await ctx.storageState({ path: statePath });
    return true;
  } finally {
    await ctx.close().catch(() => {});
  }
};
```

- [ ] **Step 4: Add a login test using the injected launcher**

```ts
test("login clears the identity cache and delegates to the launcher", async () => {
  const { identityCacheFile, loginSite } = await import("../src/lib/session");
  const { mkdir, writeFile, access } = await import("node:fs/promises");
  const { secretsDir } = await import("../src/lib/paths");
  await mkdir(secretsDir(), { recursive: true });
  await writeFile(identityCacheFile("s"), "{}");

  let called = false;
  const ok = await loginSite("s", "https://app.test/", {
    launch: async () => { called = true; return true; },
  });
  expect(ok).toBe(true);
  expect(called).toBe(true);
  await expect(access(identityCacheFile("s"))).rejects.toThrow(); // cleared
});
```

- [ ] **Step 5: Run tests**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/session.test.ts && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/session.ts plugins/rkt/skills/derive-client/scripts/tests/session.test.ts
git commit -m "feat(derive-client): add login and logout session commands"
```

---

## Task 7: render.ts — table, json, redaction

**Files:**
- Create: `src/lib/render.ts`
- Create: `tests/render.test.ts`

**Interfaces:**
- Produces: `renderTable(rows: Record<string, unknown>[], columns: string[], opts: { redact: string[]; raw: boolean }): string`, `renderJson(data: unknown, opts: { redact: string[]; raw: boolean }): string`, and `getPath(obj: unknown, dottedPath: string): unknown`. Redaction runs in **both** renderers unless `raw` is true; the `redact` list names dotted paths.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { getPath, renderJson, renderTable } from "../src/lib/render";

const rows = [
  { date: "2026-07-21", client: { name: "Acme" }, address: "1 High St" },
  { date: "2026-07-22", client: { name: "Beta" }, address: "2 Low Rd" },
];

test("getPath reads dotted paths into nested objects", () => {
  expect(getPath(rows[0], "client.name")).toBe("Acme");
  expect(getPath(rows[0], "date")).toBe("2026-07-21");
  expect(getPath(rows[0], "client.missing")).toBeUndefined();
});

test("renderTable shows declared columns including joined paths", () => {
  const out = renderTable(rows, ["date", "client.name"], { redact: [], raw: false });
  expect(out).toContain("Acme");
  expect(out).toContain("2026-07-21");
});

test("renderTable redacts a declared field by default", () => {
  const out = renderTable(rows, ["date", "address"], { redact: ["address"], raw: false });
  expect(out).not.toContain("1 High St");
  expect(out).toContain("[REDACTED]");
});

test("renderTable with raw shows the redacted field", () => {
  const out = renderTable(rows, ["date", "address"], { redact: ["address"], raw: true });
  expect(out).toContain("1 High St");
});

test("renderJson redacts by default, in the serialized structure", () => {
  const out = renderJson(rows, { redact: ["address"], raw: false });
  expect(out).not.toContain("1 High St");
  expect(out).toContain("[REDACTED]");
  // still valid JSON
  expect(() => JSON.parse(out)).not.toThrow();
});

test("renderJson with raw does not redact", () => {
  const out = renderJson(rows, { redact: ["address"], raw: true });
  expect(out).toContain("1 High St");
});

test("renderJson redacts a nested joined path", () => {
  const out = renderJson([{ client: { name: "Acme", ssn: "123" } }], { redact: ["client.ssn"], raw: false });
  expect(out).not.toContain("123");
  expect(out).toContain("Acme");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/render.test.ts`
Expected: FAIL at module resolution for `../src/lib/render`.

- [ ] **Step 3: Implement**

```ts
const REDACTED = "[REDACTED]";

export function getPath(obj: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function setPath(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cur[keys[i]];
    if (!next || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  if (keys[keys.length - 1] in cur) cur[keys[keys.length - 1]] = value;
}

function redactClone<T>(data: T, paths: string[]): T {
  const clone = JSON.parse(JSON.stringify(data));
  const apply = (node: unknown) => {
    if (node && typeof node === "object") {
      for (const p of paths) setPath(node as Record<string, unknown>, p, REDACTED);
    }
  };
  if (Array.isArray(clone)) clone.forEach(apply);
  else apply(clone);
  return clone;
}

export function renderJson(data: unknown, opts: { redact: string[]; raw: boolean }): string {
  const out = opts.raw ? data : redactClone(data, opts.redact);
  return JSON.stringify(out, null, 2);
}

export function renderTable(
  rows: Record<string, unknown>[],
  columns: string[],
  opts: { redact: string[]; raw: boolean },
): string {
  const redactSet = new Set(opts.raw ? [] : opts.redact);
  const cell = (row: Record<string, unknown>, col: string): string => {
    if (redactSet.has(col)) return REDACTED;
    const v = getPath(row, col);
    return v == null ? "" : String(v);
  };
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const line = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join("  ");
  return [line(columns), ...rows.map((r) => line(columns.map((c) => cell(r, c))))].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/render.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/render.ts plugins/rkt/skills/derive-client/scripts/tests/render.test.ts
git commit -m "feat(derive-client): add table/json rendering with field redaction"
```

---

## Task 8: Generator wiring — allowlist, lifecycle CLI, no-commands.json fallback

**Files:**
- Modify: `src/generate.ts`
- Modify: `src/lib/codegen.ts`
- Modify: `tests/generate.test.ts`

No `src/session.ts` file is created — `runLifecycle` lives in `src/lib/session.ts` (Task 6/Step 4 above), which `RUNTIME_FILES` already copies.

**Interfaces:**
- Consumes: everything above.
- Produces: generated clients whose `lib/` contains `scheduler.ts`, `session.ts`, `render.ts` (and no `ratelimit.ts`), and a `cli.ts` that dispatches `login`, `logout`, `auth status` before the endpoint/task commands. No `commands.json` is required.

- [ ] **Step 1: Update every RUNTIME_FILES assertion in `tests/generate.test.ts`**

`tests/generate.test.ts` pins the runtime set in **two** places (a "copies the runtime" test and an "every file present" test). Update **both**. The expected set is:

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
];
```

Assert each is copied and that `ratelimit.ts` is NOT copied. **Do not touch `tests/manifest.test.ts`**: its import-closure test lists `./ratelimit` as an allowed import for `manifest-schema.ts`, but `manifest-schema.ts` has no runtime imports, so that branch never runs and the entry is inert. Leaving it avoids churn for no behavior change.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/generate.test.ts`
Expected: FAIL — the generator still copies the old set.

- [ ] **Step 3: Update the allowlist**

In `src/generate.ts`, set `RUNTIME_FILES` to the array above (drop `ratelimit.ts`, add `scheduler.ts`, `session.ts`, `render.ts`). Update the closure-note comment: `scheduler.ts` imports nothing outside the set; `session.ts` imports `./paths`, `./secrets`, `./reauth`, `./manifest-schema`; `render.ts` imports nothing outside the set. Run the Task-1-style closure probe over the new set to confirm it resolves standalone before moving on.

- [ ] **Step 4: Add `runLifecycle` to `src/lib/session.ts`**

`runLifecycle` goes **into `src/lib/session.ts`**, not a separate `src/session.ts` entry file. This is the fix for a layout trap: the generator writes `lib/` to `<outRoot>/lib/` and the CLI entry to `<outRoot>/<site>/cli.ts`, so the emitted `cli.ts` imports `../lib/...`. A separate `src/session.ts` copied verbatim would use `./lib/...` (correct in the skill's `src/`, since `tsconfig.json` includes `src/`) but resolve to a nonexistent `<site>/lib/` in the generated client. A `lib/` file sidesteps this entirely: `session.ts` sits in `lib/` in both layouts, so its `./manifest-schema`, `./paths`, `./secrets` imports resolve unchanged, and it is already copied by `RUNTIME_FILES`.

Append to `src/lib/session.ts`:

```ts
import { stat } from "node:fs/promises";
import { validateManifest } from "./manifest-schema";
import { readSecretMeta } from "./secrets";
// storageStateFile is already imported at the top of this file.

function firstJwtExpiry(expiry: Record<string, string | null>): string | null {
  for (const v of Object.values(expiry)) if (v) return v;
  return null;
}

/**
 * Handle the lifecycle commands (login, logout, auth status) shared by every
 * generated client. Returns true when it handled the command, false to let the
 * caller fall through to endpoint/task dispatch. `manifestPath` is a plain
 * filesystem path (the caller resolves it), so no URL decoding is needed here.
 */
export async function runLifecycle(
  command: string,
  sub: string | undefined,
  manifestPath: string,
): Promise<boolean> {
  if (command !== "login" && command !== "logout" && !(command === "auth" && sub === "status")) {
    return false;
  }
  const raw = await import("node:fs/promises").then((fs) => fs.readFile(manifestPath, "utf8"));
  const manifest = validateManifest(JSON.parse(raw));

  if (command === "login") {
    const ok = await loginSite(manifest.site, `${manifest.baseUrl}/`);
    console.error(ok ? "signed in; session saved" : "login could not complete");
    return true;
  }
  if (command === "logout") {
    const { removed } = await logoutSite(manifest.site);
    console.error(removed.length ? `removed ${removed.length} session file(s)` : "nothing to remove");
    return true;
  }
  // command === "auth" && sub === "status"
  const meta = await readSecretMeta(manifest.site);
  const accessExpiry = meta ? firstJwtExpiry(meta.expiry) : null;
  let mtime: number | null = null;
  try {
    mtime = (await stat(storageStateFile(manifest.site))).mtimeMs;
  } catch {
    /* no saved session */
  }
  const lines = formatAuthStatus(
    { identity: null, accessExpiry, refreshWindow: null, storageStateMtime: mtime },
    Date.now(),
  );
  console.log(lines.join("\n"));
  return true;
}
```

There is no `src/session.ts` and no extra copy step in `generate.ts`; `RUNTIME_FILES` already carries `session.ts`.

Wire the emitted `cli.ts` to call it. In `src/lib/codegen.ts`, add to the emitted import block `import { runLifecycle } from "../lib/session";`, and at the very top of the emitted `main()` (before manifest load and command dispatch), insert:

```ts
  const handled = await runLifecycle(
    process.argv[2],
    process.argv[3],
    fileURLToPath(new URL("./client.json", import.meta.url)),
  );
  if (handled) return;
```

Also add `import { fileURLToPath } from "node:url";` to the emitted import block. **`fileURLToPath`, not `.pathname`**: `.pathname` leaves `%20` and other reserved characters percent-encoded, so a client directory containing a space would make the manifest read fail. `fileURLToPath` decodes correctly. (The emitted code elsewhere already passes a `URL` object straight to `readFile`, which is also safe; `runLifecycle` takes a string, so decode here.)

and add the emitted import `import { runLifecycle } from "./session";`.

- [ ] **Step 5: Verify a generated client runs the lifecycle commands**

Add to `tests/generate.test.ts` a subprocess test using the existing generate-into-temp harness:

```ts
test("a generated client answers auth status without a commands.json", async () => {
  const out = await generateIntoTemp(); // existing helper producing a client dir
  const proc = Bun.spawn(["bun", `${out}/cli.ts`, "auth", "status"], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  expect(text).toMatch(/Access token/);
  expect(text).toMatch(/Refresh window\s+unknown/);
});
```

If no `generateIntoTemp` helper exists, follow the pattern already in `tests/generated-runs.test.ts` (generate from a fixture manifest into `mkdtemp`, then spawn).

- [ ] **Step 6: Run tests and typecheck**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(derive-client): wire lifecycle commands into generated clients"
```

---

## Task 9: Live smoke and CHANGELOG

**Files:**
- Modify: `plugins/rkt/CHANGELOG.md`

- [ ] **Step 1: Regenerate the existing client and exercise the lifecycle commands**

The AlayaCare client and a valid session already exist from prior sessions. Regenerate it against the current source and confirm the new commands work end to end:

```bash
S=plugins/rkt/skills/derive-client/scripts
MANIFEST=$(ls -t ~/.rkt-clients/recordings/*/*/client.json | head -1)
(cd "$S" && bun src/generate.ts --manifest "$MANIFEST" --out ~/Documents/Repositories/rkt-clients)
CLIENT=~/Documents/Repositories/rkt-clients/$(jq -r .site "$MANIFEST")
(cd ~/Documents/Repositories/rkt-clients && bun install >/dev/null 2>&1)
bun "$CLIENT/cli.ts" auth status
```

Expected: an `auth status` block with a real `Access token expires in …` (or `expired`), `Refresh window unknown`, and a browser-session line. Then:

```bash
bun "$CLIENT/cli.ts" logout   # removes session files
bun "$CLIENT/cli.ts" auth status   # now shows unknown / none saved
```

Expected: `logout` reports files removed; the second `auth status` shows `Access token unknown` and `Browser session none saved`. Do not run `login` unattended; it opens a browser and needs a human. Report what the commands printed (no token values).

- [ ] **Step 2: Run the full repo gate**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
LANG=en_US.UTF-8 bash -c 'for t in tests/test-*.sh; do bash "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"; done'
claude plugin validate plugins/rkt
```

Expected: all 12 OK; validation passes. Run from the main checkout, not a worktree.

- [ ] **Step 3: Add CHANGELOG entries under [Unreleased]**

Under the existing `## [Unreleased]` heading (do not add a version; Plan B releases):

```markdown
### Added

- Generated clients gain session-lifecycle commands: `login` (opens a browser,
  saves the session), `logout` (clears stored session), and `auth status`
  (shows a live access-token TTL from the currently stored token). `whoami`
  follows in the command-surface release.
- A request scheduler replaces the rate limiter: same human-shaped pacing, plus
  per-run dedup of repeated GETs and 429/503 backoff honouring `Retry-After`.
  This is the foundation the task-command joins build on.
- Field-level output redaction (`--raw` to opt out), applied in both table and
  `--json` output.

### Changed

- `secrets.ts` derives a live per-credential expiry (from a JWT `exp`) so
  `auth status` reflects the token actually stored now, not the recording-time
  value.
```

- [ ] **Step 4: Commit**

```bash
git add plugins/rkt/CHANGELOG.md
git commit -m "docs(derive-client): changelog for the runtime foundation"
```

---

## Requirement → task map

| Spec section | Task |
| --- | --- |
| scheduler.ts owns fetch, dedup by URL | 1 |
| scheduler backoff on 429/503, Retry-After | 2 |
| scheduler replaces ratelimit.ts, three callers updated | 3 |
| per-credential live expiry in secrets | 4 |
| auth status shows live access-token TTL, refresh window `unknown` | 5, surfaced in 8 |
| login (headed, saves session), logout (clears three files incl. identity cache) | 6 |
| identity cache path defined and cleared on login/logout | 6 |
| render: table, json, redaction by default in both, --raw opt-out | 7 |
| RUNTIME_FILES gains scheduler/session/render, drops ratelimit; both test lists updated | 8 |
| `runLifecycle` in lib/session.ts (not a separate entry) so imports resolve in both layouts | 6/Step 4, wired in 8 |
| manifest path resolved with `fileURLToPath`, not percent-encoded `.pathname` | 8 |
| orphaned `tests/ratelimit.test.ts` deleted with the module | 3 |
| generated client works with NO commands.json (0.6.0 back-compat) | 8 |
| lifecycle commands dispatched before endpoint/task commands | 8 |
| live smoke; no version bump | 9 |

**Deferred to Plan B, by design:** `whoami`, `@me` and the param-token resolver, `commands.json` schema/validator/modes, join planning with `onError`, the drift report, task-command codegen, and the version cut to the next release.

## Open risks carried into execution

1. **Scheduler dedup lifetime.** The cache lives for the scheduler instance. `call.ts` and each generated command construct a fresh scheduler per invocation, so dedup is per-run as intended. If a future long-lived process reuses one scheduler across unrelated commands, stale reads are possible — out of scope here, noted.
2. **`waitForURL` heuristic in `login`.** The default launcher decides "signed in" by the URL leaving identity-looking hosts. A site whose post-login URL still contains `auth` would mis-time. The launcher is injectable and the live smoke test is the check; if it mistimes on the real site, tighten the predicate there rather than guessing now.
3. **`runLifecycle` lives in `lib/session.ts`, not a separate entry file.** This was a deliberate fix for a layout trap: `lib/` files use `./`-relative imports that resolve identically in the skill's `src/` and the generated `<outRoot>/lib/`, whereas a `<site>/session.ts` copied verbatim would break. The subprocess test in Task 8 Step 5 (`auth status` with no `commands.json`) is the check that the wiring resolves; do not assume it.
