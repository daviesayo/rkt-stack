# derive-client Plan 2: Auth Analysis and the Direct Transport

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the manifest's `auth` field by analyzing the recorded HAR, store the credential outside the repo, and ship a `call` subcommand that replays any derived **read** endpoint with working authentication.

**Architecture:** Three pure analysis passes over `HarEntry[]` (credential detection, mint-point tracing, expiry detection) produce an `AuthSpec` that replaces Plan 1's `auth: null` seam. A separate extraction step writes the actual secret values to `<rkt-root>/secrets/<site>.json` at mode `0600`, never into the repo and never into logs. A runtime transport applies the credential, the pinned User-Agent and client hints, and human-shaped rate limiting to outbound requests. A `call` subcommand ties it together so the plan ends with something you can actually run.

**Tech Stack:** Bun 1.3.11, TypeScript, `bun test`. No new dependencies. Reuses `lib/har`, `lib/manifest`, `lib/paths` from Plan 1.

**Source spec:** `docs/specs/2026-07-20-derive-client-skill-design.md`
**Predecessor:** `docs/plans/2026-07-20-derive-client-recorder.md` (shipped as plugin 0.4.0)

## Scope change from the original sequence

The original five-plan split put code generation in Plan 3, which left this plan producing authenticated requests that nothing consumed. That failed the rule that each plan ends with working software.

Fixed here by adding Task 11, a `call` subcommand that invokes any manifest endpoint by id. It is one task, not a code generator, and it turns this plan's deliverable from "auth works internally" into "you can fetch your roster from the terminal." Plan 3 remains the full typed client generator; this is the thin manual path that proves auth end to end and stays useful afterward as a debugging tool.

## Defects in the shipped 0.4.0 code that this plan must fix

Blind review of this plan surfaced two problems in the **already-merged** Plan 1 code. They are fixed here because this plan is the first to build executable behavior on top of them.

1. **`filterEntries` never restricts HTTP method** (`src/lib/filter.ts`). The spec says read mode derives "Only GET and HEAD endpoints" (spec: Modes). Today any POST, PUT, PATCH, or DELETE that returned 2xx JSON during recording lands in `client.json`. Harmless while nothing could execute a manifest; **not** harmless once Task 11 ships a runner. Task 2 fixes it, and Task 11 adds a second refusal at call time.
2. **`bunx tsc --noEmit` fails** with `TS2688: Cannot find type definition file for 'bun-types'` — `tsconfig.json` sets `"types": ["bun-types"]` while `package.json` depends on `@types/bun`. No TypeScript in this project has ever been typechecked. Task 1 fixes the config and adds a typecheck to the test wrapper so this plan's ~400 new lines are actually checked.

## Carried-over review finding

Plan 1's review found that `scripts/tests/derive.test.ts` writes into the user's real `~/.rkt-clients/`, violating the AGENTS.md rule that tests use temp directories. Root cause: `rktRoot()` has no injection point. Task 1 fixes this before any new filesystem surface is added.

**The injection point must not weaken production.** `assertUnderRktRoot` is a containment control; if the root were freely settable by an environment variable, `RKT_CLIENTS_ROOT=/` would disable path confinement *and* redirect where 0600 secrets are written. Task 1 therefore honors the override **only when `NODE_ENV === "test"`**, which Bun sets automatically during `bun test` (verified on Bun 1.3.11) and which no production invocation sets.

## Global Constraints

Everything from Plan 1 still applies. Restated because a task implementer sees only their own task:

- Runtime artifacts live under the resolved rkt root only. Never write to a cwd-relative path (AGENTS.md "Runtime Paths").
- Skills resolve bundled files via `RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"`. Never reference `./scripts/`.
- All interactive prompts use `AskUserQuestion`. Never bash `read` (`decisions.md:64`).
- No machine-local home paths (`/Users/<name>`) hardcoded in any skill file.
- Safety and correctness checks key on **structure or shape, never on names** (CLAUDE.md: "a name-based check is a bypass").
- Plugin changes bump `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json` in lockstep, prepend a `plugins/rkt/CHANGELOG.md` entry, and pass `claude plugin validate plugins/rkt`. Current version is `0.4.0`; this plan ships **0.5.0**.
- Tests must be idempotent, use temp directories, and clean up.

**New constraints introduced by this plan, all non-negotiable:**

- **Read mode means GET and HEAD only.** No other method may reach the network from a derived manifest. Enforced at derivation (Task 2) and again at call time (Task 9, Task 11).
- **Secrets never touch the repo.** They live at `<rkt-root>/secrets/<site>.json`, mode `0600`, parent directory mode `0700`, written atomically so no window exists at a weaker mode.
- **Secrets never reach stdout, stderr, logs, or error messages.** Redaction happens **before** any truncation, so a secret straddling a slice boundary cannot leak a prefix.
- **Manifests stay secret-free.** `client.json` records *where* the credential lives, never its value. Enforced by a structural test (Task 12), not a grep for a field name.
- **`--dry-run` on `call` prints the built request with the credential redacted.**

---

## File Structure

**Created:**

- `scripts/src/lib/auth.ts` — credential detection, mint tracing, expiry detection, `AuthSpec` construction.
- `scripts/src/lib/secrets.ts` — atomic secret write/read, redaction helper.
- `scripts/src/lib/ratelimit.ts` — human-shaped pacing, concurrency 1.
- `scripts/src/lib/transport.ts` — build and issue an authenticated request.
- `scripts/src/call.ts` — `call` CLI.
- `scripts/tests/auth.test.ts`, `secrets.test.ts`, `ratelimit.test.ts`, `transport.test.ts`, `call.test.ts`, `leak.test.ts`
- `scripts/tests/fixtures/authed.har` — HAR fixture carrying cookie, bearer, CSRF, and a write request. Used by Tasks 2, 10, and 12.

**Modified:**

- `scripts/tsconfig.json` — fix the broken `types` entry.
- `scripts/src/lib/paths.ts` — test-only root injection, `secretsDir()`.
- `scripts/src/lib/filter.ts` — restrict to GET/HEAD in read mode.
- `scripts/src/lib/manifest.ts` — accept a populated `AuthSpec`.
- `scripts/src/derive.ts` — run the auth pass, write the secret.
- `scripts/tests/paths.test.ts`, `derive.test.ts`, `filter.test.ts`, `manifest.test.ts` — env isolation and new assertions.
- `plugins/rkt/skills/derive-client/SKILL.md` — root resolution, auth gate, `call` usage, secrets.
- `tests/test-derive-client.sh` — typecheck plus structural leak guard.
- `plugins/rkt/CHANGELOG.md`, both plugin manifests.

All paths above are relative to `plugins/rkt/skills/derive-client/` unless they start with `plugins/` or `tests/`.

---

## Task 1: Test-only root injection, and fix the broken typecheck

**Files:**
- Modify: `scripts/tsconfig.json`
- Modify: `scripts/src/lib/paths.ts`
- Modify: `scripts/tests/paths.test.ts`
- Modify: `scripts/tests/derive.test.ts`

**Interfaces:**
- Consumes: existing `rktRoot`, `assertUnderRktRoot`, `recordingDir`, `secretsFile`.
- Produces: `rktRoot()` honoring `RKT_CLIENTS_ROOT` **only under `NODE_ENV === "test"`**, plus `secretsDir(): string`.

- [ ] **Step 1: Fix the typecheck configuration**

In `scripts/tsconfig.json`, change `"types": ["bun-types"]` to:

```json
    "types": ["bun"],
```

Verify: `cd plugins/rkt/skills/derive-client/scripts && bunx tsc --noEmit`
Expected: no output (success). Before this change it fails with `TS2688: Cannot find type definition file for 'bun-types'`.

- [ ] **Step 2: Write the failing test**

Add to `tests/paths.test.ts`. The `beforeEach` matters: without it, a developer with `RKT_CLIENTS_ROOT` exported in their shell breaks the pre-existing `homedir()` assertions already in this file.

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rktRoot, secretsDir, secretsFile } from "../src/lib/paths";

const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.RKT_CLIENTS_ROOT;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV;
});

test("RKT_CLIENTS_ROOT overrides the root under NODE_ENV=test", () => {
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(rktRoot()).toBe("/tmp/rkt-test-root");
});

test("the override is IGNORED outside a test run", () => {
  process.env.NODE_ENV = "production";
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(rktRoot()).toMatch(/\/\.rkt-clients$/);
});

test("the override is ignored when NODE_ENV is unset", () => {
  delete process.env.NODE_ENV;
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(rktRoot()).toMatch(/\/\.rkt-clients$/);
});

test("an override is resolved to an absolute path", () => {
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root/../rkt-other";
  expect(rktRoot()).toBe("/tmp/rkt-other");
});

