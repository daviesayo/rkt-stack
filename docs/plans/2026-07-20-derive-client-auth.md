# derive-client Plan 2: Auth Analysis and the Direct Transport

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the manifest's `auth` field by analyzing the recorded HAR, store the credential outside the repo, and ship a `call` subcommand that replays any derived endpoint with working authentication.

**Architecture:** Three pure analysis passes over `HarEntry[]` (credential detection, mint-point tracing, expiry detection) produce an `AuthSpec` that replaces Plan 1's `auth: null` seam. A separate extraction step writes the actual secret values to `~/.rkt-clients/secrets/<site>.json` at mode `0600`, never into the repo and never into logs. A runtime transport applies the credential, the pinned User-Agent and client hints, and human-shaped rate limiting to outbound requests. A `call` subcommand ties it together so the plan ends with something you can actually run.

**Tech Stack:** Bun 1.3.11, TypeScript, `bun test`. No new dependencies. Reuses `lib/har`, `lib/manifest`, `lib/paths` from Plan 1.

**Source spec:** `docs/specs/2026-07-20-derive-client-skill-design.md`
**Predecessor:** `docs/plans/2026-07-20-derive-client-recorder.md` (shipped as plugin 0.4.0)

## Scope change from the original sequence

The original five-plan split put code generation in Plan 3, which left this plan producing authenticated requests that nothing consumed. That failed the rule that each plan ends with working software.

Fixed here by adding Task 9, a `call` subcommand that invokes any manifest endpoint by id. It is one task, not a code generator, and it turns this plan's deliverable from "auth works internally" into "you can fetch your roster from the terminal." Plan 3 remains the full typed client generator; this is the thin manual path that proves auth end to end and stays useful afterward as a debugging tool.

## Carried-over review finding

Plan 1's post-merge review found that `scripts/tests/derive.test.ts` writes into the user's real `~/.rkt-clients/`, violating the AGENTS.md rule that tests use temp directories. Root cause: `rktRoot()` has no injection point, unlike `acquireLock(site, root)`. Task 1 fixes this before any new filesystem surface is added, because this plan introduces the secrets file and would otherwise multiply the problem.

## Global Constraints

Everything from Plan 1 still applies. Restated because a task implementer sees only their own task:

- Runtime artifacts live under the resolved rkt root only. Never write to a cwd-relative path (AGENTS.md "Runtime Paths").
- Skills resolve bundled files via `RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"`. Never reference `./scripts/`.
- All interactive prompts use `AskUserQuestion`. Never bash `read` (`decisions.md:64`).
- No machine-local home paths (`/Users/<name>`) hardcoded in any skill file.
- Plugin changes bump `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json` in lockstep, prepend a `plugins/rkt/CHANGELOG.md` entry, and pass `claude plugin validate plugins/rkt`. This plan ships **0.5.0** (new user-visible capability, so minor).
- Tests must be idempotent, use temp directories, and clean up.

**New constraints introduced by this plan, all non-negotiable:**

- **Secrets never touch the repo.** They live at `<rktRoot>/secrets/<site>.json`, mode `0600`, parent directory mode `0700`.
- **Secrets never reach stdout, stderr, logs, or error messages.** Every code path that could print a credential redacts it. Task 6 adds the redaction helper and Task 11 adds a test-suite guard.
- **Manifests stay secret-free.** `client.json` records *where* the credential lives (`kind`, `location`), never its value. Task 5 tests this explicitly.
- **`--dry-run` on `call` prints the built request with the credential redacted.**

---

## File Structure

**Created:**

- `plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts` — credential detection, mint tracing, expiry detection, `AuthSpec` construction.
- `plugins/rkt/skills/derive-client/scripts/src/lib/secrets.ts` — read/write the secrets file, redaction helper.
- `plugins/rkt/skills/derive-client/scripts/src/lib/ratelimit.ts` — human-shaped pacing, concurrency 1.
- `plugins/rkt/skills/derive-client/scripts/src/lib/transport.ts` — build and issue an authenticated request.
- `plugins/rkt/skills/derive-client/scripts/src/call.ts` — `call` CLI.
- `plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts`
- `plugins/rkt/skills/derive-client/scripts/tests/secrets.test.ts`
- `plugins/rkt/skills/derive-client/scripts/tests/ratelimit.test.ts`
- `plugins/rkt/skills/derive-client/scripts/tests/transport.test.ts`
- `plugins/rkt/skills/derive-client/scripts/tests/fixtures/authed.har` — HAR fixture with cookie, bearer, and CSRF traffic.

**Modified:**

