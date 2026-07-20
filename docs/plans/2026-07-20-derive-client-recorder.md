# derive-client Plan 1: Recorder and Read-Only Derivation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a real logged-in browser session to a HAR, then derive a validated `client.json` endpoint manifest from it.

**Architecture:** A new skill at `plugins/rkt/skills/derive-client/` whose deterministic work lives in a Bun/TypeScript workspace under `scripts/`. `record.ts` owns a Playwright persistent Chrome context with HAR recording enabled and exposes a stdin JSON-lines control protocol so the driving agent can issue navigation steps; each step is appended to a replayable `flows.json`. `derive.ts` reads the resulting HAR and runs three pure passes (filter, synthesize, manifest) to emit `client.json`. All runtime artifacts are rooted absolutely under `~/.rkt-clients/`.

**Tech Stack:** Bun 1.3.11, TypeScript, Playwright (pinned), `bun test` for unit tests, bash for the repo-harness wrapper. Existing repo tooling: `jq`, `git`.

**Source spec:** `docs/specs/2026-07-20-derive-client-skill-design.md`

## Plan sequence

This plan is the first of five. Each produces working, testable software on its own.

1. **This plan** — recorder plus read-only derivation to `client.json` (spec slices 1 to 2).
2. Auth analysis pass and the `direct` transport (slice 3).
3. Code generator plus shared runtime lib, producing the working read-only CLI (slice 4).
4. Repair path with `flows.json` replay (slice 5).
5. DOM scraper endpoints (slice 6), then `full` mode writes with the rollback journal (slice 7).

Plans 1 to 3 are the minimum useful product.

## Design decision pinned by this plan

The spec did not say how the driving agent controls a browser that the recorder owns. The recorder must set `recordHar` at launch, so it owns the Playwright context; the guided crawl is agent-driven. Pinned resolution: **`record.ts` runs a control loop reading JSON-lines commands on stdin and writing JSON-lines results on stdout.** The agent issues one command per bash call. Every executed command is appended to `flows.json`, which is what makes flows replayable by Plan 4's repair path. This is the simplest approach that preserves recorder-owned HAR configuration, agent-driven navigation, and machine-replayable flows at once. Record it in `decisions.md` as part of Task 1.

## Global Constraints

- Runtime artifacts live under `~/.rkt-clients/` only. Never write skill artifacts to a cwd-relative path (AGENTS.md "Runtime Paths").
- Skills resolve bundled files via `RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"`. Never reference `./scripts/`.
- All interactive prompts use `AskUserQuestion`. Never bash `read` (`decisions.md:64`, AGENTS.md "Guardrails").
- No machine-local home paths (`/Users/rocket`) hardcoded in any skill file. `tests/test-visual-identity-skills.sh` enforces this pattern for other skills; Task 12 adds the equivalent check here.
- `recordHar.mode` must be `'full'`. `'minimal'` omits cookies and breaks the Plan 2 auth pass.
- `recordHar.content` must be `'attach'` with a `.zip` path. The default `'embed'` for non-zip paths inlines every response body into one JSON file.
- `serviceWorkers: 'block'` is mandatory on the recording context.
- Secrets never enter the repo. This plan writes no credentials; Plan 2 introduces `~/.rkt-clients/secrets/<site>.json` at mode `0600`.
- Plugin changes bump `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json` in lockstep, prepend a `plugins/rkt/CHANGELOG.md` entry, and pass `claude plugin validate plugins/rkt`. A new skill is a **minor** bump (current version `0.3.8`, so this plan ships `0.4.0`).
- Tests must be idempotent and use temp directories with cleanup traps.

---

## File Structure

**Created:**

- `plugins/rkt/skills/derive-client/SKILL.md` — skill entry point, frontmatter, consent and selection gates, how to invoke the scripts.
- `plugins/rkt/skills/derive-client/scripts/package.json` — Bun workspace, pinned Playwright.
- `plugins/rkt/skills/derive-client/scripts/tsconfig.json` — TypeScript config.
- `plugins/rkt/skills/derive-client/scripts/src/lib/paths.ts` — resolves every `~/.rkt-clients/` path. Single source of truth for artifact layout.
- `plugins/rkt/skills/derive-client/scripts/src/lib/lock.ts` — per-site profile lock acquire/release.
- `plugins/rkt/skills/derive-client/scripts/src/lib/har.ts` — reads `session.har.zip`, yields normalized entries.
- `plugins/rkt/skills/derive-client/scripts/src/lib/filter.ts` — pass 1, drops non-data traffic.
- `plugins/rkt/skills/derive-client/scripts/src/lib/synthesize.ts` — pass 3, path templating, param and response-shape inference.
- `plugins/rkt/skills/derive-client/scripts/src/lib/manifest.ts` — pass 4, `client.json` types, emission, validation.
- `plugins/rkt/skills/derive-client/scripts/src/record.ts` — recorder CLI and stdin control loop.
- `plugins/rkt/skills/derive-client/scripts/src/derive.ts` — derivation CLI.
- `plugins/rkt/skills/derive-client/scripts/tests/*.test.ts` — unit tests per lib module.
- `plugins/rkt/skills/derive-client/scripts/tests/fixtures/sample.har` — checked-in HAR fixture.
- `tests/test-derive-client.sh` — bash wrapper for the repo harness.

**Modified:**

- `decisions.md` — toolchain decision and control-protocol decision.
- `plugins/rkt/CHANGELOG.md` — 0.4.0 entry.
- `plugins/rkt/.claude-plugin/plugin.json`, `plugins/rkt/.codex-plugin/plugin.json` — version bump.

Each lib module has one responsibility and is independently testable. `record.ts` and `derive.ts` are thin CLI shells over them.

---

## Task 1: Toolchain scaffold and decisions entry

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/package.json`
- Create: `plugins/rkt/skills/derive-client/scripts/tsconfig.json`
- Create: `plugins/rkt/skills/derive-client/scripts/tests/smoke.test.ts`
- Create: `tests/test-derive-client.sh`
- Modify: `decisions.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a `bun test` target at `plugins/rkt/skills/derive-client/scripts/`, and `tests/test-derive-client.sh` discovered by the repo harness.

- [ ] **Step 1: Write the failing wrapper test**

Create `tests/test-derive-client.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugins/rkt" && pwd)"
SKILL="$ROOT/skills/derive-client"
SCRIPTS="$SKILL/scripts"

for path in \
  "$SKILL/SKILL.md" \
  "$SCRIPTS/package.json" \
  "$SCRIPTS/src/record.ts" \
  "$SCRIPTS/src/derive.ts"; do
  if [[ ! -f "$path" ]]; then
    echo "Missing derive-client artifact: ${path#$ROOT/}" >&2
    exit 1
  fi
done

HOME_PATH_PATTERN="/Users""/rocket"
if grep -R "$HOME_PATH_PATTERN" "$SKILL" >/dev/null 2>&1; then
  echo "derive-client must not hardcode machine-local home paths" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "derive-client: bun not installed, skipping unit tests" >&2
  echo "OK (skipped unit tests)"
  exit 0
fi

( cd "$SCRIPTS" && bun test )

echo "OK"
```

Make it executable: `chmod +x tests/test-derive-client.sh`

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/test-derive-client.sh`
Expected: FAIL with `Missing derive-client artifact: skills/derive-client/SKILL.md`

- [ ] **Step 3: Create the workspace files**

`plugins/rkt/skills/derive-client/scripts/package.json`:

```json
{
  "name": "rkt-derive-client",
  "private": true,
  "type": "module",
  "dependencies": {
    "playwright": "1.56.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "5.9.2"
  }
}
```

`plugins/rkt/skills/derive-client/scripts/tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`plugins/rkt/skills/derive-client/scripts/tests/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";

test("bun test harness runs", () => {
  expect(1 + 1).toBe(2);
});
```

Create placeholder entry points so the wrapper's file checks pass. `plugins/rkt/skills/derive-client/scripts/src/record.ts`:

```ts
// Recorder CLI. Implemented in Task 9.
export {};
```

`plugins/rkt/skills/derive-client/scripts/src/derive.ts`:

```ts
// Derivation CLI. Implemented in Task 10.
export {};
```

`plugins/rkt/skills/derive-client/SKILL.md` is written in full in Task 11. Create it now with only the frontmatter so the structural check passes:

```markdown
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

Body written in Task 11.
```

- [ ] **Step 4: Install dependencies and verify the wrapper passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun install && cd - && bash tests/test-derive-client.sh`
Expected: PASS, ending with `OK`. The `bun test` run reports 1 pass.

Note: `bun install` writes `node_modules/`, already covered by the repo `.gitignore`.

- [ ] **Step 5: Record both decisions**

Prepend to `decisions.md` (below the header block, above the newest existing entry), using the file's existing format:

```
[2026-07-20 14:00] | derive-client introduces a Bun/TypeScript workspace with a pinned Playwright dependency under `plugins/rkt/skills/derive-client/scripts/` | The plugin was bash + Python only. HAR recording requires Playwright, and the derivation passes need real data structures and typed manifests that bash cannot express safely. Scoped to the one skill: no other skill gains a Node dependency, and `tests/test-derive-client.sh` skips rather than fails when bun is absent | davies+claude (0.4.0)
[2026-07-20 14:05] | `record.ts` exposes a stdin JSON-lines control protocol; the driving agent issues one command per bash call and every command is appended to `flows.json` | The recorder must own the Playwright context to configure `recordHar` at launch, but the guided crawl is agent-driven. A stdin protocol keeps HAR configuration with the recorder, keeps navigation with the agent, and produces machine-replayable flows for the repair path in one mechanism | davies+claude (0.4.0)
```

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client tests/test-derive-client.sh decisions.md
git commit -m "feat(derive-client): scaffold bun workspace and test wrapper"
```

---

## Task 2: Path resolution

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/paths.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `rktRoot(): string`, `profileDir(site: string): string`, `lockFile(site: string): string`, `recordingDir(site: string, timestamp: string): string`, `secretsFile(site: string): string`, `sanitizeSite(site: string): string`. Every later task resolves paths through this module and never builds one by hand.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  profileDir,
  recordingDir,
  rktRoot,
  sanitizeSite,
  secretsFile,
} from "../src/lib/paths";

test("rktRoot is absolute and under the home directory", () => {
  expect(rktRoot()).toBe(`${homedir()}/.rkt-clients`);
});

test("paths are rooted, never cwd-relative", () => {
  for (const p of [
    profileDir("alayacare"),
    recordingDir("alayacare", "20260720T120000Z"),
    secretsFile("alayacare"),
  ]) {
    expect(p.startsWith(`${homedir()}/.rkt-clients/`)).toBe(true);
  }
});

test("recordingDir nests site and timestamp", () => {
  expect(recordingDir("alayacare", "20260720T120000Z")).toBe(
    `${homedir()}/.rkt-clients/recordings/alayacare/20260720T120000Z`,
  );
});

test("sanitizeSite strips path traversal and unsafe characters", () => {
  expect(sanitizeSite("../../etc/passwd")).toBe("etc-passwd");
  expect(sanitizeSite("Alaya Care.com")).toBe("alaya-care-com");
  expect(sanitizeSite("a/b")).toBe("a-b");
});