test("an empty override falls back to the home default", () => {
  process.env.RKT_CLIENTS_ROOT = "";
  expect(rktRoot()).toMatch(/\/\.rkt-clients$/);
});

test("derived paths follow the override", () => {
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(secretsDir()).toBe("/tmp/rkt-test-root/secrets");
  expect(secretsFile("alayacare")).toBe("/tmp/rkt-test-root/secrets/alayacare.json");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/paths.test.ts`
Expected: FAIL — `rktRoot()` ignores the env var and returns the home path.

- [ ] **Step 4: Write the implementation**

Replace the top of `src/lib/paths.ts`:

```ts
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Root for all runtime artifacts.
 *
 * RKT_CLIENTS_ROOT exists so tests can redirect the whole filesystem surface
 * to a temp directory. It is honored ONLY under NODE_ENV=test, which Bun sets
 * during `bun test`. Production must never be able to move this root: it is
 * both the confinement boundary enforced by assertUnderRktRoot and the
 * location of 0600 credential files.
 */
export function rktRoot(): string {
  if (process.env.NODE_ENV === "test") {
    const override = process.env.RKT_CLIENTS_ROOT;
    if (override && override.length > 0) return resolve(override);
  }
  return `${homedir()}/.rkt-clients`;
}

export function secretsDir(): string {
  return `${rktRoot()}/secrets`;
}
```

Keep `assertUnderRktRoot`, `sanitizeSite`, `profileDir`, `lockFile`, `recordingDir`, and `secretsFile` unchanged; they call `rktRoot()` and inherit the behavior.

- [ ] **Step 5: Migrate `derive.test.ts` off the real home directory**

`tests/derive.test.ts` currently begins:

```ts
import { afterAll, expect, test } from "bun:test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { deriveManifest } from "../src/derive";
import { recordingDir, rktRoot } from "../src/lib/paths";
```

Replace everything from that first import down to the end of the existing `stageFixture` function with the block below. **Keep the `deriveManifest` import** — every test body in the file calls it, and dropping it produces a `ReferenceError` in all six.

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveManifest } from "../src/derive";
import { recordingDir } from "../src/lib/paths";

let testRoot: string;
const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;
let stagingCounter = 0;

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "rkt-derive-"));
  process.env.RKT_CLIENTS_ROOT = testRoot;
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  await rm(testRoot, { recursive: true, force: true });
});

async function stageFixture(name: string): Promise<string> {
  const ts = `test${++stagingCounter}`;
  const dir = recordingDir("derive-test", ts);
  await mkdir(dir, { recursive: true });
  const dest = `${dir}/session.har`;
  await copyFile(`${import.meta.dir}/fixtures/${name}`, dest);
  return dest;
}
```

`recordingDir` is called inside `stageFixture`, after `beforeAll` has set the env var, and `rktRoot()` reads `process.env` at call time, so a plain static import is correct. Leave the individual test bodies unchanged.

- [ ] **Step 6: Verify tests pass and no longer touch the real home**

```bash
cd plugins/rkt/skills/derive-client/scripts
rm -rf ~/.rkt-clients/recordings/derive-test
bun test
bunx tsc --noEmit
test ! -d ~/.rkt-clients/recordings/derive-test && echo "real home untouched"
```

Expected: all 58 pre-existing tests plus the 6 new ones pass, `tsc` is silent, then `real home untouched`.

- [ ] **Step 7: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/tsconfig.json plugins/rkt/skills/derive-client/scripts/src/lib/paths.ts plugins/rkt/skills/derive-client/scripts/tests/paths.test.ts plugins/rkt/skills/derive-client/scripts/tests/derive.test.ts
git commit -m "fix(derive-client): add test-only root injection and repair typecheck"
```

---

## Task 2: Restrict read mode to GET and HEAD

**Files:**
- Modify: `scripts/src/lib/filter.ts`
- Modify: `scripts/tests/filter.test.ts`
- Create: `scripts/tests/fixtures/authed.har`

**Interfaces:**
- Consumes: `HarEntry`.
- Produces: `filterEntries(entries: HarEntry[], options?: { allowWrites?: boolean }): FilterResult`. Default `allowWrites: false` drops every non-GET/HEAD request with a stated reason. `FilterResult` and `DropRecord` are unchanged, so `derive.ts` keeps compiling.

This closes the shipped 0.4.0 defect described above. Without it, Task 11's runner could issue a recorded DELETE against a live account.

- [ ] **Step 1: Create the shared fixture**

`tests/fixtures/authed.har` — used here and by Tasks 10 and 12:

```json
{
  "log": {
    "version": "1.2",
    "creator": { "name": "playwright", "version": "1.56.0" },
    "entries": [
      {
        "startedDateTime": "2026-07-20T12:00:00.000Z",
        "request": {
          "method": "POST",
          "url": "https://auth.test/login",
          "headers": [{ "name": "user-agent", "value": "Mozilla/5.0 Chrome/141.0.0.0" }]
        },
        "response": {
          "status": 200,
          "headers": [
            { "name": "content-type", "value": "application/json" },
            { "name": "set-cookie", "value": "sessionid=SUPERSECRETVALUE; Path=/; Max-Age=3600" }
          ],
          "content": { "mimeType": "application/json", "text": "{\"ok\":true}" }
        }
      },
      {
        "startedDateTime": "2026-07-20T12:00:05.000Z",
        "request": {
          "method": "GET",
          "url": "https://auth.test/api/roster/4821",
          "headers": [
            { "name": "user-agent", "value": "Mozilla/5.0 Chrome/141.0.0.0" },
            { "name": "cookie", "value": "sessionid=SUPERSECRETVALUE; theme=dark" },
            { "name": "x-requested-with", "value": "XMLHttpRequest" }
          ]
        },
        "response": {
          "status": 200,
          "headers": [{ "name": "content-type", "value": "application/json" }],
          "content": { "mimeType": "application/json", "text": "{\"shifts\":[{\"id\":1}]}" }
        }
      },
      {
        "startedDateTime": "2026-07-20T12:00:09.000Z",
        "request": {
          "method": "DELETE",
          "url": "https://auth.test/api/shift/99",
          "headers": [
            { "name": "user-agent", "value": "Mozilla/5.0 Chrome/141.0.0.0" },
            { "name": "cookie", "value": "sessionid=SUPERSECRETVALUE" }
          ]
        },
        "response": {
          "status": 200,
          "headers": [{ "name": "content-type", "value": "application/json" }],
          "content": { "mimeType": "application/json", "text": "{\"deleted\":true}" }
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing test**

Append to `tests/filter.test.ts` (the file already defines an `entry` helper taking `Partial<HarEntry>`):

```ts
test("read mode drops write methods", () => {
  const { kept, dropped } = filterEntries([
    entry({ method: "GET" }),
    entry({ method: "POST" }),
    entry({ method: "PUT" }),
    entry({ method: "PATCH" }),
    entry({ method: "DELETE" }),
  ]);
  expect(kept).toHaveLength(1);
  expect(kept[0].method).toBe("GET");
  expect(dropped).toHaveLength(4);
  expect(dropped[0].reason).toMatch(/write method/i);
});

test("read mode keeps HEAD", () => {
  const { kept } = filterEntries([entry({ method: "HEAD" })]);
  expect(kept).toHaveLength(1);
});

test("method matching is case-insensitive", () => {
  const { kept } = filterEntries([entry({ method: "get" })]);
  expect(kept).toHaveLength(1);
});

test("allowWrites keeps write methods for full mode", () => {
  const { kept } = filterEntries(
    [entry({ method: "GET" }), entry({ method: "DELETE" })],
    { allowWrites: true },
  );
  expect(kept).toHaveLength(2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/filter.test.ts`
Expected: FAIL — the first test finds 5 kept entries, not 1.

- [ ] **Step 4: Write the implementation**

In `src/lib/filter.ts`, add above `filterEntries`:

```ts
const READ_METHODS = new Set(["GET", "HEAD"]);

export interface FilterOptions {
  /** Full mode only. Read mode never derives endpoints that mutate state. */
  allowWrites?: boolean;
}
```

Change the signature and add the check as the **first** rejection, before the URL parse:

```ts
export function filterEntries(
  entries: HarEntry[],
  options: FilterOptions = {},
): FilterResult {
  const kept: HarEntry[] = [];
  const dropped: DropRecord[] = [];

  for (const e of entries) {
    if (!options.allowWrites && !READ_METHODS.has(e.method.toUpperCase())) {
      dropped.push({
        url: e.url,
        reason: `write method (${e.method}); read mode derives GET and HEAD only`,
      });
      continue;
    }
    // ... existing host / mime / status / body checks unchanged
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS. The full suite stays green: Plan 1's filter fixtures all use GET.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/filter.ts plugins/rkt/skills/derive-client/scripts/tests/filter.test.ts plugins/rkt/skills/derive-client/scripts/tests/fixtures/authed.har
git commit -m "fix(derive-client): restrict read mode to GET and HEAD"
```

---

## Task 3: Credential detection

**Files:**
- Create: `scripts/src/lib/auth.ts`
- Create: `scripts/tests/auth.test.ts`

**Interfaces:**
- Consumes: `HarEntry` from `lib/har`.
- Produces: `detectCredentials(entries: HarEntry[]): CredentialCandidate[]`:

```ts
export interface CredentialCandidate {
  kind: "cookie" | "bearer" | "csrf";
  /** Header name, or "cookie:<name>" for a specific cookie. */
  location: string;
  /** Fraction of requests carrying this credential, 0 to 1. */
  coverage: number;
  /** The observed value. Never written to a manifest. */
  value: string;
}
```

Sorted by coverage descending. **Known non-secrets are never treated as credentials.** `x-requested-with: XMLHttpRequest` appears on nearly every XHR, so it would win on coverage and be persisted as the site's "secret" — and `redact` would then mask the word "XMLHttpRequest" everywhere while the real credential leaked.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { detectCredentials } from "../src/lib/auth";

function entry(requestHeaders: Record<string, string>, url = "https://x.test/api/a"): HarEntry {
  return {
    method: "GET",
    url,
    status: 200,
    requestHeaders,
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: "{}",
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

test("detects a bearer token in the authorization header", () => {
  const found = detectCredentials([entry({ authorization: "Bearer abc.def.ghi" })]);
  expect(found[0]).toMatchObject({
    kind: "bearer",
    location: "authorization",
    value: "Bearer abc.def.ghi",
  });
});

test("detects a session cookie by name", () => {
  const found = detectCredentials([
    entry({ cookie: "theme=dark; sessionid=s3cr3tvalue; lang=en" }),
    entry({ cookie: "theme=dark; sessionid=s3cr3tvalue; lang=en" }),
  ]);
  const session = found.find((c) => c.location === "cookie:sessionid");
  expect(session).toMatchObject({ kind: "cookie", value: "s3cr3tvalue" });
});

test("ignores cookies that look like preferences", () => {
  const found = detectCredentials([entry({ cookie: "theme=dark; lang=en" })]);
  expect(found).toHaveLength(0);
});

test("detects a CSRF header", () => {
  const found = detectCredentials([entry({ "x-csrf-token": "tok123456" })]);
  expect(found[0]).toMatchObject({ kind: "csrf", location: "x-csrf-token", value: "tok123456" });
});

test("never treats x-requested-with as a credential", () => {
  const found = detectCredentials([
    entry({ "x-requested-with": "XMLHttpRequest" }),
    entry({ "x-requested-with": "XMLHttpRequest" }),
  ]);
  expect(found).toHaveLength(0);
});

test("rejects known non-secret constants even in a credential-shaped header", () => {
  const found = detectCredentials([entry({ "x-csrf-token": "undefined" })]);
  expect(found).toHaveLength(0);
});

test("rejects values too short to be a credential", () => {
  const found = detectCredentials([entry({ cookie: "sessionid=1" })]);
  expect(found).toHaveLength(0);
});

test("coverage reflects how many requests carry the credential", () => {
  const found = detectCredentials([
    entry({ authorization: "Bearer aaaaaaaa" }),
    entry({ authorization: "Bearer aaaaaaaa" }),
    entry({}),
    entry({}),
  ]);
  expect(found[0].coverage).toBeCloseTo(0.5);
});

test("results are sorted by coverage descending", () => {
  const found = detectCredentials([
    entry({ authorization: "Bearer aaaaaaaa", "x-csrf-token": "tok123456" }),
    entry({ authorization: "Bearer aaaaaaaa" }),
    entry({ authorization: "Bearer aaaaaaaa" }),
  ]);
  expect(found[0].kind).toBe("bearer");
  expect(found[0].coverage).toBeGreaterThan(found[1].coverage);
});

test("returns nothing when no credential material is present", () => {
  expect(detectCredentials([entry({ accept: "application/json" })])).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: FAIL at module resolution — Bun cannot resolve `../src/lib/auth`.

- [ ] **Step 3: Write the implementation**

```ts
import type { HarEntry } from "./har";

export interface CredentialCandidate {
  kind: "cookie" | "bearer" | "csrf";
  location: string;
  coverage: number;
  value: string;
}

/** Cookie names that look like session credentials rather than preferences. */
const SESSION_COOKIE = /sess|auth|token|sid|jwt|login|identity|csrf|xsrf/i;

/**
 * Headers that carry a CSRF token. x-requested-with is deliberately excluded:
 * its value is the constant "XMLHttpRequest", so it would win on coverage and
 * be persisted as the site's "secret".
 */
const CSRF_HEADER = /^x-(csrf|xsrf)-token$/i;

/** Values that are structurally credential-shaped but carry no secret. */
const NON_SECRET_VALUES = new Set([
  "xmlhttprequest",
  "undefined",
  "null",
  "true",
  "false",
  "none",
  "0",
  "1",
]);

/** Shorter than this cannot be a meaningful credential, and short values
 *  produce false positives when substring-matched against response bodies. */
export const MIN_SECRET_LENGTH = 8;

function isPlausibleSecret(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (NON_SECRET_VALUES.has(value.toLowerCase())) return false;
  return true;
}

function parseCookies(header: string): Array<[string, string]> {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1
        ? ([part, ""] as [string, string])
        : ([part.slice(0, eq), part.slice(eq + 1)] as [string, string]);
    });
}

export function detectCredentials(entries: HarEntry[]): CredentialCandidate[] {
  const total = entries.length;
  if (total === 0) return [];

  const seen = new Map<
    string,
    { kind: CredentialCandidate["kind"]; value: string; count: number }
  >();

  const bump = (location: string, kind: CredentialCandidate["kind"], value: string) => {
    const existing = seen.get(location);
    if (existing) existing.count += 1;
    else seen.set(location, { kind, value, count: 1 });
  };

  for (const e of entries) {
    const auth = e.requestHeaders["authorization"];
    if (auth && /^bearer\s+\S+/i.test(auth)) {
      if (isPlausibleSecret(auth.replace(/^bearer\s+/i, ""))) {
        bump("authorization", "bearer", auth);
      }
    }

    const cookie = e.requestHeaders["cookie"];
    if (cookie) {
      for (const [name, value] of parseCookies(cookie)) {
        if (SESSION_COOKIE.test(name) && isPlausibleSecret(value)) {
          bump(`cookie:${name}`, "cookie", value);
        }
      }
    }

    for (const [name, value] of Object.entries(e.requestHeaders)) {
      if (CSRF_HEADER.test(name) && isPlausibleSecret(value)) {
        bump(name, "csrf", value);
      }
    }
  }

  return [...seen.entries()]
    .map(([location, v]) => ({ kind: v.kind, location, coverage: v.count / total, value: v.value }))
    .sort((a, b) => b.coverage - a.coverage);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts
git commit -m "feat(derive-client): detect credential candidates in recorded traffic"
```

---

## Task 4: Mint-point tracing

**Files:**
- Modify: `scripts/src/lib/auth.ts`
- Modify: `scripts/tests/auth.test.ts`

**Interfaces:**
- Produces: `traceMintPoint(candidate, entries): string | null` — the URL of the response that produced the credential, or `null` when it predates the recording (the normal case for a pre-authenticated profile, and not a failure).

- [ ] **Step 1: Write the failing test**

Append to `tests/auth.test.ts`:

```ts
import { traceMintPoint } from "../src/lib/auth";

function respEntry(
  url: string,
  responseHeaders: Record<string, string>,
  responseBody: string | null = null,
): HarEntry {
  return {
    method: "POST",
    url,
    status: 200,
    requestHeaders: {},
    responseHeaders,
    mimeType: "application/json",
    responseBody,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

test("traces a cookie to the response that set it", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sessionid",
    coverage: 1,
    value: "s3cr3tvalue",
  };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/login", { "set-cookie": "sessionid=s3cr3tvalue; Path=/; HttpOnly" }),
    entry({ cookie: "sessionid=s3cr3tvalue" }),
  ]);
  expect(mint).toBe("https://x.test/login");
});

test("traces a bearer token to the response body that returned it", () => {
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: "Bearer abc.def.ghi",
  };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/oauth/token", {}, '{"access_token":"abc.def.ghi","token_type":"Bearer"}'),
    entry({ authorization: "Bearer abc.def.ghi" }),
  ]);
  expect(mint).toBe("https://x.test/oauth/token");
});

test("returns null when the credential predates the recording", () => {
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: "Bearer abc.def.ghi",
  };
  expect(traceMintPoint(candidate, [entry({ authorization: "Bearer abc.def.ghi" })])).toBeNull();
});

test("matches a set-cookie with attributes and surrounding cookies", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sid",
    coverage: 1,
    value: "xyzxyzxyz",
  };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/auth", { "set-cookie": "other=1, sid=xyzxyzxyz; Secure; SameSite=Lax" }),
  ]);
  expect(mint).toBe("https://x.test/auth");
});

test("does not body-match a secret shorter than the safety floor", () => {
  const candidate = { kind: "cookie" as const, location: "cookie:sid", coverage: 1, value: "abc" };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/unrelated", {}, "the alphabet starts abc and continues"),
  ]);
  expect(mint).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: FAIL at import — Bun reports that `../src/lib/auth` does not provide an export named `traceMintPoint`.

- [ ] **Step 3: Append the implementation to `lib/auth.ts`**

```ts
/**
 * Find the response that produced this credential. Returns null when the
 * credential was already present when recording began, which is normal for a
 * profile authenticated in an earlier session.
 */
export function traceMintPoint(
  candidate: CredentialCandidate,
  entries: HarEntry[],
): string | null {
  const secret = candidate.kind === "bearer"
    ? candidate.value.replace(/^bearer\s+/i, "")
    : candidate.value;
  if (secret.length === 0) return null;

  const cookieName = candidate.location.startsWith("cookie:")
    ? candidate.location.slice("cookie:".length)
    : null;

  for (const e of entries) {
    if (cookieName) {
      const setCookie = e.responseHeaders["set-cookie"];
      if (setCookie) {
        const pattern = new RegExp(
          `(^|[,;\\s])${escapeRegExp(cookieName)}=${escapeRegExp(secret)}(;|,|\\s|$)`,
        );
        if (pattern.test(setCookie)) return e.url;
      }
    }
    // Substring matching is only safe for values long enough to be unlikely
    // to occur incidentally in an unrelated response body.
    if (
      secret.length >= MIN_SECRET_LENGTH &&
      e.responseBody &&
      e.responseBody.includes(secret)
    ) {
      return e.url;
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts
git commit -m "feat(derive-client): trace where credentials are minted"
```

---

## Task 5: Expiry detection

**Files:**
- Modify: `scripts/src/lib/auth.ts`
- Modify: `scripts/tests/auth.test.ts`

**Interfaces:**
- Produces: `detectExpiry(candidate, entries): string | null` — an ISO 8601 timestamp, or `null` when nothing is discoverable. A JWT `exp` claim wins; otherwise cookie `Max-Age`, then `Expires`.

- [ ] **Step 1: Write the failing test**

Append to `tests/auth.test.ts`:

```ts
import { detectExpiry } from "../src/lib/auth";

/** Build an unsigned JWT with the given payload. The signature is irrelevant here. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

test("reads the exp claim from a JWT bearer token", () => {
  const exp = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: `Bearer ${jwt({ exp })}`,
  };
  expect(detectExpiry(candidate, [])).toBe("2026-08-01T00:00:00.000Z");
});

test("reads Expires from the matching set-cookie", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sid",
    coverage: 1,
    value: "xyzxyzxyz",
  };
  const mint = respEntry("https://x.test/auth", {
    "set-cookie": "sid=xyzxyzxyz; Expires=Sat, 01 Aug 2026 00:00:00 GMT; Path=/",
  });
  expect(detectExpiry(candidate, [mint])).toBe("2026-08-01T00:00:00.000Z");
});

test("computes expiry from Max-Age relative to the response time", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sid",
    coverage: 1,
    value: "xyzxyzxyz",
  };
  const mint: HarEntry = {
    ...respEntry("https://x.test/auth", { "set-cookie": "sid=xyzxyzxyz; Max-Age=3600" }),
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
  expect(detectExpiry(candidate, [mint])).toBe("2026-07-20T13:00:00.000Z");
});

test("returns null for an opaque token with no expiry signal", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sid",
    coverage: 1,
    value: "opaquevalue",
  };
  expect(detectExpiry(candidate, [])).toBeNull();
});

test("returns null rather than throwing on a malformed JWT", () => {
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: "Bearer not.a.realjwt",
  };
  expect(detectExpiry(candidate, [])).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: FAIL at import — no export named `detectExpiry`.

- [ ] **Step 3: Append the implementation to `lib/auth.ts`**

```ts
/**
 * Best-effort expiry, as an ISO timestamp. A JWT exp claim wins; otherwise
 * fall back to cookie attributes. Null means "not discoverable", not an error.
 */
export function detectExpiry(
  candidate: CredentialCandidate,
  entries: HarEntry[],
): string | null {
  const secret = candidate.kind === "bearer"
    ? candidate.value.replace(/^bearer\s+/i, "")
    : candidate.value;

  const fromJwt = jwtExpiry(secret);
  if (fromJwt) return fromJwt;

  const cookieName = candidate.location.startsWith("cookie:")
    ? candidate.location.slice("cookie:".length)
    : null;
  if (!cookieName) return null;

  for (const e of entries) {
    const setCookie = e.responseHeaders["set-cookie"];
    if (!setCookie) continue;
    if (
      !new RegExp(`(^|[,;\\s])${escapeRegExp(cookieName)}=${escapeRegExp(secret)}`).test(setCookie)
    ) {
      continue;
    }

    const maxAge = setCookie.match(/Max-Age=(\d+)/i);
    if (maxAge) {
      const base = Date.parse(e.startedDateTime);
      if (Number.isFinite(base)) {
        return new Date(base + Number(maxAge[1]) * 1000).toISOString();
      }
    }

    const expires = setCookie.match(/Expires=([^;,]+(?:,[^;]+)?)/i);
    if (expires) {
      const parsed = Date.parse(expires[1].trim());
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return null;
}

function jwtExpiry(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload?.exp !== "number") return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts
git commit -m "feat(derive-client): detect credential expiry from JWT and cookie attributes"
```

---

## Task 6: AuthSpec in the manifest

**Files:**
- Modify: `scripts/src/lib/auth.ts`
- Modify: `scripts/src/lib/manifest.ts`
- Modify: `scripts/tests/manifest.test.ts`

**Interfaces:**
- Produces: `analyzeAuth(entries): { spec: AuthSpec | null; value: string | null }`. The `spec` goes into the manifest; the `value` goes to the secrets file and never into the manifest. `buildManifest` gains an optional `auth` input, replacing the hardcoded `auth: null` at `manifest.ts:96`.

The split return type is what keeps secrets out of `client.json`: the two travel in opposite directions from one call, by construction rather than by discipline.

- [ ] **Step 1: Write the failing test**

Append to `tests/manifest.test.ts`. The leak assertion runs a real credential through `analyzeAuth`, so it cannot pass vacuously:

```ts
import { analyzeAuth } from "../src/lib/auth";
import type { HarEntry } from "../src/lib/har";

const authedEntries: HarEntry[] = [
  {
    method: "GET",
    url: "https://x.test/api/roster/4821",
    status: 200,
    requestHeaders: {
      authorization: "Bearer abc.def.ghijkl",
      "user-agent": "Mozilla/5.0 Chrome/141.0.0.0",
    },
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: '{"shifts":[]}',
    startedDateTime: "2026-07-20T12:00:00.000Z",
  },
];

test("analyzeAuth returns a spec and the value separately", () => {
  const { spec, value } = analyzeAuth(authedEntries);
  expect(spec).toMatchObject({ kind: "bearer", location: "authorization" });
  expect(value).toBe("Bearer abc.def.ghijkl");
});

test("analyzeAuth returns nulls when no credential is present", () => {
  const { spec, value } = analyzeAuth([]);
  expect(spec).toBeNull();
  expect(value).toBeNull();
});

test("a manifest built from real analysis never contains the secret", () => {
  const { spec, value } = analyzeAuth(authedEntries);
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
    auth: spec,
  });
  expect(m.auth).toMatchObject({ kind: "bearer", location: "authorization" });
  expect(value).not.toBeNull();
  expect(JSON.stringify(m)).not.toContain(value!);
  expect(JSON.stringify(m)).not.toContain("abc.def.ghijkl");
});

test("auth remains null when the analysis found nothing", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.auth).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/manifest.test.ts`
Expected: FAIL at import — no export named `analyzeAuth`.

- [ ] **Step 3: Append `analyzeAuth` to `lib/auth.ts`**

```ts
import type { AuthSpec } from "./manifest";

/**
 * Run all three passes and split the result: the spec is manifest-safe, the
 * value is secret. Callers must never merge them.
 */
export function analyzeAuth(
  entries: HarEntry[],
): { spec: AuthSpec | null; value: string | null } {
  const primary = detectCredentials(entries)[0];
  if (!primary) return { spec: null, value: null };

  return {
    spec: {
      kind: primary.kind,
      location: primary.location,
      mintedBy: traceMintPoint(primary, entries),
      expiry: detectExpiry(primary, entries),
    },
    value: primary.value,
  };
}
```

- [ ] **Step 4: Accept an auth spec in `buildManifest`**

In `src/lib/manifest.ts`, add `auth?: AuthSpec | null;` to `BuildManifestInput`, and change the returned object's `auth: null` to `auth: input.auth ?? null,`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts plugins/rkt/skills/derive-client/scripts/src/lib/manifest.ts plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts
git commit -m "feat(derive-client): populate manifest auth spec without leaking secrets"
```

---

## Task 7: Atomic secrets storage and redaction

**Files:**
- Create: `scripts/src/lib/secrets.ts`
- Create: `scripts/tests/secrets.test.ts`

**Interfaces:**
- Produces: `writeSecret(site, value): Promise<void>`, `readSecret(site): Promise<string | null>`, `redact(text, secret): string`.

**Why atomic:** `writeFile(path, data, { mode })` applies the mode **only when creating** the file. Overwriting an existing 0644 file leaves it 0644 until a follow-up `chmod` — verified on Bun 1.3.11 under umask 022, where the file read back as mode `644` before the chmod landed. During that window the credential is world-readable. Writing a fresh 0600 temp file and `rename`-ing it into place closes the window: `rename` is atomic and preserves the source's mode.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecret, redact, writeSecret } from "../src/lib/secrets";

let testRoot: string;
const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "rkt-secrets-"));
  process.env.RKT_CLIENTS_ROOT = testRoot;
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  await rm(testRoot, { recursive: true, force: true });
});

test("round-trips a secret", async () => {
  await writeSecret("example", "Bearer abc.def");
  expect(await readSecret("example")).toBe("Bearer abc.def");
});

test("the secrets file is mode 0600", async () => {
  await writeSecret("example", "s3cr3tvalue");
  const info = await stat(`${testRoot}/secrets/example.json`);
  expect(info.mode & 0o777).toBe(0o600);
});

test("the secrets directory is mode 0700", async () => {
  await writeSecret("example", "s3cr3tvalue");
  const info = await stat(`${testRoot}/secrets`);
  expect(info.mode & 0o777).toBe(0o700);
});

test("reading an unknown site returns null rather than throwing", async () => {
  expect(await readSecret("never-written")).toBeNull();
});

test("overwriting a world-readable file never leaves it world-readable", async () => {
  // Simulate a pre-existing loose-permission file: the case a plain
  // writeFile({mode}) silently fails to tighten.
  const path = `${testRoot}/secrets/loose.json`;
  await writeSecret("loose", "firstvalue");
  await chmod(path, 0o644);

  await writeSecret("loose", "secondvalue");
  const info = await stat(path);
  expect(info.mode & 0o777).toBe(0o600);
  expect(await readSecret("loose")).toBe("secondvalue");
});

test("no temp file is left behind after a write", async () => {
  await writeSecret("example", "s3cr3tvalue");
  const files = await readdir(`${testRoot}/secrets`);
  expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
});

test("redact replaces every occurrence of the secret", () => {
  expect(redact("token=s3cr3t and again s3cr3t", "s3cr3t")).toBe(
    "token=[REDACTED] and again [REDACTED]",
  );
});

test("redact is a no-op when there is no secret", () => {
  expect(redact("nothing sensitive", null)).toBe("nothing sensitive");
});

test("redact also masks the bare token inside a scheme-prefixed value", () => {
  expect(redact("Authorization: Bearer abc.def", "Bearer abc.def")).toBe(
    "Authorization: [REDACTED]",
  );
  expect(redact("raw abc.def leaked", "Bearer abc.def")).toBe("raw [REDACTED] leaked");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/secrets.test.ts`
Expected: FAIL at module resolution for `../src/lib/secrets`.

- [ ] **Step 3: Write the implementation**

```ts
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { secretsDir, secretsFile } from "./paths";

interface SecretBody {
  value: string;
  storedAt: string;
}

/**
 * Write the credential atomically at 0600.
 *
 * writeFile's mode option applies only when creating a new file, so
 * overwriting an existing loose-permission file would expose the credential
 * until a follow-up chmod. Writing a fresh 0600 temp file and renaming it
 * into place closes that window: rename is atomic and keeps the source mode.
 */
export async function writeSecret(site: string, value: string): Promise<void> {
  const dir = secretsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir ignores mode when the directory already exists.
  await chmod(dir, 0o700);

  const finalPath = secretsFile(site);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const body: SecretBody = { value, storedAt: new Date().toISOString() };

  try {
    await writeFile(tmpPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, finalPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

export async function readSecret(site: string): Promise<string | null> {
  try {
    const body = JSON.parse(await readFile(secretsFile(site), "utf8")) as SecretBody;
    return typeof body.value === "string" ? body.value : null;
  } catch {
    return null;
  }
}

/**
 * Mask a secret in text bound for a terminal or log. Masks both the stored
 * value and its bare token, since "Bearer abc" is stored whole while "abc"
 * may appear alone elsewhere.
 *
 * Callers must redact BEFORE truncating: redacting after a slice can emit a
 * partial secret that no longer matches.
 */
export function redact(text: string, secret: string | null): string {
  if (!secret || secret.length === 0) return text;

  const bare = secret.replace(/^bearer\s+/i, "");
  let out = text.split(secret).join("[REDACTED]");
  if (bare !== secret && bare.length > 0) {
    out = out.split(bare).join("[REDACTED]");
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/secrets.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/secrets.ts plugins/rkt/skills/derive-client/scripts/tests/secrets.test.ts
git commit -m "feat(derive-client): store credentials atomically at 0600 with redaction"
```

---

## Task 8: Human-shaped rate limiter

**Files:**
- Create: `scripts/src/lib/ratelimit.ts`
- Create: `scripts/tests/ratelimit.test.ts`

**Interfaces:**
- Produces: `createLimiter(options?: { minDelayMs?: number; maxDelayMs?: number }): <T>(fn: () => Promise<T>) => Promise<T>`. Defaults 400 to 1300 ms, concurrency 1.

**Honest scope note:** this limiter paces *successive* calls within one process. `call` (Task 11) issues a single request per invocation, so the limiter does not throttle it — the first call is deliberately not delayed, since adding latency to a one-shot command buys nothing. The limiter exists because Plan 3's generated clients issue many requests in a loop, which is where the spec's human-shaped-traffic requirement actually bites. The requirement map records this rather than claiming the requirement is fully met here.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createLimiter } from "../src/lib/ratelimit";

test("runs tasks and returns their values", async () => {
  const limit = createLimiter({ minDelayMs: 0, maxDelayMs: 0 });
  expect(await limit(async () => 42)).toBe(42);
});

test("serializes concurrent calls: never two at once", async () => {
  const limit = createLimiter({ minDelayMs: 0, maxDelayMs: 0 });
  let active = 0;
  let maxActive = 0;

  await Promise.all(
    Array.from({ length: 5 }, () =>
      limit(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    ),
  );

  expect(maxActive).toBe(1);
});

test("spaces successive calls by roughly the minimum delay", async () => {
  const limit = createLimiter({ minDelayMs: 40, maxDelayMs: 45 });
  const start = Date.now();
  await limit(async () => null);
  await limit(async () => null);
  await limit(async () => null);
  // Three calls means two inter-call gaps. Allow 5ms of timer slop so this is
  // not flaky when setTimeout fires a hair early.
  expect(Date.now() - start).toBeGreaterThanOrEqual(75);
});

test("preserves call order", async () => {
  const limit = createLimiter({ minDelayMs: 0, maxDelayMs: 0 });
  const seen: number[] = [];
  await Promise.all([1, 2, 3].map((n) => limit(async () => { seen.push(n); })));
  expect(seen).toEqual([1, 2, 3]);
});

test("a rejected task does not wedge the queue", async () => {
  const limit = createLimiter({ minDelayMs: 0, maxDelayMs: 0 });
  await expect(limit(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(await limit(async () => "still works")).toBe("still works");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/ratelimit.test.ts`
Expected: FAIL at module resolution for `../src/lib/ratelimit`.

- [ ] **Step 3: Write the implementation**

```ts
export interface LimiterOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Serialize calls and space them by a randomized delay, so automated traffic
 * keeps a human shape. Concurrency is fixed at 1 by design: this is a
 * politeness guardrail, not a throughput knob.
 *
 * The first call is not delayed; pacing applies between successive calls.
 */
export function createLimiter(options: LimiterOptions = {}) {
  const min = options.minDelayMs ?? 400;
  const max = Math.max(options.maxDelayMs ?? 1300, min);

  let tail: Promise<unknown> = Promise.resolve();
  let first = true;

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      if (first) {
        first = false;
      } else {
        const delay = min + Math.floor(Math.random() * (max - min + 1));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      return fn();
    });

    // Keep the chain alive even when a task rejects.
    tail = run.catch(() => undefined);
    return run;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/ratelimit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/ratelimit.ts plugins/rkt/skills/derive-client/scripts/tests/ratelimit.test.ts
git commit -m "feat(derive-client): add human-shaped rate limiter"
```

---

## Task 9: Direct transport

**Files:**
- Create: `scripts/src/lib/transport.ts`
- Create: `scripts/tests/transport.test.ts`

**Interfaces:**
- Produces: `buildRequest(manifest, endpoint, params, secret): BuiltRequest` (pure, fully unit-tested) and `issue(built, limiter): Promise<{ status: number; body: string }>` (the only network-touching part).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import type { ClientManifest, ManifestEndpoint } from "../src/lib/manifest";
import { buildRequest } from "../src/lib/transport";

const endpoint: ManifestEndpoint = {
  id: "get.api.roster.id",
  method: "GET",
  pathTemplate: "/api/roster/{id}",
  params: [
    { name: "id", in: "path", type: "number" },
    { name: "week", in: "query", type: "string" },
  ],
  responseShape: { type: "unknown" },
  source: "xhr",
  fragile: false,
  selectors: null,
  writeSemantics: null,
};

function manifest(auth: ClientManifest["auth"]): ClientManifest {
  return {
    schemaVersion: 1,
    site: "example",
    baseUrl: "https://x.test",
    recordedAt: "2026-07-20T12:00:00.000Z",
    harSha256: "abc",
    userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
    clientHints: { "sec-ch-ua": '"Chromium";v="141"' },
    auth,
    endpoints: [endpoint],
  };
}

test("substitutes path params and appends query params", () => {
  const built = buildRequest(manifest(null), endpoint, { id: "4821", week: "2026-W30" }, null);
  expect(built.url).toBe("https://x.test/api/roster/4821?week=2026-W30");
  expect(built.method).toBe("GET");
});

test("pins the recorded user agent and client hints", () => {
  const built = buildRequest(manifest(null), endpoint, { id: "1" }, null);
  expect(built.headers["user-agent"]).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(built.headers["sec-ch-ua"]).toBe('"Chromium";v="141"');
});

test("applies a bearer credential to the authorization header", () => {
  const built = buildRequest(
    manifest({ kind: "bearer", location: "authorization", mintedBy: null, expiry: null }),
    endpoint,
    { id: "1" },
    "Bearer abc.def",
  );
  expect(built.headers["authorization"]).toBe("Bearer abc.def");
});

test("applies a cookie credential as a cookie header", () => {
  const built = buildRequest(
    manifest({ kind: "cookie", location: "cookie:sessionid", mintedBy: null, expiry: null }),
    endpoint,
    { id: "1" },
    "s3cr3tvalue",
  );
  expect(built.headers["cookie"]).toBe("sessionid=s3cr3tvalue");
});

test("applies a csrf credential to its recorded header", () => {
  const built = buildRequest(
    manifest({ kind: "csrf", location: "x-csrf-token", mintedBy: null, expiry: null }),
    endpoint,
    { id: "1" },
    "tok123456",
  );
  expect(built.headers["x-csrf-token"]).toBe("tok123456");
});

test("omits query params the caller did not supply", () => {
  const built = buildRequest(manifest(null), endpoint, { id: "4821" }, null);
  expect(built.url).toBe("https://x.test/api/roster/4821");
});

test("throws a named error when a required path param is missing", () => {
  expect(() => buildRequest(manifest(null), endpoint, { week: "2026-W30" }, null)).toThrow(
    /missing required path param: id/i,
  );
});

test("url-encodes param values", () => {
  const built = buildRequest(manifest(null), endpoint, { id: "a b/c", week: "x&y" }, null);
  expect(built.url).toBe("https://x.test/api/roster/a%20b%2Fc?week=x%26y");
});

test("refuses to build a request for a non-read method", () => {
  const writeEndpoint: ManifestEndpoint = { ...endpoint, method: "DELETE" };
  expect(() => buildRequest(manifest(null), writeEndpoint, { id: "1" }, null)).toThrow(
    /GET and HEAD only/i,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/transport.test.ts`
Expected: FAIL at module resolution for `../src/lib/transport`.

- [ ] **Step 3: Write the implementation**

```ts
import type { ClientManifest, ManifestEndpoint } from "./manifest";

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

export function buildRequest(
  manifest: ClientManifest,
  endpoint: ManifestEndpoint,
  params: Record<string, string>,
  secret: string | null,
): BuiltRequest {
  // Defence in depth: the filter pass should already have excluded writes,
  // but nothing reaches the network without passing this check too.
  if (!READ_METHODS.has(endpoint.method.toUpperCase())) {
    throw new Error(
      `refusing ${endpoint.method} ${endpoint.pathTemplate}: read mode issues GET and HEAD only`,
    );
  }

  let path = endpoint.pathTemplate;
  for (const p of endpoint.params.filter((x) => x.in === "path")) {
    const value = params[p.name];
    if (value === undefined) throw new Error(`missing required path param: ${p.name}`);
    path = path.replace(`{${p.name}}`, encodeURIComponent(value));
  }

  const query = new URLSearchParams();
  for (const p of endpoint.params.filter((x) => x.in === "query")) {
    const value = params[p.name];
    if (value !== undefined) query.set(p.name, value);
  }

  const qs = query.toString();
  const url = `${manifest.baseUrl}${path}${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = {
    "user-agent": manifest.userAgent,
    accept: "application/json, text/plain, */*",
    ...manifest.clientHints,
  };

  const auth = manifest.auth;
  if (auth && secret) {
    if (auth.kind === "cookie") {
      const name = auth.location.startsWith("cookie:")
        ? auth.location.slice("cookie:".length)
        : auth.location;
      headers["cookie"] = `${name}=${secret}`;
    } else {
      headers[auth.location.toLowerCase()] = secret;
    }
  }

  return { url, method: endpoint.method, headers };
}

export async function issue(
  built: BuiltRequest,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{ status: number; body: string }> {
  return limit(async () => {
    const res = await fetch(built.url, { method: built.method, headers: built.headers });
    return { status: res.status, body: await res.text() };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/transport.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/transport.ts plugins/rkt/skills/derive-client/scripts/tests/transport.test.ts
git commit -m "feat(derive-client): add direct transport with pinned UA and auth"
```

---

## Task 10: Wire the auth pass into derivation

**Files:**
- Modify: `scripts/src/derive.ts`
- Modify: `scripts/tests/derive.test.ts`

**Interfaces:**
- Produces: `deriveManifest(harPath, site): Promise<{ manifest; dropped; secret: string | null }>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/derive.test.ts` (which after Task 1 stages fixtures into a temp root):

```ts
test("derives auth and returns the secret separately from the manifest", async () => {
  const har = await stageFixture("authed.har");
  const { manifest, secret } = await deriveManifest(har, "authtest");

  expect(manifest.auth).toMatchObject({ kind: "cookie", location: "cookie:sessionid" });
  expect(secret).toBe("SUPERSECRETVALUE");
  expect(JSON.stringify(manifest)).not.toContain("SUPERSECRETVALUE");
});

test("auth analysis sees the login response even though the filter drops it", async () => {
  const har = await stageFixture("authed.har");
  const { manifest } = await deriveManifest(har, "authtest");
  // POST /login is dropped from endpoints but must still be traced as the mint point.
  expect(manifest.auth?.mintedBy).toBe("https://auth.test/login");
  expect(manifest.endpoints.every((e) => e.method === "GET")).toBe(true);
});

test("the recorded DELETE never becomes an endpoint in read mode", async () => {
  const har = await stageFixture("authed.har");
  const { manifest, dropped } = await deriveManifest(har, "authtest");
  expect(manifest.endpoints.some((e) => e.method === "DELETE")).toBe(false);
  expect(dropped.some((d) => /write method/i.test(d.reason))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/derive.test.ts`
Expected: FAIL — `secret` is undefined and `manifest.auth` is null.

- [ ] **Step 3: Write the implementation**

In `src/derive.ts`, add the imports:

```ts
import { analyzeAuth } from "./lib/auth";
import { writeSecret } from "./lib/secrets";
```

Replace `deriveManifest`:

```ts
export async function deriveManifest(
  harPath: string,
  site: string,
): Promise<{ manifest: ClientManifest; dropped: DropRecord[]; secret: string | null }> {
  const absHar = assertUnderRktRoot(resolve(harPath));
  const entries = await readHar(absHar);
  const { kept, dropped } = filterEntries(entries);
  const groups = groupEndpoints(kept);

  // Auth analysis runs over ALL entries, not the filtered set: the login
  // response that mints a credential is itself a write, and is therefore
  // dropped by the read-mode filter.
  const { spec, value } = analyzeAuth(entries);

  const harSha256 = createHash("sha256").update(await readFile(absHar)).digest("hex");
  const recordedAt = entries[0]?.startedDateTime ?? new Date().toISOString();

  return {
    manifest: buildManifest({ site, groups, harSha256, recordedAt, auth: spec }),
    dropped,
    secret: value,
  };
}
```

In `main()`, destructure `secret` from the `deriveManifest` call and, after writing `client.json`, persist it without leaking:

```ts
  if (secret) {
    await writeSecret(site, secret);
    console.error(
      `Stored ${manifest.auth?.kind} credential for "${site}" at 0600 ` +
        `(location: ${manifest.auth?.location}).`,
    );
    if (manifest.auth?.expiry) {
      console.error(`Credential expires: ${manifest.auth.expiry}`);
    }
  } else {
    console.error(
      "No credential detected. If this site needs auth, the recording may have " +
        "missed the authenticated requests.",
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test && bunx tsc --noEmit`
Expected: PASS, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/derive.ts plugins/rkt/skills/derive-client/scripts/tests/derive.test.ts
git commit -m "feat(derive-client): run auth analysis during derivation"
```

---

## Task 11: The `call` subcommand

**Files:**
- Create: `scripts/src/call.ts`
- Create: `scripts/tests/call.test.ts`

**Interfaces:**
- Produces: a CLI runnable as `bun src/call.ts --manifest <path> --endpoint <id> [--param k=v ...] [--dry-run]`, plus the exported `parseParams(argv: string[]): Record<string, string>`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { parseParams } from "../src/call";

test("parses repeated --param pairs", () => {
  expect(parseParams(["--param", "id=4821", "--param", "week=2026-W30"])).toEqual({
    id: "4821",
    week: "2026-W30",
  });
});

test("keeps equals signs inside the value", () => {
  expect(parseParams(["--param", "q=a=b"])).toEqual({ q: "a=b" });
});

test("returns an empty object when no params are given", () => {
  expect(parseParams(["--endpoint", "x"])).toEqual({});
});

test("throws on a param without an equals sign", () => {
  expect(() => parseParams(["--param", "broken"])).toThrow(/expected k=v/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/call.test.ts`
Expected: FAIL at module resolution for `../src/call`.

- [ ] **Step 3: Write `src/call.ts`**

Note the ordering in the error path: **redact first, then truncate.** Truncating first can emit a partial secret that redaction no longer matches.

```ts
/**
 * Invoke a single derived read endpoint.
 *
 * Usage:
 *   bun src/call.ts --manifest <path> --endpoint <id> [--param k=v ...] [--dry-run]
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifest } from "./lib/manifest";
import { assertUnderRktRoot } from "./lib/paths";
import { createLimiter } from "./lib/ratelimit";
import { readSecret, redact } from "./lib/secrets";
import { buildRequest, issue } from "./lib/transport";

export function parseParams(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--param") continue;
    const pair = argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq === -1) throw new Error(`bad --param ${JSON.stringify(pair)}: expected k=v`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const manifestPath = arg("manifest");
  const endpointId = arg("endpoint");
  if (!manifestPath || !endpointId) {
    console.error(
      "usage: bun src/call.ts --manifest <path> --endpoint <id> [--param k=v ...] [--dry-run]",
    );
    process.exit(1);
  }

  const abs = assertUnderRktRoot(resolve(manifestPath));
  const manifest = validateManifest(JSON.parse(await readFile(abs, "utf8")));

  const endpoint = manifest.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) {
    console.error(`unknown endpoint: ${endpointId}`);
    console.error("available:");
    for (const e of manifest.endpoints) console.error(`  ${e.id}  ${e.method} ${e.pathTemplate}`);
    process.exit(1);
  }

  if (endpoint.source === "scrape") {
    console.error(
      `endpoint ${endpoint.id} is HTML-scraped; scrape endpoints arrive in a later release`,
    );
    process.exit(1);
  }

  const secret = await readSecret(manifest.site);
  if (manifest.auth && !secret) {
    console.error(
      `no stored credential for "${manifest.site}". Re-run derive on a recording ` +
        `that includes authenticated requests.`,
    );
    process.exit(1);
  }

  if (manifest.auth?.expiry && Date.parse(manifest.auth.expiry) < Date.now()) {
    console.error(
      `warning: stored credential expired at ${manifest.auth.expiry}; ` +
        `expect a 401. Re-record to refresh it.`,
    );
  }

  // Throws for any non-GET/HEAD endpoint.
  const built = buildRequest(manifest, endpoint, parseParams(process.argv), secret);

  if (process.argv.includes("--dry-run")) {
    const preview = { method: built.method, url: built.url, headers: built.headers };
    console.log(redact(JSON.stringify(preview, null, 2), secret));
    return;
  }

  const { status, body } = await issue(built, createLimiter());
  if (status >= 400) {
    console.error(`HTTP ${status}`);
    // Redact BEFORE truncating: a secret straddling the cut would otherwise
    // leak its prefix.
    console.error(redact(body, secret).slice(0, 2000));
    process.exit(1);
  }
  console.log(body);
}

if (import.meta.main) {
  await main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test && bunx tsc --noEmit`
Expected: PASS across all suites, silent typecheck.

- [ ] **Step 5: Smoke-test `--dry-run` end to end**

```bash
cd plugins/rkt/skills/derive-client/scripts
MANIFEST=$(ls -t ~/.rkt-clients/recordings/*/*/client.json 2>/dev/null | head -1)
if [ -z "$MANIFEST" ]; then
  echo "no recording yet; run the Plan 1 recorder smoke test first"
else
  ENDPOINT=$(jq -r '.endpoints[0].id // empty' "$MANIFEST")
  if [ -z "$ENDPOINT" ]; then
    echo "manifest has no endpoints (expected for an HTML-only site like example.com)"
  else
    bun src/call.ts --manifest "$MANIFEST" --endpoint "$ENDPOINT" --dry-run
  fi
fi
```

Expected: a JSON preview with method, URL, and the pinned `user-agent`. If a credential is stored for that site it must render as `[REDACTED]` and the raw value must not appear anywhere in the output. The two guard branches are legitimate outcomes given Plan 1's example.com smoke recording; to exercise the real path, record a site that serves JSON.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/call.ts plugins/rkt/skills/derive-client/scripts/tests/call.test.ts
git commit -m "feat(derive-client): add call subcommand for derived read endpoints"
```

---

## Task 12: Structural leak test

**Files:**
- Create: `scripts/tests/leak.test.ts`

**Interfaces:**
- Consumes: `deriveManifest`, `writeSecret`, `secretsFile`, and the `authed.har` fixture.

The wrapper guards conventions with greps, and greps on identifier names are bypasses (CLAUDE.md: key checks on structure, not names). This is the real check: derive a manifest from a HAR containing a known secret and assert the secret appears nowhere in the serialized output.

- [ ] **Step 1: Write the test**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveManifest } from "../src/derive";
import { recordingDir, secretsFile } from "../src/lib/paths";
import { writeSecret } from "../src/lib/secrets";

const SECRET = "SUPERSECRETVALUE";
let testRoot: string;
const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "rkt-leak-"));
  process.env.RKT_CLIENTS_ROOT = testRoot;
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  await rm(testRoot, { recursive: true, force: true });
});

async function stage(): Promise<string> {
  const dir = recordingDir("leaktest", "fixed");
  await mkdir(dir, { recursive: true });
  const dest = `${dir}/session.har`;
  await copyFile(`${import.meta.dir}/fixtures/authed.har`, dest);
  return dest;
}

test("the serialized manifest contains no part of the credential", async () => {
  const { manifest, secret } = await deriveManifest(await stage(), "leaktest");
  expect(secret).toBe(SECRET);

  const serialized = JSON.stringify(manifest);
  expect(serialized).not.toContain(SECRET);
  // Also catch a truncated leak.
  expect(serialized).not.toContain(SECRET.slice(0, 10));
});

test("the manifest records where the credential lives, not what it is", async () => {
  const { manifest } = await deriveManifest(await stage(), "leaktest");
  expect(manifest.auth?.location).toBe("cookie:sessionid");
  expect(JSON.stringify(manifest.auth)).not.toContain(SECRET);
});

test("the secret lands only in the secrets file", async () => {
  const { secret } = await deriveManifest(await stage(), "leaktest");
  await writeSecret("leaktest", secret!);
  const stored = await readFile(secretsFile("leaktest"), "utf8");
  expect(stored).toContain(SECRET);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/leak.test.ts`
Expected: PASS, 3 tests. A failure here means a secret is reaching the manifest and must be fixed before proceeding.

- [ ] **Step 3: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/tests/leak.test.ts
git commit -m "test(derive-client): assert structurally that manifests carry no secrets"
```

---

## Task 13: SKILL.md updates

**Files:**
- Modify: `plugins/rkt/skills/derive-client/SKILL.md`

- [ ] **Step 1: Add the auth confirmation gate**

Append immediately before the existing `## Artifacts` heading:

````markdown
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
````

- [ ] **Step 2: Document the secrets location and root resolution**

Add this line directly under the `## Artifacts` heading:

```markdown
All paths below resolve under `~/.rkt-clients/`. (`RKT_CLIENTS_ROOT` relocates
this root during automated tests only; it is ignored outside `NODE_ENV=test`.)
```

And add to the artifacts list:

```markdown
- `secrets/<site>.json` — the session credential, mode `0600`. Never commit,
  never print, never paste into a chat or an issue. Delete this file to revoke
  the derived client's access.
```

- [ ] **Step 3: Verify the wrapper still passes**

Run: `bash tests/test-derive-client.sh`
Expected: PASS, ending `OK`.

- [ ] **Step 4: Commit**

```bash
git add plugins/rkt/skills/derive-client/SKILL.md
git commit -m "docs(derive-client): document auth gate, call verification, secrets"
```

---

## Task 14: Wrapper guards and release chores

**Files:**
- Modify: `tests/test-derive-client.sh`
- Modify: `plugins/rkt/.claude-plugin/plugin.json`
- Modify: `plugins/rkt/.codex-plugin/plugin.json`
- Modify: `plugins/rkt/CHANGELOG.md`

- [ ] **Step 1: Add a typecheck to the wrapper**

In `tests/test-derive-client.sh`, immediately before the existing `( cd "$SCRIPTS" && bun test )` line, add:

```bash
( cd "$SCRIPTS" && bunx tsc --noEmit )
```

This is the gate that keeps the workspace typechecked. It was silently broken until Task 1.

- [ ] **Step 2: Add the structural secret guards**

Also in `tests/test-derive-client.sh`, before the bun section:

```bash
# No secrets file may ever be tracked by git.
if git -C "$ROOT/../.." ls-files --error-unmatch '**/secrets/*.json' >/dev/null 2>&1; then
  echo "secrets files must never be committed" >&2
  exit 1
fi

# The leak test is the structural guarantee that manifests carry no secrets;
# its absence must fail the suite rather than silently reduce coverage.
if [[ ! -f "$SCRIPTS/tests/leak.test.ts" ]]; then
  echo "missing structural leak test at scripts/tests/leak.test.ts" >&2
  exit 1
fi
```

Do **not** add greps for `redact(` or `"value"`: renaming a function or field would pass or fail such a check spuriously, and CLAUDE.md forbids name-based safety checks.

- [ ] **Step 3: Run the full repo suite**

Run, from the main checkout (not a worktree):

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
LANG=en_US.UTF-8 bash -c 'for t in tests/test-*.sh; do bash "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"; done'
```

Expected: **all 12 tests OK.** `LANG` is set explicitly because `tests/test-plugin-manifests.sh` uses Ruby's `File.read`, which defaults to US-ASCII when `LANG` is unset and then throws `invalid byte sequence` on the non-ASCII characters in several SKILL.md files.

- [ ] **Step 4: Bump both manifests in lockstep**

Set `"version": "0.5.0"` in both `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json` (current value in both: `0.4.0`).

Verify: `jq -r .version plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json`
Expected: `0.5.0` twice.

- [ ] **Step 5: Prepend the CHANGELOG entry**

Insert directly below the `# Changelog` heading:

```markdown
## 0.5.0 — 2026-07-20

Adds authentication analysis and a `call` subcommand to `/derive-client`.

### Added

- **Auth analysis** — detects the session credential (cookie, bearer, or CSRF)
  from recorded traffic, traces where it was minted, and reads its expiry from
  a JWT `exp` claim or cookie attributes. The manifest records where the
  credential lives; the value goes to `<rkt-root>/secrets/<site>.json` at 0600.
- **`call` subcommand** — invokes a derived read endpoint by id with path and
  query params, applying the stored credential and the pinned User-Agent and
  client hints. `--dry-run` prints the built request with the credential
  redacted.
- **Rate limiter** — serializes requests and spaces them 400 to 1300 ms. It
  becomes load-bearing when generated clients issue requests in a loop.

### Fixed

- **Read mode now derives GET and HEAD only.** Previously any recorded write
  that returned 2xx JSON became an endpoint in `client.json`. Harmless while
  nothing could execute a manifest, but not once `call` shipped. `call` refuses
  non-read methods as a second line of defence.
- **TypeScript is now actually typechecked.** `tsconfig.json` referenced a
  `bun-types` package that is not installed, so `tsc --noEmit` had always
  failed. The test wrapper now runs it.

### Changed

- `rktRoot()` honors `RKT_CLIENTS_ROOT` under `NODE_ENV=test` only, so tests
  redirect to a temp directory instead of writing to the user's real home.
  Production behavior is unchanged, and the path-confinement boundary cannot
  be moved by the environment.

### Security

- Credentials are written atomically (temp file at 0600, then rename) so an
  overwrite never leaves the file world-readable, live in a 0700 directory,
  are never placed in a manifest, and are redacted before any output
  truncation.
```

- [ ] **Step 6: Validate the plugin package**

Run: `claude plugin validate plugins/rkt`
Expected: validation passes with no errors.

- [ ] **Step 7: Commit**

```bash
git add tests/test-derive-client.sh plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json plugins/rkt/CHANGELOG.md
git commit -m "chore(derive-client): bump to 0.5.0, add typecheck and leak guards"
```

**Release note:** AGENTS.md "Release Flow" also calls for an annotated tag (`git tag -a v0.5.0`) and explicit approval before pushing to main. Both are deliberately left to the user after review; no task in this plan tags or pushes.

---

## Requirement → task map

| Spec requirement | Task |
| --- | --- |
| Read mode derives GET and HEAD only | 2, enforced again in 9 and 11 |
| Pass 2 auth analysis identifies the credential | 3 |
| Trace where the credential is minted | 4 |
| Note expiry and refresh behavior | 5 |
| Auth pass reports and confirms rather than guessing | 6 (split return), 13 (gate) |
| `auth` block populated in the manifest | 6 |
| Secrets at `<root>/secrets/<site>.json`, 0600, no weak window | 7 |
| Secrets never in git, never printed, never truncated mid-secret | 7, 11 (redact-then-slice), 12 (structural test), 14 (guards) |
| `direct` transport, standalone and cron-capable | 9 |
| Pinned UA and client hints replayed verbatim | 9 |
| Human-shaped rate limiting, concurrency 1 | 8 provides the primitive. **Not fully satisfied by this plan:** `call` issues one request per process, so pacing has no observable effect until Plan 3's generated clients issue requests in a loop. |
| `--dry-run` prints request with secrets redacted | 11 |
| Smoke-test the real thing end to end | 11 (Step 5) |
| Shape-not-value comparison when verifying | 13 (Step 8) |
| Carried review finding: tests must not write to real home | 1 |
| Typecheck actually runs | 1, 14 |
| Manifest bump, CHANGELOG, `claude plugin validate` | 14 |

**Deferred to later plans, by design:** typed code generation and the shared runtime lib (Plan 3), repair and stale-endpoint retention (Plan 4), DOM scraper endpoints and `full` mode writes with the rollback journal (Plan 5).

**Deferred with a reason:** the spec calls for the `rkt-clients` repo to ship a `.gitignore` containing `secrets/` and `recordings/`. That repo is not created until Plan 3, so the guard cannot be written yet. This plan keeps secrets outside any repo entirely (they live under `~/.rkt-clients/`, which is not a git repo), so that `.gitignore` is a second line of defence rather than the primary one. Plan 3 must create it.

## Open risks carried into execution

1. **AlayaCare's auth shape is still unknown.** If it uses short-lived tokens with a refresh dance, Task 3 will detect the access token but Task 5 will report a near-term expiry and `call` will fail soon after derivation. `mintedBy` (Task 4) captures the refresh endpoint, making a Plan 3 refresh loop possible. If this happens, stop and re-plan rather than bolting refresh onto Task 9.
2. **Multiple simultaneous credentials.** `analyzeAuth` picks the single highest-coverage candidate. A site requiring both a session cookie *and* a CSRF header on every request will authenticate partially and fail. Detection surfaces all candidates so it is visible at the confirmation gate rather than silent; the fix is making `AuthSpec` a list, which is a schema change and therefore a `schemaVersion` bump.
3. **`fetch` does not replay the browser's full header set.** Some WAFs fingerprint beyond User-Agent (TLS fingerprint, header ordering, `Accept-Language`). If `call` returns 403 where the browser succeeded, the gap is here, and the next lever is copying more recorded request headers verbatim rather than adding auth logic.
4. **Credential detection is heuristic.** Task 3 filters known non-secrets and enforces a minimum length, but a site using an unusual cookie name that misses `SESSION_COOKIE` will yield no credential or the wrong one. The confirmation gate in Task 13 is the backstop; if it fires often, the heuristic needs replacing with differential analysis (compare an authenticated recording against an unauthenticated one).