- `scripts/src/lib/paths.ts` — root injection, secrets path helpers.
- `scripts/tests/paths.test.ts`, `scripts/tests/derive.test.ts` — use an injected temp root.
- `scripts/src/lib/manifest.ts` — `auth` becomes a populated `AuthSpec`.
- `scripts/src/derive.ts` — run the auth pass, write secrets.
- `plugins/rkt/skills/derive-client/SKILL.md` — auth confirmation gate, `call` usage, secrets handling.
- `tests/test-derive-client.sh` — secret-leak guard.
- `plugins/rkt/CHANGELOG.md`, both plugin manifests.

---

## Task 1: Injectable root and test isolation

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/paths.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/tests/paths.test.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/tests/derive.test.ts`

**Interfaces:**
- Consumes: existing `rktRoot`, `assertUnderRktRoot`, `recordingDir`, `secretsFile` from Plan 1.
- Produces: `rktRoot()` honoring the `RKT_CLIENTS_ROOT` environment variable, plus `secretsDir(): string`. Every later task in this plan reads paths through this module, so tests can redirect the whole filesystem surface with one env var.

- [ ] **Step 1: Write the failing test**

Add to `tests/paths.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { rktRoot, secretsDir, secretsFile } from "../src/lib/paths";

const ORIGINAL = process.env.RKT_CLIENTS_ROOT;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL;
});