test("sanitizeSite rejects input that reduces to nothing", () => {
  expect(() => sanitizeSite("../..")).toThrow(/invalid site/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/paths.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/paths`.

- [ ] **Step 3: Write the implementation**

```ts
import { homedir } from "node:os";

export function rktRoot(): string {
  return `${homedir()}/.rkt-clients`;
}

export function sanitizeSite(site: string): string {
  const cleaned = site
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    throw new Error(`invalid site identifier: ${JSON.stringify(site)}`);
  }
  return cleaned;
}

export function profileDir(site: string): string {
  return `${rktRoot()}/profiles/${sanitizeSite(site)}`;
}

export function lockFile(site: string): string {
  return `${profileDir(site)}/.rkt-lock`;
}

export function recordingDir(site: string, timestamp: string): string {
  return `${rktRoot()}/recordings/${sanitizeSite(site)}/${timestamp}`;
}

export function secretsFile(site: string): string {
  return `${rktRoot()}/secrets/${sanitizeSite(site)}.json`;
}
```

`sanitizeSite` collapses every run of non-alphanumeric characters to a single hyphen, so `../../etc/passwd` becomes `etc-passwd` and cannot escape the root.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/paths.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/paths.ts plugins/rkt/skills/derive-client/scripts/tests/paths.test.ts
git commit -m "feat(derive-client): add rooted path resolution"
```

---

## Task 3: Profile lock

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/lock.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/lock.test.ts`

**Interfaces:**
- Consumes: `profileDir`, `lockFile` from `lib/paths`.
- Produces: `acquireLock(site: string): Promise<() => Promise<void>>` returning a release function, and `LockHeldError`. Chrome refuses two instances on one user-data dir, so `record.ts` (Task 9) and Plan 4's repair path both take this lock.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockHeldError } from "../src/lib/lock";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

test("acquire then release allows a second acquire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-lock-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const release = await acquireLock("testsite", dir);
  await release();

  const release2 = await acquireLock("testsite", dir);
  await release2();
  expect(true).toBe(true);
});

test("second acquire while held throws LockHeldError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-lock-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const release = await acquireLock("testsite", dir);
  cleanups.push(release);

  await expect(acquireLock("testsite", dir)).rejects.toThrow(LockHeldError);
});

test("a stale lock from a dead process is reclaimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-lock-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const profile = join(dir, "profiles", "testsite");
  await mkdir(profile, { recursive: true });
  // PID 2^22 + 1 is above the Linux/macOS pid_max ceiling, so it cannot be live.
  await writeFile(
    join(profile, ".rkt-lock"),
    JSON.stringify({ pid: 4194305, startedAt: new Date().toISOString() }),
  );

  const release = await acquireLock("testsite", dir);
  cleanups.push(release);
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/lock.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/lock`.

- [ ] **Step 3: Write the implementation**

The `root` parameter exists so tests can redirect away from the real home directory.

```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { sanitizeSite } from "./paths";

export class LockHeldError extends Error {
  constructor(site: string, pid: number) {
    super(
      `A derive-client session for "${site}" is already running (pid ${pid}). ` +
        `Chrome allows only one instance per profile. Wait for it to finish, ` +
        `or stop that process and retry.`,
    );
    this.name = "LockHeldError";
  }
}

interface LockBody {
  pid: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(
  site: string,
  root: string = `${homedir()}/.rkt-clients`,
): Promise<() => Promise<void>> {
  const profile = `${root}/profiles/${sanitizeSite(site)}`;
  const lockPath = `${profile}/.rkt-lock`;
  await mkdir(profile, { recursive: true });

  try {
    const raw = await readFile(lockPath, "utf8");
    const held = JSON.parse(raw) as LockBody;
    if (isProcessAlive(held.pid)) {
      throw new LockHeldError(site, held.pid);
    }
    // Stale lock: the owning process died without releasing. Reclaim it.
  } catch (err) {
    if (err instanceof LockHeldError) throw err;
    // Missing or unparseable lock file: treat as unlocked.
  }

  const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(lockPath, JSON.stringify(body), { mode: 0o600 });

  return async () => {
    await rm(lockPath, { force: true });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/lock.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/lock.ts plugins/rkt/skills/derive-client/scripts/tests/lock.test.ts
git commit -m "feat(derive-client): add per-site profile lock"
```

---

## Task 4: HAR reader

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/har.ts`
- Create: `plugins/rkt/skills/derive-client/scripts/tests/fixtures/sample.har`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/har.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `HarEntry` type and `readHar(path: string): Promise<HarEntry[]>`. Every later pass consumes `HarEntry[]`, never raw HAR JSON.

```ts
export interface HarEntry {
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  mimeType: string;
  responseBody: string | null;
  startedDateTime: string;
}
```

`readHar` accepts a `.har` file or a `.zip` archive. For `.zip` (what the recorder produces with `content: 'attach'`), bodies live as separate zip entries referenced by `response.content._file`, so the reader resolves them.

- [ ] **Step 1: Write the failing test**

Create the fixture `tests/fixtures/sample.har`. This is a minimal but structurally real HAR:

```json
{
  "log": {
    "version": "1.2",
    "creator": { "name": "playwright", "version": "1.56.0" },
    "entries": [
      {
        "startedDateTime": "2026-07-20T12:00:00.000Z",
        "request": {
          "method": "GET",
          "url": "https://example.test/api/v2/roster/4821?week=2026-W30",
          "headers": [
            { "name": "user-agent", "value": "Mozilla/5.0 Chrome/141.0.0.0" },
            { "name": "cookie", "value": "session=abc123" }
          ]
        },
        "response": {
          "status": 200,
          "headers": [{ "name": "content-type", "value": "application/json" }],
          "content": {
            "mimeType": "application/json",
            "text": "{\"shifts\":[{\"id\":1,\"client\":\"A\"}]}"
          }
        }
      },
      {
        "startedDateTime": "2026-07-20T12:00:01.000Z",
        "request": {
          "method": "GET",
          "url": "https://example.test/static/app.js",
          "headers": []
        },
        "response": {
          "status": 200,
          "headers": [{ "name": "content-type", "value": "application/javascript" }],
          "content": { "mimeType": "application/javascript", "text": "console.log(1)" }
        }
      }
    ]
  }
}
```

`tests/har.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readHar } from "../src/lib/har";

test("reads entries from a plain .har file", async () => {
  const entries = await readHar(`${import.meta.dir}/fixtures/sample.har`);
  expect(entries).toHaveLength(2);
});

test("normalizes headers to a lowercased map", async () => {
  const [first] = await readHar(`${import.meta.dir}/fixtures/sample.har`);
  expect(first.requestHeaders["user-agent"]).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(first.responseHeaders["content-type"]).toBe("application/json");
});

test("exposes method, url, status, mimeType and body", async () => {
  const [first] = await readHar(`${import.meta.dir}/fixtures/sample.har`);
  expect(first.method).toBe("GET");
  expect(first.url).toBe("https://example.test/api/v2/roster/4821?week=2026-W30");
  expect(first.status).toBe(200);
  expect(first.mimeType).toBe("application/json");
  expect(first.responseBody).toBe('{"shifts":[{"id":1,"client":"A"}]}');
});

test("throws a clear error on a malformed HAR", async () => {
  await expect(readHar(`${import.meta.dir}/fixtures/does-not-exist.har`)).rejects.toThrow(
    /could not read HAR/i,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/har.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/har`.

- [ ] **Step 3: Write the implementation**

```ts
import { readFile } from "node:fs/promises";

export interface HarEntry {
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  mimeType: string;
  responseBody: string | null;
  startedDateTime: string;
}

interface RawHeader {
  name: string;
  value: string;
}

function headerMap(headers: RawHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

export async function readHar(path: string): Promise<HarEntry[]> {
  let parsed: any;
  try {
    if (path.endsWith(".zip")) {
      parsed = await readHarFromZip(path);
    } else {
      parsed = JSON.parse(await readFile(path, "utf8"));
    }
  } catch (err) {
    throw new Error(`could not read HAR at ${path}: ${(err as Error).message}`);
  }

  const entries = parsed?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`could not read HAR at ${path}: missing log.entries`);
  }

  return entries.map((e: any) => ({
    method: e.request?.method ?? "GET",
    url: e.request?.url ?? "",
    status: e.response?.status ?? 0,
    requestHeaders: headerMap(e.request?.headers),
    responseHeaders: headerMap(e.response?.headers),
    mimeType: e.response?.content?.mimeType ?? "",
    responseBody: e.response?.content?.text ?? null,
    startedDateTime: e.startedDateTime ?? "",
  }));
}

async function readHarFromZip(path: string): Promise<any> {
  // Playwright writes har.har plus one file per attached body into the zip.
  const { unzipSync } = await import("fflate");
  const buf = await readFile(path);
  const files = unzipSync(new Uint8Array(buf));

  const harName = Object.keys(files).find((n) => n.endsWith(".har"));
  if (!harName) throw new Error("no .har entry inside archive");

  const decoder = new TextDecoder();
  const har = JSON.parse(decoder.decode(files[harName]));

  for (const entry of har?.log?.entries ?? []) {
    const ref = entry.response?.content?._file;
    if (ref && files[ref]) {
      entry.response.content.text = decoder.decode(files[ref]);
    }
  }
  return har;
}
```

Add the zip dependency. In `plugins/rkt/skills/derive-client/scripts/`:

Run: `bun add fflate@0.8.2`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/har.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts
git commit -m "feat(derive-client): add HAR reader supporting zip archives"
```

---

## Task 5: Filter pass

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/filter.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/filter.test.ts`

**Interfaces:**
- Consumes: `HarEntry` from `lib/har`.
- Produces: `filterEntries(entries: HarEntry[]): FilterResult` where `FilterResult` is `{ kept: HarEntry[]; dropped: DropRecord[] }` and `DropRecord` is `{ url: string; reason: string }`. The dropped list is reported to the user so silent over-filtering is visible.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { filterEntries } from "../src/lib/filter";

function entry(over: Partial<HarEntry>): HarEntry {
  return {
    method: "GET",
    url: "https://example.test/api/thing",
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: "{}",
    startedDateTime: "2026-07-20T12:00:00.000Z",
    ...over,
  };
}

test("keeps JSON API responses", () => {
  const { kept } = filterEntries([entry({})]);
  expect(kept).toHaveLength(1);
});

test("keeps HTML documents, which may carry scrape-only data", () => {
  const { kept } = filterEntries([
    entry({ mimeType: "text/html", url: "https://example.test/roster" }),
  ]);
  expect(kept).toHaveLength(1);
});

test("drops static assets by mime type", () => {
  const { kept, dropped } = filterEntries([
    entry({ mimeType: "application/javascript", url: "https://example.test/app.js" }),
    entry({ mimeType: "image/png", url: "https://example.test/logo.png" }),
    entry({ mimeType: "text/css", url: "https://example.test/app.css" }),
    entry({ mimeType: "font/woff2", url: "https://example.test/f.woff2" }),
  ]);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(4);
  expect(dropped[0].reason).toMatch(/static asset/i);
});

test("drops known analytics hosts even when they return JSON", () => {
  const { kept, dropped } = filterEntries([
    entry({ url: "https://www.google-analytics.com/collect" }),
    entry({ url: "https://api.segment.io/v1/track" }),
    entry({ url: "https://us.i.posthog.com/e/" }),
  ]);
  expect(kept).toHaveLength(0);
  expect(dropped.every((d) => /analytics/i.test(d.reason))).toBe(true);
});

test("drops non-success responses, which teach nothing about shape", () => {
  const { kept, dropped } = filterEntries([entry({ status: 404, responseBody: "not found" })]);
  expect(kept).toHaveLength(0);
  expect(dropped[0].reason).toMatch(/status/i);
});

test("drops entries with no response body", () => {
  const { kept } = filterEntries([entry({ responseBody: null })]);
  expect(kept).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/filter.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/filter`.

- [ ] **Step 3: Write the implementation**

```ts
import type { HarEntry } from "./har";

export interface DropRecord {
  url: string;
  reason: string;
}

export interface FilterResult {
  kept: HarEntry[];
  dropped: DropRecord[];
}

const STATIC_MIME = /^(image|font|video|audio)\/|javascript|text\/css|application\/wasm/i;

const ANALYTICS_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "segment.io",
  "segment.com",
  "posthog.com",
  "mixpanel.com",
  "amplitude.com",
  "sentry.io",
  "datadoghq.com",
  "intercom.io",
  "hotjar.com",
  "fullstory.com",
  "newrelic.com",
];

const DATA_MIME = /json|text\/html|xml/i;

export function filterEntries(entries: HarEntry[]): FilterResult {
  const kept: HarEntry[] = [];
  const dropped: DropRecord[] = [];

  for (const e of entries) {
    let host = "";
    try {
      host = new URL(e.url).hostname;
    } catch {
      dropped.push({ url: e.url, reason: "unparseable URL" });
      continue;
    }

    if (ANALYTICS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      dropped.push({ url: e.url, reason: `analytics or telemetry host (${host})` });
      continue;
    }
    if (STATIC_MIME.test(e.mimeType)) {
      dropped.push({ url: e.url, reason: `static asset (${e.mimeType})` });
      continue;
    }
    if (e.status < 200 || e.status >= 300) {
      dropped.push({ url: e.url, reason: `non-success status (${e.status})` });
      continue;
    }
    if (e.responseBody === null || e.responseBody.length === 0) {
      dropped.push({ url: e.url, reason: "empty response body" });
      continue;
    }
    if (!DATA_MIME.test(e.mimeType)) {
      dropped.push({ url: e.url, reason: `non-data content type (${e.mimeType})` });
      continue;
    }
    kept.push(e);
  }

  return { kept, dropped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/filter.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/filter.ts plugins/rkt/skills/derive-client/scripts/tests/filter.test.ts
git commit -m "feat(derive-client): add HAR filter pass"
```

---

## Task 6: Path templating and parameter inference

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/synthesize.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/synthesize.test.ts`

**Interfaces:**
- Consumes: `HarEntry` from `lib/har`.
- Produces: `templatePath(paths: string[]): string` and `groupEndpoints(entries: HarEntry[]): EndpointGroup[]` where `EndpointGroup` is `{ method: string; origin: string; pathTemplate: string; params: ParamSpec[]; samples: HarEntry[] }` and `ParamSpec` is `{ name: string; in: "path" | "query"; type: "string" | "number" }`. Task 7 adds response shapes to these groups; Task 8 turns them into manifest endpoints.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { groupEndpoints, templatePath } from "../src/lib/synthesize";

function entry(url: string, method = "GET"): HarEntry {
  return {
    method,
    url,
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: "{}",
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

test("templatePath replaces a numeric segment that varies", () => {
  expect(templatePath(["/api/roster/4821", "/api/roster/9002"])).toBe("/api/roster/{id}");
});

test("templatePath keeps a segment that never varies", () => {
  expect(templatePath(["/api/roster/list", "/api/roster/list"])).toBe("/api/roster/list");
});

test("templatePath replaces a varying UUID segment", () => {
  expect(
    templatePath([
      "/api/shift/1597d3a7-ed69-4f80-9c2c-2f5627ba24c2",
      "/api/shift/2a0b9c11-0000-4f80-9c2c-2f5627ba24c2",
    ]),
  ).toBe("/api/shift/{id}");
});

test("templatePath does not template a single observation", () => {
  expect(templatePath(["/api/roster/4821"])).toBe("/api/roster/4821");
});

test("templatePath numbers multiple varying segments distinctly", () => {
  expect(templatePath(["/api/client/12/visit/34", "/api/client/56/visit/78"])).toBe(
    "/api/client/{id}/visit/{id2}",
  );
});

test("groupEndpoints groups by method plus template and collects samples", () => {
  const groups = groupEndpoints([
    entry("https://example.test/api/roster/4821?week=2026-W30"),
    entry("https://example.test/api/roster/9002?week=2026-W31"),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].pathTemplate).toBe("/api/roster/{id}");
  expect(groups[0].origin).toBe("https://example.test");
  expect(groups[0].samples).toHaveLength(2);
});

test("groupEndpoints separates different methods on the same path", () => {
  const groups = groupEndpoints([
    entry("https://example.test/api/note/1", "GET"),
    entry("https://example.test/api/note/2", "POST"),
  ]);
  expect(groups).toHaveLength(2);
});

test("groupEndpoints infers path and query params with types", () => {
  const [group] = groupEndpoints([
    entry("https://example.test/api/roster/4821?week=2026-W30&limit=50"),
    entry("https://example.test/api/roster/9002?week=2026-W31&limit=25"),
  ]);
  const byName = Object.fromEntries(group.params.map((p) => [p.name, p]));
  expect(byName.id).toEqual({ name: "id", in: "path", type: "number" });
  expect(byName.week).toEqual({ name: "week", in: "query", type: "string" });
  expect(byName.limit).toEqual({ name: "limit", in: "query", type: "number" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/synthesize.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/synthesize`.

- [ ] **Step 3: Write the implementation**

```ts
import type { HarEntry } from "./har";

export interface ParamSpec {
  name: string;
  in: "path" | "query";
  type: "string" | "number";
}

export interface EndpointGroup {
  method: string;
  origin: string;
  pathTemplate: string;
  params: ParamSpec[];
  samples: HarEntry[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeIdentifier(segment: string): boolean {
  return /^\d+$/.test(segment) || UUID.test(segment);
}

function inferType(values: string[]): "string" | "number" {
  return values.every((v) => v !== "" && /^-?\d+(\.\d+)?$/.test(v)) ? "number" : "string";
}

/**
 * Replace segments that vary across observations with {id}, {id2}, and so on.
 * A single observation is never templated: one sample cannot show variation,
 * and guessing there would produce false parameters.
 */
export function templatePath(paths: string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((p) => p.split("/"));
  const width = split[0].length;
  if (!split.every((s) => s.length === width)) return paths[0];

  let counter = 0;
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const values = split.map((s) => s[i]);
    const varies = new Set(values).size > 1;
    if (varies && values.every(looksLikeIdentifier)) {
      counter += 1;
      out.push(counter === 1 ? "{id}" : `{id${counter}}`);
    } else {
      out.push(values[0]);
    }
  }
  return out.join("/");
}

export function groupEndpoints(entries: HarEntry[]): EndpointGroup[] {
  // First bucket by method plus a coarse shape key, so only comparable paths
  // are templated together.
  const buckets = new Map<string, HarEntry[]>();
  for (const e of entries) {
    const u = new URL(e.url);
    const shape = u.pathname
      .split("/")
      .map((s) => (looksLikeIdentifier(s) ? "*" : s))
      .join("/");
    const key = `${e.method} ${u.origin} ${shape}`;
    const list = buckets.get(key) ?? [];
    list.push(e);
    buckets.set(key, list);
  }

  const groups: EndpointGroup[] = [];
  for (const samples of buckets.values()) {
    const urls = samples.map((s) => new URL(s.url));
    const origin = urls[0].origin;
    const pathTemplate = templatePath(urls.map((u) => u.pathname));

    const params: ParamSpec[] = [];

    // Path params, in template order.
    const templateSegments = pathTemplate.split("/");
    const actualSegments = urls.map((u) => u.pathname.split("/"));
    templateSegments.forEach((seg, i) => {
      const match = seg.match(/^\{(\w+)\}$/);
      if (!match) return;
      params.push({
        name: match[1],
        in: "path",
        type: inferType(actualSegments.map((a) => a[i])),
      });
    });

    // Query params, union across samples.
    const queryValues = new Map<string, string[]>();
    for (const u of urls) {
      for (const [name, value] of u.searchParams) {
        queryValues.set(name, [...(queryValues.get(name) ?? []), value]);
      }
    }
    for (const [name, values] of queryValues) {
      params.push({ name, in: "query", type: inferType(values) });
    }

    groups.push({
      method: samples[0].method,
      origin,
      pathTemplate,
      params,
      samples,
    });
  }

  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/synthesize.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/synthesize.ts plugins/rkt/skills/derive-client/scripts/tests/synthesize.test.ts
git commit -m "feat(derive-client): add path templating and param inference"
```

---

## Task 7: Response shape inference

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/synthesize.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/shape.test.ts`

**Interfaces:**
- Consumes: `HarEntry`, `EndpointGroup` from `lib/synthesize`.
- Produces: `inferShape(bodies: string[]): JsonShape`, where `JsonShape` is a minimal JSON-Schema subset: `{ type: "object"; properties: Record<string, JsonShape>; required: string[] }` or `{ type: "array"; items: JsonShape }` or `{ type: "string" | "number" | "boolean" | "null" | "unknown" }`. Plan 3's generator turns these into TypeScript types, and Plan 3's smoke test compares by shape rather than value.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { inferShape } from "../src/lib/synthesize";

test("infers a flat object with scalar types", () => {
  expect(inferShape(['{"id":1,"name":"A","active":true}'])).toEqual({
    type: "object",
    properties: {
      id: { type: "number" },
      name: { type: "string" },
      active: { type: "boolean" },
    },
    required: ["id", "name", "active"],
  });
});

test("infers arrays from their first element", () => {
  expect(inferShape(['{"shifts":[{"id":1}]}'])).toEqual({
    type: "object",
    properties: {
      shifts: {
        type: "array",
        items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      },
    },
    required: ["shifts"],
  });
});

test("a field missing from one sample becomes optional", () => {
  const shape = inferShape(['{"id":1,"note":"x"}', '{"id":2}']);
  expect(shape).toEqual({
    type: "object",
    properties: { id: { type: "number" }, note: { type: "string" } },
    required: ["id"],
  });
});

test("an empty array yields unknown items rather than guessing", () => {
  expect(inferShape(['{"rows":[]}'])).toEqual({
    type: "object",
    properties: { rows: { type: "array", items: { type: "unknown" } } },
    required: ["rows"],
  });
});

test("a top-level array is supported", () => {
  expect(inferShape(['[{"id":1}]'])).toEqual({
    type: "array",
    items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  });
});

test("non-JSON bodies yield unknown instead of throwing", () => {
  expect(inferShape(["<html></html>"])).toEqual({ type: "unknown" });
});

test("null values are typed as null, not dropped", () => {
  expect(inferShape(['{"endedAt":null}'])).toEqual({
    type: "object",
    properties: { endedAt: { type: "null" } },
    required: ["endedAt"],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/shape.test.ts`
Expected: FAIL with `inferShape is not a function` or an import error.

- [ ] **Step 3: Append the implementation to `lib/synthesize.ts`**

```ts
export type JsonShape =
  | { type: "object"; properties: Record<string, JsonShape>; required: string[] }
  | { type: "array"; items: JsonShape }
  | { type: "string" | "number" | "boolean" | "null" | "unknown" };

function shapeOf(value: unknown): JsonShape {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? shapeOf(value[0]) : { type: "unknown" } };
  }
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      const properties: Record<string, JsonShape> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        properties[k] = shapeOf(v);
      }
      return { type: "object", properties, required: Object.keys(properties) };
    }
    default:
      return { type: "unknown" };
  }
}

/**
 * Merge shapes across samples. A key absent from any sample is optional,
 * which is why required is an intersection rather than a union.
 */
function mergeShapes(a: JsonShape, b: JsonShape): JsonShape {
  if (a.type === "unknown") return b;
  if (b.type === "unknown") return a;
  if (a.type === "object" && b.type === "object") {
    const properties: Record<string, JsonShape> = { ...a.properties };
    for (const [k, v] of Object.entries(b.properties)) {
      properties[k] = k in properties ? mergeShapes(properties[k], v) : v;
    }
    return {
      type: "object",
      properties,
      required: a.required.filter((k) => b.required.includes(k)),
    };
  }
  if (a.type === "array" && b.type === "array") {
    return { type: "array", items: mergeShapes(a.items, b.items) };
  }
  return a.type === b.type ? a : { type: "unknown" };
}

export function inferShape(bodies: string[]): JsonShape {
  let merged: JsonShape | null = null;
  for (const body of bodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { type: "unknown" };
    }
    const shape = shapeOf(parsed);
    merged = merged === null ? shape : mergeShapes(merged, shape);
  }
  return merged ?? { type: "unknown" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/shape.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/synthesize.ts plugins/rkt/skills/derive-client/scripts/tests/shape.test.ts
git commit -m "feat(derive-client): infer response shapes across samples"
```

---

## Task 8: Manifest emission

**Files:**
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/manifest.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts`

**Interfaces:**
- Consumes: `EndpointGroup`, `JsonShape`, `inferShape` from `lib/synthesize`.
- Produces: the `ClientManifest` and `ManifestEndpoint` types, `buildManifest(input): ClientManifest`, `validateManifest(value: unknown): ClientManifest`, and `SCHEMA_VERSION = 1`. Plan 2 fills the `auth` field; Plan 3's generator consumes `endpoints`; Plan 4's repair diffs two manifests.

This task emits `auth: null`. Plan 2 replaces it. That seam is deliberate: it lets the read-only pipeline ship and be tested before auth analysis exists.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { groupEndpoints } from "../src/lib/synthesize";
import { buildManifest, SCHEMA_VERSION, validateManifest } from "../src/lib/manifest";

function entry(url: string, body: string): HarEntry {
  return {
    method: "GET",
    url,
    status: 200,
    requestHeaders: {
      "user-agent": "Mozilla/5.0 Chrome/141.0.0.0",
      "sec-ch-ua": '"Chromium";v="141"',
      "sec-ch-ua-platform": '"macOS"',
    },
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: body,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

const groups = () =>
  groupEndpoints([
    entry("https://example.test/api/roster/4821", '{"shifts":[{"id":1}]}'),
    entry("https://example.test/api/roster/9002", '{"shifts":[{"id":2}]}'),
  ]);

test("builds a manifest with the pinned schema version", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc123",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.schemaVersion).toBe(SCHEMA_VERSION);
  expect(m.site).toBe("example");
  expect(m.harSha256).toBe("abc123");
});

test("pins the recorded user agent and client hints", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc123",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.userAgent).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(m.clientHints["sec-ch-ua"]).toBe('"Chromium";v="141"');
});

test("emits auth as null, to be filled by the auth pass", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.auth).toBeNull();
});

test("derives stable endpoint ids from method and template", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.endpoints[0].id).toBe("get.api.roster.id");
  expect(m.endpoints[0].pathTemplate).toBe("/api/roster/{id}");
  expect(m.endpoints[0].source).toBe("xhr");
  expect(m.endpoints[0].fragile).toBe(false);
});

test("marks HTML-sourced endpoints as fragile scrapes", () => {
  const htmlEntry: HarEntry = { ...entry("https://example.test/roster", "<html></html>"), mimeType: "text/html" };
  const m = buildManifest({
    site: "example",
    groups: groupEndpoints([htmlEntry]),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.endpoints[0].source).toBe("scrape");
  expect(m.endpoints[0].fragile).toBe(true);
});

test("validateManifest accepts a manifest it just built", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(validateManifest(JSON.parse(JSON.stringify(m)))).toEqual(m);
});

test("validateManifest rejects an unknown schema version", () => {
  expect(() => validateManifest({ schemaVersion: 99, site: "x", endpoints: [] })).toThrow(
    /schema version/i,
  );
});

test("validateManifest rejects a manifest with no endpoints array", () => {
  expect(() => validateManifest({ schemaVersion: 1, site: "x" })).toThrow(/endpoints/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/manifest.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/manifest`.

- [ ] **Step 3: Write the implementation**

```ts
import type { EndpointGroup, JsonShape, ParamSpec } from "./synthesize";
import { inferShape } from "./synthesize";

export const SCHEMA_VERSION = 1;

export interface AuthSpec {
  kind: "cookie" | "bearer" | "csrf";
  location: string;
  mintedBy: string | null;
  expiry: string | null;
}

export interface ManifestEndpoint {
  id: string;
  method: string;
  pathTemplate: string;
  params: ParamSpec[];
  responseShape: JsonShape;
  source: "xhr" | "scrape";
  fragile: boolean;
  selectors: Record<string, string> | null;
  writeSemantics: null;
  stale?: boolean;
}

export interface ClientManifest {
  schemaVersion: number;
  site: string;
  baseUrl: string;
  recordedAt: string;
  harSha256: string;
  userAgent: string;
  clientHints: Record<string, string>;
  auth: AuthSpec | null;
  endpoints: ManifestEndpoint[];
}

export interface BuildManifestInput {
  site: string;
  groups: EndpointGroup[];
  harSha256: string;
  recordedAt: string;
}

function endpointId(method: string, pathTemplate: string): string {
  const path = pathTemplate
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/^\{(\w+)\}$/, "$1"))
    .join(".");
  return `${method.toLowerCase()}.${path}`;
}

export function buildManifest(input: BuildManifestInput): ClientManifest {
  const { site, groups, harSha256, recordedAt } = input;
  const first = groups[0]?.samples[0];

  const endpoints: ManifestEndpoint[] = groups.map((g) => {
    const isHtml = /text\/html/i.test(g.samples[0]?.mimeType ?? "");
    return {
      id: endpointId(g.method, g.pathTemplate),
      method: g.method,
      pathTemplate: g.pathTemplate,
      params: g.params,
      responseShape: isHtml
        ? { type: "unknown" }
        : inferShape(g.samples.map((s) => s.responseBody ?? "")),
      source: isHtml ? "scrape" : "xhr",
      fragile: isHtml,
      selectors: null,
      writeSemantics: null,
    };
  });

  const clientHints: Record<string, string> = {};
  for (const key of ["sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile"]) {
    const value = first?.requestHeaders[key];
    if (value) clientHints[key] = value;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    site,
    baseUrl: groups[0]?.origin ?? "",
    recordedAt,
    harSha256,
    userAgent: first?.requestHeaders["user-agent"] ?? "",
    clientHints,
    auth: null,
    endpoints,
  };
}

export function validateManifest(value: unknown): ClientManifest {
  const m = value as Partial<ClientManifest>;
  if (typeof m !== "object" || m === null) {
    throw new Error("manifest must be an object");
  }
  if (m.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported manifest schema version ${String(m.schemaVersion)}; expected ${SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(m.endpoints)) {
    throw new Error("manifest must have an endpoints array");
  }
  if (typeof m.site !== "string" || m.site.length === 0) {
    throw new Error("manifest must have a site");
  }
  return m as ClientManifest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/manifest.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/manifest.ts plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts
git commit -m "feat(derive-client): emit and validate client.json manifest"
```

---

## Task 9: Recorder with stdin control protocol

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/record.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/protocol.test.ts`
- Create: `plugins/rkt/skills/derive-client/scripts/src/lib/protocol.ts`

**Interfaces:**
- Consumes: `acquireLock` from `lib/lock`, `profileDir`/`recordingDir` from `lib/paths`.
- Produces: `parseCommand(line: string): Command` and the `Command` union `{ kind: "goto"; url: string } | { kind: "click"; selector: string } | { kind: "fill"; selector: string; value: string } | { kind: "wait"; ms: number } | { kind: "snapshot" } | { kind: "done" }`. `record.ts` becomes runnable as `bun src/record.ts --site <site>`.

Command parsing is pure and unit-tested. The browser loop is verified by the live smoke test in Step 6, because a real Chrome launch cannot be meaningfully unit-tested.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { parseCommand } from "../src/lib/protocol";

test("parses a goto command", () => {
  expect(parseCommand('{"kind":"goto","url":"https://example.test"}')).toEqual({
    kind: "goto",
    url: "https://example.test",
  });
});

test("parses click, fill, wait, snapshot and done", () => {
  expect(parseCommand('{"kind":"click","selector":"#next"}')).toEqual({
    kind: "click",
    selector: "#next",
  });
  expect(parseCommand('{"kind":"fill","selector":"#q","value":"x"}')).toEqual({
    kind: "fill",
    selector: "#q",
    value: "x",
  });
  expect(parseCommand('{"kind":"wait","ms":500}')).toEqual({ kind: "wait", ms: 500 });
  expect(parseCommand('{"kind":"snapshot"}')).toEqual({ kind: "snapshot" });
  expect(parseCommand('{"kind":"done"}')).toEqual({ kind: "done" });
});

test("rejects an unknown command kind", () => {
  expect(() => parseCommand('{"kind":"eval","code":"1"}')).toThrow(/unknown command/i);
});

test("rejects a goto without a url", () => {
  expect(() => parseCommand('{"kind":"goto"}')).toThrow(/url/i);
});

test("rejects a non-http url scheme", () => {
  expect(() => parseCommand('{"kind":"goto","url":"file:///etc/passwd"}')).toThrow(/http/i);
});

test("rejects malformed JSON with a clear message", () => {
  expect(() => parseCommand("not json")).toThrow(/invalid command JSON/i);
});

test("clamps an excessive wait to the ceiling", () => {
  expect(parseCommand('{"kind":"wait","ms":999999}')).toEqual({ kind: "wait", ms: 30000 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/protocol.test.ts`
Expected: FAIL with a module-not-found error for `../src/lib/protocol`.

- [ ] **Step 3: Write the protocol module**

`src/lib/protocol.ts`:

```ts
export type Command =
  | { kind: "goto"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "wait"; ms: number }
  | { kind: "snapshot" }
  | { kind: "done" };

const MAX_WAIT_MS = 30000;

export function parseCommand(line: string): Command {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`invalid command JSON: ${line.slice(0, 80)}`);
  }

  switch (raw?.kind) {
    case "goto": {
      if (typeof raw.url !== "string" || raw.url.length === 0) {
        throw new Error("goto requires a url");
      }
      if (!/^https?:\/\//i.test(raw.url)) {
        throw new Error("goto url must use http or https");
      }
      return { kind: "goto", url: raw.url };
    }
    case "click": {
      if (typeof raw.selector !== "string") throw new Error("click requires a selector");
      return { kind: "click", selector: raw.selector };
    }
    case "fill": {
      if (typeof raw.selector !== "string") throw new Error("fill requires a selector");
      if (typeof raw.value !== "string") throw new Error("fill requires a value");
      return { kind: "fill", selector: raw.selector, value: raw.value };
    }
    case "wait": {
      const ms = Number(raw.ms);
      if (!Number.isFinite(ms) || ms < 0) throw new Error("wait requires a non-negative ms");
      return { kind: "wait", ms: Math.min(ms, MAX_WAIT_MS) };
    }
    case "snapshot":
      return { kind: "snapshot" };
    case "done":
      return { kind: "done" };
    default:
      throw new Error(`unknown command kind: ${String(raw?.kind)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/protocol.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the recorder**

Replace `src/record.ts` entirely:

```ts
/**
 * Recorder: owns a persistent Chrome context with HAR recording enabled and
 * executes navigation commands read as JSON lines on stdin.
 *
 * Usage: bun src/record.ts --site <site>
 *
 * Every executed command is appended to flows.json so the repair path can
 * replay the session later.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { acquireLock } from "./lib/lock";
import { profileDir, recordingDir } from "./lib/paths";
import { parseCommand } from "./lib/protocol";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function respond(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const site = arg("site");
  if (!site) {
    respond({ ok: false, error: "missing --site" });
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const outDir = recordingDir(site, timestamp);
  await mkdir(outDir, { recursive: true });

  const release = await acquireLock(site);
  const flowsPath = `${outDir}/flows.json`;
  await writeFile(flowsPath, "");

  const context = await chromium.launchPersistentContext(profileDir(site), {
    channel: "chrome",
    headless: false,
    serviceWorkers: "block",
    recordHar: {
      path: `${outDir}/session.har.zip`,
      content: "attach",
      mode: "full",
    },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  respond({ ok: true, event: "ready", recordingDir: outDir });

  try {
    for await (const line of console) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let command;
      try {
        command = parseCommand(trimmed);
      } catch (err) {
        respond({ ok: false, error: (err as Error).message });
        continue;
      }

      if (command.kind === "done") break;

      try {
        switch (command.kind) {
          case "goto":
            await page.goto(command.url, { waitUntil: "domcontentloaded" });
            break;
          case "click":
            await page.click(command.selector);
            break;
          case "fill":
            await page.fill(command.selector, command.value);
            break;
          case "wait":
            await page.waitForTimeout(command.ms);
            break;
          case "snapshot":
            break;
        }

        // Human-shaped pacing between actions.
        await page.waitForTimeout(400 + Math.floor(Math.random() * 900));
        await appendFile(flowsPath, `${JSON.stringify(command)}\n`);
        respond({ ok: true, url: page.url(), title: await page.title() });
      } catch (err) {
        respond({ ok: false, error: (err as Error).message, url: page.url() });
      }
    }
  } finally {
    // The HAR is only written on close, so this must always run.
    await context.close();
    await release();
    respond({ ok: true, event: "closed", recordingDir: outDir });
  }
}

main().catch(async (err) => {
  respond({ ok: false, error: (err as Error).message });
  process.exit(1);
});
```

Note: `for await (const line of console)` is Bun's stdin line iterator.

Install the browser binary if Playwright has not already: `cd plugins/rkt/skills/derive-client/scripts && bunx playwright install chrome`

- [ ] **Step 6: Smoke-test the recorder against a real site**

This exercises the real thing end to end: a real Chrome launch, a real navigation, a real HAR on disk. Run:

```bash
cd plugins/rkt/skills/derive-client/scripts
printf '%s\n' '{"kind":"goto","url":"https://example.com"}' '{"kind":"done"}' \
  | bun src/record.ts --site smoketest
```

Expected: Chrome opens visibly, navigates to example.com, and closes. stdout shows three JSON lines: a `ready` event, an `ok` result with `"url":"https://example.com/"`, and a `closed` event.

Then verify the artifacts:

```bash
ls -la ~/.rkt-clients/recordings/smoketest/*/
```

Expected: `session.har.zip` present and non-empty, plus `flows.json` containing exactly one line, the `goto` command.

Confirm the lock released:

```bash
test ! -f ~/.rkt-clients/profiles/smoketest/.rkt-lock && echo "lock released"
```

Expected: `lock released`.

- [ ] **Step 7: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/record.ts plugins/rkt/skills/derive-client/scripts/src/lib/protocol.ts plugins/rkt/skills/derive-client/scripts/tests/protocol.test.ts
git commit -m "feat(derive-client): add recorder with stdin control protocol"
```

---

## Task 10: Derivation CLI

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/derive.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/derive.test.ts`

**Interfaces:**
- Consumes: `readHar`, `filterEntries`, `groupEndpoints`, `buildManifest`, `validateManifest`.
- Produces: `deriveManifest(harPath: string, site: string): Promise<{ manifest: ClientManifest; dropped: DropRecord[] }>` and a CLI runnable as `bun src/derive.ts --site <site> --har <path>` that writes `client.json` next to the HAR.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { deriveManifest } from "../src/derive";

test("derives a manifest end to end from the fixture HAR", async () => {
  const { manifest, dropped } = await deriveManifest(
    `${import.meta.dir}/fixtures/sample.har`,
    "example",
  );

  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.site).toBe("example");
  expect(manifest.baseUrl).toBe("https://example.test");

  // The .js asset is filtered out; only the roster API survives.
  expect(manifest.endpoints).toHaveLength(1);
  expect(manifest.endpoints[0].method).toBe("GET");
  expect(manifest.endpoints[0].pathTemplate).toBe("/api/v2/roster/4821");
  expect(dropped.some((d) => d.url.endsWith("app.js"))).toBe(true);
});

test("pins the user agent observed in the recording", async () => {
  const { manifest } = await deriveManifest(`${import.meta.dir}/fixtures/sample.har`, "example");
  expect(manifest.userAgent).toBe("Mozilla/5.0 Chrome/141.0.0.0");
});

test("computes a content hash of the HAR", async () => {
  const { manifest } = await deriveManifest(`${import.meta.dir}/fixtures/sample.har`, "example");
  expect(manifest.harSha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the derived manifest passes its own validator", async () => {
  const { manifest } = await deriveManifest(`${import.meta.dir}/fixtures/sample.har`, "example");
  const { validateManifest } = await import("../src/lib/manifest");
  expect(() => validateManifest(JSON.parse(JSON.stringify(manifest)))).not.toThrow();
});

test("a HAR with no data traffic yields zero endpoints, not a crash", async () => {
  const { manifest } = await deriveManifest(
    `${import.meta.dir}/fixtures/assets-only.har`,
    "example",
  );
  expect(manifest.endpoints).toHaveLength(0);
});
```

Create `tests/fixtures/assets-only.har`, the empty-result case:

```json
{
  "log": {
    "version": "1.2",
    "creator": { "name": "playwright", "version": "1.56.0" },
    "entries": [
      {
        "startedDateTime": "2026-07-20T12:00:00.000Z",
        "request": { "method": "GET", "url": "https://example.test/app.js", "headers": [] },
        "response": {
          "status": 200,
          "headers": [],
          "content": { "mimeType": "application/javascript", "text": "console.log(1)" }
        }
      }
    ]
  }
}
```

Note: `/api/v2/roster/4821` is not templated because the fixture has only one observation of it, and `templatePath` deliberately does not template a single sample.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/derive.test.ts`
Expected: FAIL with `deriveManifest is not exported` or an import error.

- [ ] **Step 3: Write the implementation**

Replace `src/derive.ts` entirely:

```ts
/**
 * Derivation CLI: reads a recorded HAR and emits client.json.
 *
 * Usage: bun src/derive.ts --site <site> --har <path/to/session.har.zip>
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { filterEntries, type DropRecord } from "./lib/filter";
import { readHar } from "./lib/har";
import { buildManifest, type ClientManifest } from "./lib/manifest";
import { groupEndpoints } from "./lib/synthesize";

export async function deriveManifest(
  harPath: string,
  site: string,
): Promise<{ manifest: ClientManifest; dropped: DropRecord[] }> {
  const entries = await readHar(harPath);
  const { kept, dropped } = filterEntries(entries);
  const groups = groupEndpoints(kept);

  const harSha256 = createHash("sha256").update(await readFile(harPath)).digest("hex");
  const recordedAt = entries[0]?.startedDateTime ?? new Date().toISOString();

  return { manifest: buildManifest({ site, groups, harSha256, recordedAt }), dropped };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const site = arg("site");
  const har = arg("har");
  if (!site || !har) {
    console.error("usage: bun src/derive.ts --site <site> --har <path>");
    process.exit(1);
  }

  const { manifest, dropped } = await deriveManifest(har, site);
  const outPath = `${dirname(har)}/client.json`;
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.error(`Derived ${manifest.endpoints.length} endpoint(s) -> ${outPath}`);
  console.error(`Filtered out ${dropped.length} request(s).`);
  for (const endpoint of manifest.endpoints) {
    console.error(`  ${endpoint.method} ${endpoint.pathTemplate}  [${endpoint.id}]`);
  }
  if (manifest.endpoints.length === 0) {
    console.error(
      "\nNo endpoints derived. If the site routes API calls through a Service Worker, " +
        "the recording will be empty even though the site worked. Re-record and confirm " +
        "serviceWorkers: 'block' was in effect.",
    );
  }
}

if (import.meta.main) {
  await main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS, all suites green (paths 5, lock 3, har 4, filter 6, synthesize 8, shape 7, manifest 8, protocol 7, derive 5, smoke 1).

- [ ] **Step 5: Smoke-test derivation against the real recording from Task 9**

```bash
cd plugins/rkt/skills/derive-client/scripts
HAR=$(ls -d ~/.rkt-clients/recordings/smoketest/*/session.har.zip | head -1)
bun src/derive.ts --site smoketest --har "$HAR"
```

Expected: a summary on stderr and a `client.json` written beside the HAR. example.com serves only HTML, so expect one scrape-source endpoint, or zero endpoints with the Service Worker hint. Both outcomes are correct here; the point is that the zip path parses and a valid manifest is written.

Verify: `jq '.schemaVersion, .userAgent' "$(dirname "$HAR")/client.json"`
Expected: `1` and a real Chrome user-agent string, confirming zip reading and UA pinning work on genuine Playwright output rather than only the fixture.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/derive.ts plugins/rkt/skills/derive-client/scripts/tests/derive.test.ts plugins/rkt/skills/derive-client/scripts/tests/fixtures
git commit -m "feat(derive-client): add derivation CLI producing client.json"
```

---

## Task 11: SKILL.md

**Files:**
- Modify: `plugins/rkt/skills/derive-client/SKILL.md`

**Interfaces:**
- Consumes: `record.ts` and `derive.ts` CLIs from Tasks 9 and 10.
- Produces: the user-facing skill. Plans 2 to 5 extend this file rather than replacing it.

- [ ] **Step 1: Write the skill body**

Keep the Task 1 frontmatter and replace the placeholder body:

````markdown
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
````

- [ ] **Step 2: Verify the wrapper still passes**

Run: `bash tests/test-derive-client.sh`
Expected: PASS, ending `OK`. The no-hardcoded-home-path check must stay green; the skill uses `~/` and `$RKT_PLUGIN_ROOT`, never `/Users/<name>`.

- [ ] **Step 3: Commit**

```bash
git add plugins/rkt/skills/derive-client/SKILL.md
git commit -m "docs(derive-client): write skill body with consent and crawl flow"
```

---

## Task 12: Release chores

**Files:**
- Modify: `plugins/rkt/.claude-plugin/plugin.json`
- Modify: `plugins/rkt/.codex-plugin/plugin.json`
- Modify: `plugins/rkt/CHANGELOG.md`
- Modify: `tests/test-derive-client.sh`

- [ ] **Step 1: Extend the wrapper to assert the conventions this skill must keep**

Insert before the `bun` check in `tests/test-derive-client.sh`:

```bash
grep -q 'AskUserQuestion' "$SKILL/SKILL.md" || {
  echo "derive-client must use AskUserQuestion for prompts" >&2
  exit 1
}

grep -q 'RKT_PLUGIN_ROOT' "$SKILL/SKILL.md" || {
  echo "derive-client should document plugin-root resolution" >&2
  exit 1
}

for required in "serviceWorkers" "content" "mode"; do
  grep -q "$required" "$SCRIPTS/src/record.ts" || {
    echo "record.ts must set recordHar/$required explicitly" >&2
    exit 1
  }
done

grep -q "'full'" "$SCRIPTS/src/record.ts" || grep -q '"full"' "$SCRIPTS/src/record.ts" || {
  echo "recordHar.mode must be 'full' or the auth pass loses cookies" >&2
  exit 1
}
```

- [ ] **Step 2: Run the full repo suite**

Run: `for t in tests/test-*.sh; do bash "$t" | tail -1; done`
Expected: every test prints `OK` or its existing success line. No failures.

- [ ] **Step 3: Bump both manifests in lockstep**

Set `"version": "0.4.0"` in both `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json`. This is a minor bump: a new skill is a new user-visible capability.

Verify: `jq -r .version plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json`
Expected: `0.4.0` twice.

- [ ] **Step 4: Prepend the CHANGELOG entry**

Insert directly below the `# Changelog` heading in `plugins/rkt/CHANGELOG.md`:

```markdown
## 0.4.0 — 2026-07-20

Adds `derive-client`: record a logged-in browser session and derive a typed
client manifest for a site's internal API.

### Added

- **`/derive-client` skill** — records a HAR from the user's real Chrome via a
  persistent profile, then derives a validated `client.json` endpoint manifest.
  Read-only in this release: auth analysis, code generation, repair, and write
  mode follow in later releases.
- **Bun/TypeScript workspace** at `skills/derive-client/scripts/` with a pinned
  Playwright dependency. First non-bash runtime in the plugin, scoped to this
  skill; `tests/test-derive-client.sh` skips rather than fails when bun is absent.

### Notes

- Recording requires a fresh sign-in the first time any site is recorded: the
  Playwright profile is separate from the user's day-to-day Chrome profile,
  which Chrome 136+ blocks from automation.
- Sites that route API traffic through a Service Worker will record empty.
  The recorder sets `serviceWorkers: 'block'` to prevent this where possible.
```

- [ ] **Step 5: Validate the plugin package**

Run: `claude plugin validate plugins/rkt`
Expected: validation passes with no errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json plugins/rkt/CHANGELOG.md tests/test-derive-client.sh
git commit -m "chore(derive-client): bump to 0.4.0 and add convention guards"
```

---

## Requirement → task map

Spec sections covered by this plan:

| Spec requirement | Task |
| --- | --- |
| Artifacts rooted under `~/.rkt-clients/`, never cwd-relative | 2 |
| Per-site profile lock preventing concurrent runs | 3 |
| `launchPersistentContext` with `channel: 'chrome'`, headed | 9 |
| `recordHar` with `.zip` path, `content: 'attach'`, `mode: 'full'` | 9, guarded in 12 |
| `serviceWorkers: 'block'` mandatory | 9, guarded in 12 |
| HAR finalized via guaranteed `context.close()` | 9 (try/finally) |
| Fresh profile means first-run sign-in; agent never handles credentials | 11 (Step 3) |
| Consent gate via `AskUserQuestion` | 11 (Step 0), guarded in 12 |
| Section selection via `AskUserQuestion` | 11 (Step 4) |
| Human-shaped pacing during the crawl | 9 (inter-action delay) |
| `flows.json` machine-replayable steps | 9 |
| Pass 1 filter, with visible drop reasons | 5 |
| Pass 3 endpoint synthesis, path templating, param inference | 6 |
| Response shape inference | 7 |
| Pass 4 manifest with `schemaVersion` and `harSha256` | 8 |
| Pinned UA and client hints | 8, verified live in 10 |
| HTML-sourced endpoints marked `fragile` / `source: scrape` | 8 |
| Fixture-based TDD for derivation passes | 4 to 8, 10 |
| Bash wrapper skipping cleanly without bun | 1 |
| No hardcoded machine-local home paths | 1, 12 |
| Toolchain decision recorded in `decisions.md` | 1 |
| Control-protocol decision recorded in `decisions.md` | 1 |
| Manifest bump, CHANGELOG, `claude plugin validate` | 12 |
| Smoke-test the real thing end to end | 9 (Step 6), 10 (Step 5) |

**Deferred to later plans, by design:** auth analysis (`auth: null` seam, Plan 2), the `direct` transport (Plan 2), code generation and the shared runtime lib (Plan 3), secrets file at `0600` (Plan 2), repair and stale-endpoint retention (Plan 4), DOM selector maps (Plan 5), `full` mode writes and the rollback journal (Plan 5).

## Open risks carried into execution

1. **AlayaCare Service Worker behavior is unknown.** If it proxies API traffic through one and breaks under `serviceWorkers: 'block'`, Task 9's approach needs revisiting for that target. Task 10's zero-endpoint message is the detection mechanism.
2. **`rkt-clients` repo does not exist yet.** This plan does not need it (nothing is generated until Plan 3), so creating it is deferred rather than forgotten.
3. **Playwright version pin (`1.56.0`) is a guess at install time.** If `bun install` resolves a different current version, pin whatever installs cleanly and update the `package.json` in Task 1 rather than fighting it.