test("RKT_CLIENTS_ROOT overrides the default root", () => {
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(rktRoot()).toBe("/tmp/rkt-test-root");
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

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/paths.test.ts`
Expected: FAIL — `rktRoot()` ignores the env var and returns the home path.

- [ ] **Step 3: Write the implementation**

Replace the top of `src/lib/paths.ts`:

```ts
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Root for all runtime artifacts. RKT_CLIENTS_ROOT exists so tests can
 * redirect the entire filesystem surface to a temp directory; production
 * always uses the home default.
 */
export function rktRoot(): string {
  const override = process.env.RKT_CLIENTS_ROOT;
  if (override && override.length > 0) return resolve(override);
  return `${homedir()}/.rkt-clients`;
}

export function secretsDir(): string {
  return `${rktRoot()}/secrets`;
}
```

Keep `assertUnderRktRoot`, `sanitizeSite`, `profileDir`, `lockFile`, `recordingDir`, and `secretsFile` as they are; they call `rktRoot()` and inherit the override automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Migrate `derive.test.ts` off the real home directory**

Replace the staging preamble in `tests/derive.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const { recordingDir } = await import("../src/lib/paths");
  const ts = `test${++stagingCounter}`;
  const dir = recordingDir("derive-test", ts);
  await mkdir(dir, { recursive: true });
  const dest = `${dir}/session.har`;
  await copyFile(`${import.meta.dir}/fixtures/${name}`, dest);
  return dest;
}
```

Leave the individual test bodies unchanged; they call `stageFixture` and `deriveManifest` exactly as before.

- [ ] **Step 6: Verify tests pass and no longer touch the real home**

```bash
cd plugins/rkt/skills/derive-client/scripts
rm -rf ~/.rkt-clients/recordings/derive-test
bun test
test ! -d ~/.rkt-clients/recordings/derive-test && echo "real home untouched"
```

Expected: all Plan 1 tests still pass, then `real home untouched`.

- [ ] **Step 7: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/paths.ts plugins/rkt/skills/derive-client/scripts/tests/paths.test.ts plugins/rkt/skills/derive-client/scripts/tests/derive.test.ts
git commit -m "fix(derive-client): make rkt root injectable and isolate tests"
```

---

## Task 2: Credential detection

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts`
- Create: `plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts`

**Interfaces:**
- Consumes: `HarEntry` from `lib/har`.
- Produces: `detectCredentials(entries: HarEntry[]): CredentialCandidate[]` where

```ts
export interface CredentialCandidate {
  kind: "cookie" | "bearer" | "csrf";
  /** Header name, or "cookie:<name>" for a specific cookie. */
  location: string;
  /** Fraction of data requests carrying this credential, 0 to 1. */
  coverage: number;
  /** The observed value. Never written to a manifest. */
  value: string;
}
```

Candidates are returned sorted by coverage descending, so the highest-coverage candidate is the primary one. Coverage is what distinguishes a real session credential from an incidental header.

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
    entry({ cookie: "theme=dark; sessionid=s3cr3t; lang=en" }),
    entry({ cookie: "theme=dark; sessionid=s3cr3t; lang=en" }),
  ]);
  const session = found.find((c) => c.location === "cookie:sessionid");
  expect(session).toMatchObject({ kind: "cookie", value: "s3cr3t" });
});

test("ignores cookies that never vary and look like preferences", () => {
  const found = detectCredentials([entry({ cookie: "theme=dark; lang=en" })]);
  expect(found).toHaveLength(0);
});

test("detects a CSRF header", () => {
  const found = detectCredentials([entry({ "x-csrf-token": "tok123" })]);
  expect(found[0]).toMatchObject({ kind: "csrf", location: "x-csrf-token", value: "tok123" });
});

test("coverage reflects how many requests carry the credential", () => {
  const found = detectCredentials([
    entry({ authorization: "Bearer a" }),
    entry({ authorization: "Bearer a" }),
    entry({}),
    entry({}),
  ]);
  expect(found[0].coverage).toBeCloseTo(0.5);
});

test("results are sorted by coverage descending", () => {
  const found = detectCredentials([
    entry({ authorization: "Bearer a", "x-csrf-token": "t" }),
    entry({ authorization: "Bearer a" }),
    entry({ authorization: "Bearer a" }),
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
Expected: FAIL with a module-not-found error for `../src/lib/auth`.

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
const SESSION_COOKIE = /sess|auth|token|sid$|^sid|jwt|login|identity|csrf|xsrf/i;

/** Headers that carry a CSRF token. */
const CSRF_HEADER = /^x-(csrf|xsrf)-token$|^x-requested-with$/i;

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

  // location -> { kind, value, count }
  const seen = new Map<string, { kind: CredentialCandidate["kind"]; value: string; count: number }>();

  const bump = (location: string, kind: CredentialCandidate["kind"], value: string) => {
    const existing = seen.get(location);
    if (existing) existing.count += 1;
    else seen.set(location, { kind, value, count: 1 });
  };

  for (const e of entries) {
    const auth = e.requestHeaders["authorization"];
    if (auth && /^bearer\s+\S+/i.test(auth)) {
      bump("authorization", "bearer", auth);
    }

    const cookie = e.requestHeaders["cookie"];
    if (cookie) {
      for (const [name, value] of parseCookies(cookie)) {
        if (value.length > 0 && SESSION_COOKIE.test(name)) {
          bump(`cookie:${name}`, "cookie", value);
        }
      }
    }

    for (const [name, value] of Object.entries(e.requestHeaders)) {
      if (CSRF_HEADER.test(name) && value.length > 0) {
        bump(name, "csrf", value);
      }
    }
  }

  return [...seen.entries()]
    .map(([location, v]) => ({
      kind: v.kind,
      location,
      coverage: v.count / total,
      value: v.value,
    }))
    .sort((a, b) => b.coverage - a.coverage);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts
git commit -m "feat(derive-client): detect credential candidates in recorded traffic"
```

---

## Task 3: Mint-point tracing

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts`

**Interfaces:**
- Consumes: `CredentialCandidate`, `HarEntry`.
- Produces: `traceMintPoint(candidate: CredentialCandidate, entries: HarEntry[]): string | null` returning the URL of the request whose response first produced the credential, or `null` when it was already present at recording start (the usual case for a pre-authenticated profile).

Knowing the mint point is what makes re-authentication possible later; `null` is a legitimate, common answer and must not be treated as failure.

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
  const candidate = { kind: "cookie" as const, location: "cookie:sessionid", coverage: 1, value: "s3cr3t" };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/login", { "set-cookie": "sessionid=s3cr3t; Path=/; HttpOnly" }),
    entry({ cookie: "sessionid=s3cr3t" }),
  ]);
  expect(mint).toBe("https://x.test/login");
});

test("traces a bearer token to the response body that returned it", () => {
  const candidate = { kind: "bearer" as const, location: "authorization", coverage: 1, value: "Bearer abc.def" };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/oauth/token", {}, '{"access_token":"abc.def","token_type":"Bearer"}'),
    entry({ authorization: "Bearer abc.def" }),
  ]);
  expect(mint).toBe("https://x.test/oauth/token");
});

test("returns null when the credential predates the recording", () => {
  const candidate = { kind: "bearer" as const, location: "authorization", coverage: 1, value: "Bearer abc.def" };
  expect(traceMintPoint(candidate, [entry({ authorization: "Bearer abc.def" })])).toBeNull();
});

test("matches a set-cookie with attributes and surrounding cookies", () => {
  const candidate = { kind: "cookie" as const, location: "cookie:sid", coverage: 1, value: "xyz" };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/auth", { "set-cookie": "other=1, sid=xyz; Secure; SameSite=Lax" }),
  ]);
  expect(mint).toBe("https://x.test/auth");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: FAIL with `traceMintPoint is not a function`.

- [ ] **Step 3: Append the implementation to `lib/auth.ts`**

```ts
/**
 * Find the response that produced this credential. Returns null when the
 * credential was already present when recording began, which is the normal
 * case for a profile that was authenticated in an earlier session.
 */
export function traceMintPoint(
  candidate: CredentialCandidate,
  entries: HarEntry[],
): string | null {
  // The bare secret, without any scheme prefix.
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
        // Match name=value at a boundary so "sid=xyz" does not match "othersid=xyz".
        const pattern = new RegExp(
          `(^|[,;\\s])${escapeRegExp(cookieName)}=${escapeRegExp(secret)}(;|,|\\s|$)`,
        );
        if (pattern.test(setCookie)) return e.url;
      }
    }
    if (e.responseBody && e.responseBody.includes(secret)) {
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
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts
git commit -m "feat(derive-client): trace where credentials are minted"
```

---

## Task 4: Expiry detection

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts`

**Interfaces:**
- Consumes: `CredentialCandidate`, `HarEntry`.
- Produces: `detectExpiry(candidate: CredentialCandidate, entries: HarEntry[]): string | null` returning an ISO 8601 timestamp, or `null` when no expiry is discoverable. Sources, in priority order: a JWT `exp` claim in the token itself, then `Expires`/`Max-Age` on the matching `Set-Cookie`.

This is what lets the `call` subcommand warn "your stored credential expired 3 days ago" instead of returning a bare 401.

- [ ] **Step 1: Write the failing test**

Append to `tests/auth.test.ts`:

```ts
import { detectExpiry } from "../src/lib/auth";

/** Build an unsigned JWT with the given payload. Signature is irrelevant here. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
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
  const candidate = { kind: "cookie" as const, location: "cookie:sid", coverage: 1, value: "xyz" };
  const mint = respEntry("https://x.test/auth", {
    "set-cookie": "sid=xyz; Expires=Sat, 01 Aug 2026 00:00:00 GMT; Path=/",
  });
  expect(detectExpiry(candidate, [mint])).toBe("2026-08-01T00:00:00.000Z");
});

test("computes expiry from Max-Age relative to the response time", () => {
  const candidate = { kind: "cookie" as const, location: "cookie:sid", coverage: 1, value: "xyz" };
  const mint: HarEntry = {
    ...respEntry("https://x.test/auth", { "set-cookie": "sid=xyz; Max-Age=3600" }),
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
  expect(detectExpiry(candidate, [mint])).toBe("2026-07-20T13:00:00.000Z");
});

test("returns null for an opaque token with no expiry signal", () => {
  const candidate = { kind: "cookie" as const, location: "cookie:sid", coverage: 1, value: "opaque" };
  expect(detectExpiry(candidate, [])).toBeNull();
});

test("returns null rather than throwing on a malformed JWT", () => {
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: "Bearer not.a.jwt",
  };
  expect(detectExpiry(candidate, [])).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/auth.test.ts`
Expected: FAIL with `detectExpiry is not a function`.

- [ ] **Step 3: Append the implementation to `lib/auth.ts`**

```ts
/**
 * Best-effort expiry for a credential, as an ISO timestamp.
 * A JWT exp claim wins; otherwise fall back to cookie attributes.
 * Returns null when nothing is discoverable, which is not an error.
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
    if (!new RegExp(`(^|[,;\\s])${escapeRegExp(cookieName)}=${escapeRegExp(secret)}`).test(setCookie)) {
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
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts plugins/rkt/skills/derive-client/scripts/tests/auth.test.ts
git commit -m "feat(derive-client): detect credential expiry from JWT and cookie attributes"
```

---

## Task 5: AuthSpec in the manifest

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/manifest.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts`

**Interfaces:**
- Consumes: `detectCredentials`, `traceMintPoint`, `detectExpiry`.
- Produces: `analyzeAuth(entries: HarEntry[]): { spec: AuthSpec | null; value: string | null }`. The `spec` goes into the manifest; the `value` goes to the secrets file in Task 6 and never into the manifest. `buildManifest` gains an optional `auth` field on its input, replacing Plan 1's hardcoded `null`.

The split return type is the mechanism that keeps secrets out of `client.json`: the two travel in different directions from the same call, by construction rather than by discipline.

- [ ] **Step 1: Write the failing test**

Append to `tests/manifest.test.ts`:

```ts
import { analyzeAuth } from "../src/lib/auth";

test("analyzeAuth returns a spec and the value separately", () => {
  const entries = [
    {
      method: "GET",
      url: "https://x.test/api/a",
      status: 200,
      requestHeaders: { authorization: "Bearer abc.def.ghi" },
      responseHeaders: {},
      mimeType: "application/json",
      responseBody: "{}",
      startedDateTime: "2026-07-20T12:00:00.000Z",
    },
  ];
  const { spec, value } = analyzeAuth(entries);
  expect(spec).toMatchObject({ kind: "bearer", location: "authorization" });
  expect(value).toBe("Bearer abc.def.ghi");
});

test("analyzeAuth returns nulls when no credential is present", () => {
  const { spec, value } = analyzeAuth([]);
  expect(spec).toBeNull();
  expect(value).toBeNull();
});

test("the manifest carries the auth spec but never the secret value", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
    auth: { kind: "bearer", location: "authorization", mintedBy: null, expiry: null },
  });
  expect(m.auth).toMatchObject({ kind: "bearer", location: "authorization" });
  expect(JSON.stringify(m)).not.toContain("abc.def.ghi");
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
Expected: FAIL with `analyzeAuth is not a function`.

- [ ] **Step 3: Append `analyzeAuth` to `lib/auth.ts`**

```ts
import type { AuthSpec } from "./manifest";

/**
 * Run all three passes and split the result: the spec is manifest-safe,
 * the value is secret. Callers must never merge them.
 */
export function analyzeAuth(
  entries: HarEntry[],
): { spec: AuthSpec | null; value: string | null } {
  const candidates = detectCredentials(entries);
  const primary = candidates[0];
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

In `src/lib/manifest.ts`, add to `BuildManifestInput`:

```ts
export interface BuildManifestInput {
  site: string;
  groups: EndpointGroup[];
  harSha256: string;
  recordedAt: string;
  auth?: AuthSpec | null;
}
```

and change the returned object's `auth` field from `auth: null` to:

```ts
    auth: input.auth ?? null,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/manifest.test.ts tests/auth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/auth.ts plugins/rkt/skills/derive-client/scripts/src/lib/manifest.ts plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts
git commit -m "feat(derive-client): populate manifest auth spec without leaking secrets"
```

---

## Task 6: Secrets storage and redaction

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/secrets.ts`
- Create: `plugins/rkt/skills/derive-client/scripts/tests/secrets.test.ts`

**Interfaces:**
- Consumes: `secretsDir`, `secretsFile` from `lib/paths`.
- Produces: `writeSecret(site: string, value: string): Promise<void>`, `readSecret(site: string): Promise<string | null>`, and `redact(text: string, secret: string | null): string`. Task 8's transport reads the secret; Task 9's `call` redacts before printing.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
  await writeSecret("example", "s3cr3t");
  const info = await stat(`${testRoot}/secrets/example.json`);
  expect(info.mode & 0o777).toBe(0o600);
});

test("the secrets directory is mode 0700", async () => {
  await writeSecret("example", "s3cr3t");
  const info = await stat(`${testRoot}/secrets`);
  expect(info.mode & 0o777).toBe(0o700);
});

test("reading an unknown site returns null rather than throwing", async () => {
  expect(await readSecret("never-written")).toBeNull();
});

test("overwriting preserves the restrictive mode", async () => {
  await writeSecret("example", "first");
  await writeSecret("example", "second");
  const info = await stat(`${testRoot}/secrets/example.json`);
  expect(info.mode & 0o777).toBe(0o600);
  expect(await readSecret("example")).toBe("second");
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
Expected: FAIL with a module-not-found error for `../src/lib/secrets`.

- [ ] **Step 3: Write the implementation**

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { secretsDir, secretsFile } from "./paths";

interface SecretBody {
  value: string;
  storedAt: string;
}

export async function writeSecret(site: string, value: string): Promise<void> {
  await mkdir(secretsDir(), { recursive: true, mode: 0o700 });
  // mkdir ignores mode when the directory already exists, so set it explicitly.
  await chmod(secretsDir(), 0o700);

  const path = secretsFile(site);
  const body: SecretBody = { value, storedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  // writeFile only applies mode on creation, so enforce it on overwrite too.
  await chmod(path, 0o600);
}

export async function readSecret(site: string): Promise<string | null> {
  try {
    const raw = await readFile(secretsFile(site), "utf8");
    const body = JSON.parse(raw) as SecretBody;
    return typeof body.value === "string" ? body.value : null;
  } catch {
    return null;
  }
}

/**
 * Mask a secret in text bound for a terminal or log. Masks both the full
 * stored value and its bare token, since "Bearer abc" is stored whole but
 * "abc" may appear alone elsewhere.
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
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/secrets.ts plugins/rkt/skills/derive-client/scripts/tests/secrets.test.ts
git commit -m "feat(derive-client): store credentials at 0600 with redaction helper"
```

---

## Task 7: Human-shaped rate limiter

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/ratelimit.ts`
- Create: `plugins/rkt/skills/derive-client/scripts/tests/ratelimit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createLimiter(options?: { minDelayMs?: number; maxDelayMs?: number }): <T>(fn: () => Promise<T>) => Promise<T>`. Defaults: 400 to 1300 ms. Serializes calls (concurrency 1) and spaces them by a randomized delay. This is the ToS guardrail from the spec, enforced in code rather than by convention.

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

test("spaces successive calls by at least the minimum delay", async () => {
  const limit = createLimiter({ minDelayMs: 40, maxDelayMs: 45 });
  const start = Date.now();
  await limit(async () => null);
  await limit(async () => null);
  await limit(async () => null);
  // Three calls means at least two inter-call gaps.
  expect(Date.now() - start).toBeGreaterThanOrEqual(80);
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
Expected: FAIL with a module-not-found error for `../src/lib/ratelimit`.

- [ ] **Step 3: Write the implementation**

```ts
export interface LimiterOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Serialize calls and space them by a randomized delay, so automated traffic
 * keeps a human shape. Concurrency is fixed at 1 by design; this is a
 * politeness guardrail, not a throughput knob.
 */
export function createLimiter(options: LimiterOptions = {}) {
  const min = options.minDelayMs ?? 400;
  const max = Math.max(options.maxDelayMs ?? 1300, min);

  // Chain of pending work; each call awaits its predecessor.
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

## Task 8: Direct transport

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/transport.ts`
- Create: `plugins/rkt/skills/derive-client/scripts/tests/transport.test.ts`

**Interfaces:**
- Consumes: `ClientManifest`, `ManifestEndpoint` from `lib/manifest`; `createLimiter` from `lib/ratelimit`.
- Produces: `buildRequest(manifest, endpoint, params, secret): BuiltRequest` where `BuiltRequest` is `{ url: string; method: string; headers: Record<string, string> }`, and `issue(built, limiter): Promise<{ status: number; body: string }>`. `buildRequest` is pure and fully unit-tested; `issue` is the only part that touches the network.

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
  const built = buildRequest(
    manifest(null),
    endpoint,
    { id: "4821", week: "2026-W30" },
    null,
  );
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
    "s3cr3t",
  );
  expect(built.headers["cookie"]).toBe("sessionid=s3cr3t");
});

test("applies a csrf credential to its recorded header", () => {
  const built = buildRequest(
    manifest({ kind: "csrf", location: "x-csrf-token", mintedBy: null, expiry: null }),
    endpoint,
    { id: "1" },
    "tok123",
  );
  expect(built.headers["x-csrf-token"]).toBe("tok123");
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
  const built = buildRequest(
    manifest(null),
    endpoint,
    { id: "a b/c", week: "x&y" },
    null,
  );
  expect(built.url).toBe("https://x.test/api/roster/a%20b%2Fc?week=x%26y");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/transport.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/transport`.

- [ ] **Step 3: Write the implementation**

```ts
import type { ClientManifest, ManifestEndpoint } from "./manifest";

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export function buildRequest(
  manifest: ClientManifest,
  endpoint: ManifestEndpoint,
  params: Record<string, string>,
  secret: string | null,
): BuiltRequest {
  let path = endpoint.pathTemplate;
  for (const p of endpoint.params.filter((x) => x.in === "path")) {
    const value = params[p.name];
    if (value === undefined) {
      throw new Error(`missing required path param: ${p.name}`);
    }
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
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/transport.ts plugins/rkt/skills/derive-client/scripts/tests/transport.test.ts
git commit -m "feat(derive-client): add direct transport with pinned UA and auth"
```

---

## Task 9: The `call` subcommand

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/call.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/src/derive.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a CLI runnable as `bun src/call.ts --manifest <path> --endpoint <id> [--param k=v ...] [--dry-run]`, and `derive.ts` now runs the auth pass and writes the secret.

This is the task that makes the plan's output usable: after it, you can fetch a real endpoint from the terminal.

- [ ] **Step 1: Wire the auth pass into `derive.ts`**

In `src/derive.ts`, import the new modules:

```ts
import { analyzeAuth } from "./lib/auth";
import { writeSecret } from "./lib/secrets";
```

Change `deriveManifest` to run the auth pass and return the secret alongside:

```ts
export async function deriveManifest(
  harPath: string,
  site: string,
): Promise<{ manifest: ClientManifest; dropped: DropRecord[]; secret: string | null }> {
  const absHar = assertUnderRktRoot(resolve(harPath));
  const entries = await readHar(absHar);
  const { kept, dropped } = filterEntries(entries);
  const groups = groupEndpoints(kept);

  // Auth analysis runs over ALL entries, not just the filtered set: the login
  // response that mints a credential is often filtered out as a redirect or
  // an HTML document.
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

In `main()`, after writing `client.json`, persist the secret and report without leaking it:

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

Destructure `secret` from the `deriveManifest` call in `main()`.

- [ ] **Step 2: Write the failing test for the CLI's argument parsing**

Add `tests/call.test.ts`:

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

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/call.test.ts`
Expected: FAIL with a module-not-found error for `../src/call`.

- [ ] **Step 4: Write `src/call.ts`**

```ts
/**
 * Invoke a single derived endpoint.
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

  const built = buildRequest(manifest, endpoint, parseParams(process.argv), secret);

  if (process.argv.includes("--dry-run")) {
    const preview = {
      method: built.method,
      url: built.url,
      headers: built.headers,
    };
    console.log(redact(JSON.stringify(preview, null, 2), secret));
    return;
  }

  const { status, body } = await issue(built, createLimiter());
  if (status >= 400) {
    console.error(`HTTP ${status}`);
    console.error(redact(body.slice(0, 2000), secret));
    process.exit(1);
  }
  console.log(body);
}

if (import.meta.main) {
  await main();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS, all suites green.

- [ ] **Step 6: Smoke-test `--dry-run` end to end**

Use the Plan 1 smoketest recording, or make a fresh one. Then:

```bash
cd plugins/rkt/skills/derive-client/scripts
MANIFEST=$(ls -t ~/.rkt-clients/recordings/*/*/client.json | head -1)
ENDPOINT=$(jq -r '.endpoints[0].id' "$MANIFEST")
bun src/call.ts --manifest "$MANIFEST" --endpoint "$ENDPOINT" --dry-run
```

Expected: a JSON preview showing method, URL, and headers, with the pinned `user-agent` present. If a credential is stored, it must appear as `[REDACTED]`, never in clear text. Verify explicitly:

```bash
bun src/call.ts --manifest "$MANIFEST" --endpoint "$ENDPOINT" --dry-run | grep -c REDACTED || echo "no credential on this manifest (expected for example.com)"
```

- [ ] **Step 7: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/call.ts plugins/rkt/skills/derive-client/scripts/src/derive.ts plugins/rkt/skills/derive-client/scripts/tests/call.test.ts
git commit -m "feat(derive-client): add call subcommand and wire auth into derive"
```

---

## Task 10: SKILL.md auth gate and call docs

**Files:**
- Modify: `plugins/rkt/skills/derive-client/SKILL.md`

- [ ] **Step 1: Add the auth confirmation gate after the derive step**

Insert after the existing Step 6 (close and derive), renumbering as needed:

````markdown
## Step 7: Confirm the detected credential

`derive.ts` reports which credential it found, for example:

```
Stored cookie credential for "alayacare" at 0600 (location: cookie:sessionid).
Credential expires: 2026-08-01T00:00:00.000Z
```

Confirm with the user via `AskUserQuestion`:

> I detected a **cookie** credential at `cookie:sessionid`, used by 94% of the
> recorded API requests. Does that look like the session credential for this site?

Options: `Yes, that's the session credential` / `No, pick a different one` / `Not sure, show me the candidates`.

Never print the credential's value. Report only its kind, location, coverage,
and expiry.

If the user says the detection is wrong, re-run derivation and report the other
candidates by kind and location, again without values.

## Step 8: Verify with a real call

Prove auth works before declaring success:

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
MANIFEST="<recordingDir>/client.json"
(cd "$SCRIPTS" && bun src/call.ts --manifest "$MANIFEST" --endpoint <endpoint-id> --dry-run)
```

Inspect the dry-run output with the user, then run it for real by dropping
`--dry-run`. Compare the returned data against what the browser showed during
recording: match by **shape** (fields present, types, structure), not by exact
values, since live data changes between recording and replay.

If the call returns 401 or 403, the credential is wrong, expired, or bound to
something the transport does not replay. Re-record rather than guessing.
````

- [ ] **Step 2: Document the secrets location in the Artifacts section**

Add to the existing artifacts list:

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

## Task 11: Secret-leak guard and release chores

**Files:**
- Modify: `tests/test-derive-client.sh`
- Modify: `plugins/rkt/.claude-plugin/plugin.json`
- Modify: `plugins/rkt/.codex-plugin/plugin.json`
- Modify: `plugins/rkt/CHANGELOG.md`

- [ ] **Step 1: Add the secret-handling guards to the wrapper**

Insert before the `bun` check in `tests/test-derive-client.sh`:

```bash
# The manifest must never carry credential values.
if grep -q '"value"' "$SCRIPTS/src/lib/manifest.ts"; then
  echo "manifest.ts must not carry credential values; secrets belong in secrets.ts" >&2
  exit 1
fi

# Secret writes must be mode 0600.
grep -q '0o600' "$SCRIPTS/src/lib/secrets.ts" || {
  echo "secrets.ts must write credentials at mode 0600" >&2
  exit 1
}

# The call CLI must redact before printing.
grep -q 'redact(' "$SCRIPTS/src/call.ts" || {
  echo "call.ts must redact secrets before printing" >&2
  exit 1
}

# No secrets directory may be committed.
if git -C "$ROOT/../.." ls-files --error-unmatch '**/secrets/*.json' >/dev/null 2>&1; then
  echo "secrets files must never be committed" >&2
  exit 1
fi
```

- [ ] **Step 2: Run the full repo suite**

Run: `LANG=en_US.UTF-8 bash -c 'for t in tests/test-*.sh; do bash "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"; done'`

Expected: all `OK` except `tests/test-detect-stack.sh` when run from inside a worktree, which is a known pre-existing condition. `LANG` is set explicitly because `tests/test-plugin-manifests.sh` uses Ruby's `File.read`, which defaults to US-ASCII and fails on the non-ASCII characters present in several SKILL.md files.

- [ ] **Step 3: Bump both manifests in lockstep**

Set `"version": "0.5.0"` in both `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json`.

Verify: `jq -r .version plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json`
Expected: `0.5.0` twice.

- [ ] **Step 4: Prepend the CHANGELOG entry**

Insert directly below the `# Changelog` heading:

```markdown
## 0.5.0 — 2026-07-20

Adds authentication analysis and a `call` subcommand to `/derive-client`.

### Added

- **Auth analysis** — detects the session credential (cookie, bearer, or CSRF)
  from recorded traffic, traces where it was minted, and reads its expiry from
  a JWT `exp` claim or cookie attributes. The manifest records where the
  credential lives; the value goes to `<rkt-root>/secrets/<site>.json` at 0600.
- **`call` subcommand** — invokes any derived endpoint by id with path and query
  params, applying the stored credential, the pinned User-Agent and client
  hints, and human-shaped rate limiting. `--dry-run` prints the built request
  with the credential redacted.
- **Rate limiter** — serializes requests and spaces them 400 to 1300 ms.

### Changed

- `rktRoot()` now honors `RKT_CLIENTS_ROOT`, so tests redirect to a temp
  directory instead of writing to the user's real home. Production behavior
  is unchanged.

### Security

- Credentials are stored at mode 0600 in a 0700 directory, never in the repo,
  never in a manifest, and redacted from all CLI output. `tests/test-derive-client.sh`
  enforces these as structural guards.
```

- [ ] **Step 5: Validate the plugin package**

Run: `claude plugin validate plugins/rkt`
Expected: validation passes with no errors.

- [ ] **Step 6: Commit**

```bash
git add tests/test-derive-client.sh plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json plugins/rkt/CHANGELOG.md
git commit -m "chore(derive-client): bump to 0.5.0 and guard secret handling"
```

---

## Requirement → task map

| Spec requirement | Task |
| --- | --- |
| Pass 2 auth analysis identifies the credential | 2 |
| Trace where the credential is minted | 3 |
| Note expiry and refresh behavior | 4 |
| Auth pass reports and confirms rather than guessing | 5 (split return), 10 (gate) |
| `auth` block populated in the manifest | 5 |
| Secrets at `<root>/secrets/<site>.json`, mode 0600 | 6 |
| Secrets never in git, never printed | 6 (redaction), 11 (guards) |
| `direct` transport, standalone and cron-capable | 8 |
| Pinned UA and client hints replayed verbatim | 8 |
| Human-shaped rate limiting, concurrency 1 | 7 |
| `--dry-run` prints request with secrets redacted | 9 |
| Smoke-test the real thing end to end | 9 (Step 6) |
| Shape-not-value comparison when verifying | 10 (Step 8) |
| Carried review finding: tests must not write to real home | 1 |
| Manifest bump, CHANGELOG, `claude plugin validate` | 11 |

**Deferred to later plans, by design:** typed code generation and the shared runtime lib (Plan 3), repair and stale-endpoint retention (Plan 4), DOM scraper endpoints and `full` mode writes with the rollback journal (Plan 5).

## Open risks carried into execution

1. **AlayaCare's auth shape is still unknown.** If it uses short-lived tokens with a refresh dance, Task 2 will detect the access token but Task 4 will report a near-term expiry and `call` will fail soon after derivation. The mitigation is that `mintedBy` (Task 3) captures the refresh endpoint, making a Plan 3 refresh loop possible. If this happens, stop and re-plan rather than bolting refresh onto Task 8.
2. **Multiple credentials may be required simultaneously.** `analyzeAuth` picks the single highest-coverage candidate. A site needing both a session cookie *and* a CSRF header on every request will authenticate partially and fail. Detection surfaces all candidates, so this is visible in the confirmation gate rather than silent; if it occurs, `AuthSpec` needs to become a list, which is a schema change and therefore a `schemaVersion` bump.
3. **`fetch` does not replay the browser's full header set.** Some WAFs fingerprint beyond User-Agent (TLS fingerprint, header ordering, `Accept-Language`). If `call` returns 403 where the browser succeeded, the gap is here, and the next lever is copying more recorded request headers verbatim rather than adding more auth logic.
