# derive-client full mode (read + write) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a derived client expose a site's write endpoints as curated, previewable, gated commands, so a human or an agent can mutate state without any path to a silent irreversible write.

**Architecture:** Derivation gains a `--mode full` flag that keeps non-GET/HEAD entries and models their request body as shape + format hints (never values). The curated `commands.json` task gains a `body` template whose `@arg:` holes become typed CLI flags. A write only fires when four independent gates all pass: derived in full mode, `RKT_ALLOW_WRITES` enabled, curated task authored, `--commit` passed. Writes never auto-retry.

**Tech Stack:** Bun 1.3.11, TypeScript strict, `bun test`, `bunx tsc --noEmit`, `claude plugin validate plugins/rkt`.

**Source spec:** `docs/specs/2026-07-23-derive-client-full-mode-design.md` (blind-reviewed 3x).

## Global Constraints

- All paths below are relative to `/Users/rocket/Documents/Repositories/rkt-stack`. Runtime source lives under `plugins/rkt/skills/derive-client/scripts/src/`, tests under `plugins/rkt/skills/derive-client/scripts/tests/`.
- **TDD, no exceptions.** Failing test first, watch it fail, minimal code to pass, commit.
- **No new files in `lib/`.** `RUNTIME_FILES` in `src/generate.ts` must stay unchanged. Runtime-side logic goes in existing copied modules (`command-runner.ts`, `transport.ts`, `tokens.ts`); derivation-only logic goes in `synthesize.ts`/`manifest.ts` (not copied to clients).
- **Safety checks are structural, never name-based:** read/write is `READ_METHODS.has(method)`; full mode is `manifest.mode === "full"`.
- **`RKT_ALLOW_WRITES` truthiness is fail-closed:** enabled iff the value is exactly `"1"` or `"true"`. Unset, `""`, `"0"`, `"false"` are all disabled.
- **`@arg:` names map to flags verbatim** (no kebab-casing): `@arg:starts_at` -> `--starts_at`.
- **Writes never auto-retry:** no 429/503 backoff re-send, no 401 re-issue after renewal.
- **Never commit to `main`.** All work lands on the Task 0 branch.
- Conventional Commits ending with the trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Do NOT bump plugin manifest versions in these tasks. Version bump happens once at release time per `AGENTS.md` Release Flow. Add entries under `## [Unreleased]` in `plugins/rkt/CHANGELOG.md` as you go. **`CHANGELOG.md` currently has no `## [Unreleased]` heading** (it starts at `## [0.10.0] - 2026-07-23`), so the first task to touch it creates that heading above `[0.10.0]`.
- **Version context:** `0.10.0` has already shipped (both `plugin.json` manifests read `0.10.0`). The spec header's "targets v0.10.0" is stale; this work lands as **v0.11.0** at release time. Do not act on the spec's version number.
- **`cmd.write` is a declaration, not a gate.** Every runtime decision keys on the endpoint's method. `assertResolvable` enforces that the declaration agrees with the method; nothing else may trust it.
- **Before removing any guard, enumerate its callers.** `buildRequest`'s non-read throw is load-bearing for `src/call.ts` as well as the CLI (see Task 5).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/manifest-schema.ts` | `WriteSemantics`, `mode`, `SCHEMA_VERSION` 3, accept v2-or-v3 | 1 |
| `src/lib/filter.ts` | keep writes; skip response-quality gates for writes | 2 |
| `src/lib/synthesize.ts` | body shape from `postData`, format hints, key scrub | 3 |
| `src/lib/manifest.ts` | populate `writeSemantics` + `mode` at construction | 4 |
| `src/derive.ts` | `--mode full` flag, `deriveManifest` signature | 4 |
| `src/lib/scheduler.ts` | `SchedulerRequest.body`, forward to `fetch`, no write retry | 5 |
| `src/lib/transport.ts` | `buildRequest` body param, `issue` sends + env gate, `writesEnabled()` | 5 |
| `src/lib/runtime.ts` | `Caller.call` body, no 401 re-issue for writes | 6 |
| `src/lib/commands-schema.ts` | `write`, `call.body`, validation + `assertResolvable` rules | 7 |
| `src/lib/tokens.ts` | `@arg:` token, `TokenContext.args` | 8 |
| `src/lib/command-runner.ts` | body materialiser + coercion, preview/send result | 9 |
| `src/lib/codegen.ts` | conditional write throw, write emission, listing gate | 10 |
| `src/scaffold-commands.ts` | `write: true` stubs with `@arg:` body | 11 |
| `plugins/rkt/skills/derive-client/SKILL.md` + `README.md` | full-mode guidance | 12 |

Tasks are sequentially dependent: 1 -> 2/3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> 12. Do not parallelise.

---

### Task 0: Feature branch + plan commit

**Files:**
- Create: `docs/plans/2026-07-24-derive-client-full-mode.md` (this file, already written)

**Ordering note:** the repo is currently on `main` with the spec and this plan
**untracked**. Nothing else in this plan may run until Steps 1-2 complete, or the
first implementation commit lands on `main`.

- [ ] **Step 1: Create the branch**

Standing convention is to do feature work in a worktree with dependency dirs
symlinked, entered via the native worktree tooling rather than a bare
`git worktree add`. Use that if the harness exposes it; the spec and plan are
untracked, so carry them across before committing. Plain-branch fallback:

```bash
git -C /Users/rocket/Documents/Repositories/rkt-stack checkout -b feat/derive-client-full-mode
```

If you take the worktree path, `node_modules` under
`plugins/rkt/skills/derive-client/scripts/` must be symlinked from the main
checkout rather than reinstalled, or every `bun test` step is slower than the
task it verifies.

- [ ] **Step 2: Commit the spec and plan**

```bash
git add docs/specs/2026-07-23-derive-client-full-mode-design.md docs/plans/2026-07-24-derive-client-full-mode.md
git commit -m "$(cat <<'EOF'
docs: add derive-client full mode spec and plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Baseline green**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: all tests pass (current baseline, 354+ tests).

Also run the repo-level shell suite once now, so you know which failures (if any)
predate your work:

Run: `cd /Users/rocket/Documents/Repositories/rkt-stack && for t in tests/test-*.sh; do bash "$t" | tail -1; done`
Expected: all pass. This is the `AGENTS.md` "Making Changes" gate and Task 12
runs it again at the end.

**Integration is not part of this plan.** After Task 12 is green, merging is a
separate, explicitly authorised step: merge commits only (`--merge`, never squash
or rebase-merge), and seek approval before any push to `main` or any tag.

---

### Task 1: Manifest schema v3 (`WriteSemantics`, `mode`, v2-or-v3 acceptance)

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/manifest-schema.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts`

**Interfaces:**
- Produces: `WriteSemantics { bodyShape: JsonShape | null; bodyHints: Record<string,string>; contentType: string | null }`; `ManifestEndpoint.writeSemantics: WriteSemantics | null`; `ClientManifest.mode?: "read" | "full"`; `SCHEMA_VERSION = 3`; `validateManifest` accepts 2 or 3.

- [ ] **Step 1: Write the failing tests**

Add to `tests/manifest.test.ts`:

```ts
import { SCHEMA_VERSION, validateManifest } from "../src/lib/manifest-schema";

test("schema version is 3", () => {
  expect(SCHEMA_VERSION).toBe(3);
});

test("accepts a version 2 manifest as read-only", () => {
  const v2 = { schemaVersion: 2, site: "x", endpoints: [] };
  const m = validateManifest(v2);
  expect(m.schemaVersion).toBe(2);
  expect(m.mode ?? "read").toBe("read");
});

test("accepts a version 3 manifest carrying mode full", () => {
  const v3 = { schemaVersion: 3, site: "x", mode: "full", endpoints: [] };
  expect(validateManifest(v3).mode).toBe("full");
});

test("still rejects an unsupported schema version", () => {
  expect(() => validateManifest({ schemaVersion: 99, site: "x", endpoints: [] })).toThrow(
    /schema version/i,
  );
});

test("rejects an unknown mode value", () => {
  expect(() =>
    validateManifest({ schemaVersion: 3, site: "x", mode: "write", endpoints: [] }),
  ).toThrow(/mode/i);
});
```

Also update **every** existing assertion that pins the version to 2. These live in
more than one file: `tests/manifest.test.ts:185` asserts `SCHEMA_VERSION` is 2,
and **`tests/derive.test.ts:36` asserts `expect(manifest.schemaVersion).toBe(2)`
on a freshly derived manifest** — miss that one and Step 4 below is red. Search
the whole test directory, not a single file:

```bash
grep -rn "SCHEMA_VERSION\|schemaVersion" plugins/rkt/skills/derive-client/scripts/tests/
```

Update the assertions that pin a **newly built or derived** manifest to 2 (they
become 3). Leave alone the many fixtures that merely *set* `schemaVersion: 2` as
input data: those must keep working, and the "accepts a version 2 manifest"
test above is the regression that proves it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/manifest.test.ts`
Expected: FAIL, `expect(SCHEMA_VERSION).toBe(3)` receives 2.

- [ ] **Step 3: Implement**

In `src/lib/manifest-schema.ts`, change the constant and add the types:

```ts
export const SCHEMA_VERSION = 3;

/** Schema versions this codebase can read. v2 clients are read-only. */
const SUPPORTED_SCHEMA_VERSIONS = new Set([2, 3]);

export interface WriteSemantics {
  /**
   * Body field names + types, from the recorded request body. No values.
   * null when the endpoint takes no body (bodyless POST/PUT, most DELETEs)
   * or when the recorded body was not JSON.
   */
  bodyShape: JsonShape | null;
  /** Dotted body path -> format hint, e.g. "starts_at" -> "iso8601". */
  bodyHints: Record<string, string>;
  /** Observed request Content-Type; null when there is no body. */
  contentType: string | null;
}
```

Change `ManifestEndpoint.writeSemantics` from `null` to:

```ts
  writeSemantics: WriteSemantics | null;
```

Add to `ClientManifest`:

```ts
  /** Read-only client (default) or read+write. Absent = "read". */
  mode?: "read" | "full";
```

Replace the version check inside `validateManifest`:

```ts
  if (typeof m.schemaVersion !== "number" || !SUPPORTED_SCHEMA_VERSIONS.has(m.schemaVersion)) {
    throw new Error(
      `unsupported manifest schema version ${String(m.schemaVersion)}; expected one of ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")}`,
    );
  }
  if (m.mode !== undefined && m.mode !== "read" && m.mode !== "full") {
    throw new Error(`manifest mode must be "read" or "full", got ${JSON.stringify(m.mode)}`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/manifest-schema.ts plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts
git commit -m "$(cat <<'EOF'
feat: add WriteSemantics and mode to the client manifest schema

Bumps SCHEMA_VERSION to 3 while still accepting version 2 manifests as
read-only, so existing derived clients keep working without a re-record.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Filter keeps writes (including 204 / no content-type)

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/filter.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/filter.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `filterEntries(entries, { allowWrites: true })` keeps a write even with an empty response body and an empty mimeType.

- [ ] **Step 1: Write the failing test**

Add to `tests/filter.test.ts`:

```ts
test("keeps a 204 write with no body and no content-type when writes are allowed", () => {
  const entries = [
    {
      url: "https://x.test/api/events/1",
      method: "DELETE",
      status: 204,
      mimeType: "",
      responseBody: "",
      postData: null,
      startedDateTime: "2026-07-24T00:00:00.000Z",
      requestHeaders: {},
    },
  ] as never;
  const { kept, dropped } = filterEntries(entries, { allowWrites: true });
  expect(kept).toHaveLength(1);
  expect(dropped).toHaveLength(0);
});

test("still drops a read with an empty body", () => {
  const entries = [
    {
      url: "https://x.test/api/thing",
      method: "GET",
      status: 200,
      mimeType: "application/json",
      responseBody: "",
      postData: null,
      startedDateTime: "2026-07-24T00:00:00.000Z",
      requestHeaders: {},
    },
  ] as never;
  expect(filterEntries(entries, { allowWrites: true }).kept).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/filter.test.ts`
Expected: FAIL, the DELETE is dropped with reason "empty response body".

- [ ] **Step 3: Implement**

In `src/lib/filter.ts`, inside the `for (const e of entries)` loop, compute the write flag once after the method check, then guard the two response-quality gates. Replace the existing empty-body and data-mime blocks with:

```ts
    const isWrite = !READ_METHODS.has(e.method.toUpperCase());

    // Response-quality gates judge whether a RESPONSE is useful data. A write is
    // kept for its REQUEST, and a 204 legitimately has neither body nor
    // content-type, so these two gates apply to reads only.
    if (!isWrite && (e.responseBody === null || e.responseBody.length === 0)) {
      dropped.push({ url: e.url, reason: "empty response body" });
      continue;
    }
    if (!isWrite && !DATA_MIME.test(e.mimeType)) {
      dropped.push({ url: e.url, reason: `non-data content type (${e.mimeType})` });
      continue;
    }
```

Leave the status gate (`e.status < 200 || e.status >= 300`), the analytics-host gate, the static-mime gate, and the build-artifact gate unchanged. Guard the build-artifact gate against an empty mimeType by leaving it as-is (it is already inside a `/json/i.test(e.mimeType)` check, which is false for `""`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/filter.ts plugins/rkt/skills/derive-client/scripts/tests/filter.test.ts
git commit -m "$(cat <<'EOF'
feat: keep write endpoints through the response-quality filters

A 204 No Content write has neither a response body nor a content-type, so
both gates dropped it. They now apply to reads only.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Body shape, format hints, and key scrubbing (`synthesize.ts`)

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/synthesize.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/synthesize.test.ts`

**Interfaces:**
- Produces (all exported from `synthesize.ts`):
  - `formatHint(value: string): string | undefined` returning `"iso8601" | "email" | "uuid" | "url" | undefined`
  - `inferWriteSemantics(group: EndpointGroup): WriteSemantics | null`
- Consumes: `WriteSemantics` from Task 1; existing `EndpointGroup { method, origin, pathTemplate, params, samples: HarEntry[] }`; `HarEntry.postData: string | null`, `HarEntry.requestHeaders: Record<string,string>`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/synthesize.test.ts`:

```ts
import { formatHint, inferWriteSemantics } from "../src/lib/synthesize";

const sample = (postData: string | null, contentType = "application/json") => ({
  url: "https://x.test/api/events",
  method: "POST",
  status: 201,
  mimeType: "application/json",
  responseBody: "{}",
  postData,
  startedDateTime: "2026-07-24T00:00:00.000Z",
  requestHeaders: contentType ? { "content-type": contentType } : {},
});

const group = (samples: unknown[]) =>
  ({ method: "POST", origin: "https://x.test", pathTemplate: "/api/events", params: [], samples }) as never;

test("classifies format hints", () => {
  expect(formatHint("2026-07-24T10:00:00Z")).toBe("iso8601");
  expect(formatHint("a@b.com")).toBe("email");
  expect(formatHint("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("uuid");
  expect(formatHint("https://x.test/a")).toBe("url");
  expect(formatHint("just a title")).toBeUndefined();
});

test("derives body shape and hints without persisting any recorded value", () => {
  const ws = inferWriteSemantics(
    group([sample('{"name":"My Party","start_at":"2026-08-01T18:00:00Z","count":3}')]),
  )!;
  expect(ws.contentType).toBe("application/json");
  expect(ws.bodyShape).toEqual({
    type: "object",
    properties: { name: { type: "string" }, start_at: { type: "string" }, count: { type: "number" } },
    required: ["name", "start_at", "count"],
  });
  expect(ws.bodyHints).toEqual({ start_at: "iso8601" });
});

test("long ordinary field names are NOT scrubbed as data keys", () => {
  // Regression: a length-only heuristic collapses real schemas to a wildcard.
  const ws = inferWriteSemantics(
    ['{"organization_identifier":"a","recipient_email_address":"b"}'],
    "application/json",
  );
  const props = (ws.bodyShape as { properties: Record<string, unknown> }).properties;
  expect(Object.keys(props).sort()).toEqual([
    "organization_identifier",
    "recipient_email_address",
  ]);
  expect(JSON.stringify(ws)).not.toContain("My Party");
});

test("merges shapes across samples so a key missing from one is optional", () => {
  const ws = inferWriteSemantics(
    group([sample('{"a":1,"b":2}'), sample('{"a":9}')]),
  )!;
  expect((ws.bodyShape as { required: string[] }).required).toEqual(["a"]);
});

test("a bodyless write still yields writeSemantics with a null shape", () => {
  const ws = inferWriteSemantics(group([sample(null, "")]))!;
  expect(ws).not.toBeNull();
  expect(ws.bodyShape).toBeNull();
  expect(ws.contentType).toBeNull();
});

test("a non-JSON body is recorded but not modelled", () => {
  const ws = inferWriteSemantics(
    group([sample("a=1&b=2", "application/x-www-form-urlencoded")]),
  )!;
  expect(ws.bodyShape).toBeNull();
  expect(ws.contentType).toBe("application/x-www-form-urlencoded");
});

test("scrubs data-derived object keys so PII never lands in the schema", () => {
  const ws = inferWriteSemantics(group([sample('{"guests":{"alice@x.com":{"rsvp":true}}}')]))!;
  expect(JSON.stringify(ws)).not.toContain("alice@x.com");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/synthesize.test.ts`
Expected: FAIL with "export named 'formatHint' not found".

- [ ] **Step 3: Implement**

In `src/lib/synthesize.ts`:

Export the existing helper (change `function shapeOf` to `export function shapeOf`
— it is consumed by `inferWriteSemantics` in this same file, so keep the export
only if a test imports it directly; otherwise leave it module-local and drop the
export to avoid dead public surface). `mergeShapes` stays module-local.

**Import note:** `synthesize.ts:2` already imports `JsonShape` from
`./manifest-schema`. Do NOT add a second import statement for that module —
extend the existing one, or you get a duplicate-identifier compile error:

```ts
// existing: import type { JsonShape } from "./manifest-schema";
// becomes:
import type { JsonShape, WriteSemantics } from "./manifest-schema";

const ISO8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /^https?:\/\/\S+$/i;

/** Classify a value's FORMAT. Returns a hint only; the value never escapes. */
export function formatHint(value: string): string | undefined {
  if (UUID_RE.test(value)) return "uuid";
  if (EMAIL.test(value)) return "email";
  if (URL_RE.test(value)) return "url";
  if (ISO8601.test(value)) return "iso8601";
  return undefined;
}

/**
 * An object key that classifies as data (an email, uuid, or long opaque id) is
 * a VALUE wearing a key's clothing. Persisting it as a schema property name
 * would leak PII into the committed client.json, so such maps collapse to a
 * single wildcard entry.
 */
function isDataKey(key: string): boolean {
  // A plain length threshold is far too aggressive: real schemas have long
  // snake_case field names ("organization_identifier", "recipient_email_address"),
  // and collapsing those to a wildcard silently destroys the body model with no
  // signal. Only classify a key as data when it looks like an identifier VALUE:
  // a format-hint match (email/uuid/url/iso8601), or an opaque token with no
  // word separators and mixed alphanumerics.
  if (formatHint(key) !== undefined) return true;
  const opaque = /^[A-Za-z0-9]{16,}$/.test(key) && /\d/.test(key);
  const prefixedId = /^[a-z]{2,5}[-_][A-Za-z0-9]{10,}$/.test(key); // usr-8YWsBVeEy8stAMd
  return opaque || prefixedId;
}

const WILDCARD = "*";

function scrubShape(shape: JsonShape): JsonShape {
  if (shape.type === "array") return { type: "array", items: scrubShape(shape.items) };
  if (shape.type !== "object") return shape;
  const keys = Object.keys(shape.properties);
  if (keys.length > 0 && keys.every(isDataKey)) {
    const merged = keys.map((k) => shape.properties[k]).reduce(mergeShapes);
    return { type: "object", properties: { [WILDCARD]: scrubShape(merged) }, required: [] };
  }
  const properties: Record<string, JsonShape> = {};
  for (const [k, v] of Object.entries(shape.properties)) properties[k] = scrubShape(v);
  return { type: "object", properties, required: shape.required };
}

function collectHints(value: unknown, prefix: string, out: Record<string, string>): void {
  if (Array.isArray(value)) return; // v1: no array-index or wildcard hint syntax
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isDataKey(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      const hint = formatHint(v);
      if (hint) out[path] = hint;
    } else {
      collectHints(v, path, out);
    }
  }
}

function isJsonContentType(ct: string): boolean {
  return /json/i.test(ct);
}

/**
 * Model a write endpoint's request body as shape + format hints, never values.
 * Returns null for a read endpoint. Always non-null for a write, even bodyless,
 * because its presence is what marks the endpoint as a write downstream.
 */
export function inferWriteSemantics(group: EndpointGroup): WriteSemantics | null {
  if (READ_METHODS.has(group.method.toUpperCase())) return null;

  const contentType =
    group.samples.map((s) => s.requestHeaders["content-type"] ?? "").find((c) => c.length > 0) ?? null;

  const bodies = group.samples
    .map((s) => s.postData)
    .filter((b): b is string => typeof b === "string" && b.length > 0);

  // Bodyless, or a body we do not model in v1 (urlencoded / multipart): record
  // the content type and stop. inferShape collapses a parse failure to
  // "unknown" for the whole merge, so these must be caught before it runs.
  if (bodies.length === 0 || !contentType || !isJsonContentType(contentType)) {
    return { bodyShape: null, bodyHints: {}, contentType: bodies.length === 0 ? null : contentType };
  }

  const bodyHints: Record<string, string> = {};
  let merged: JsonShape | null = null;
  for (const body of bodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { bodyShape: null, bodyHints: {}, contentType };
    }
    collectHints(parsed, "", bodyHints);
    const shape = shapeOf(parsed);
    merged = merged === null ? shape : mergeShapes(merged, shape);
  }

  return { bodyShape: merged ? scrubShape(merged) : null, bodyHints, contentType };
}
```

Add `const READ_METHODS = new Set(["GET", "HEAD"]);` near the top of the file if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/synthesize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/synthesize.ts plugins/rkt/skills/derive-client/scripts/tests/synthesize.test.ts
git commit -m "$(cat <<'EOF'
feat: model write request bodies as shape and format hints

Stores field names, types, and format hints only. Recorded values are
discarded, and object keys that classify as data collapse to a wildcard so
PII cannot land in the committed client.json.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Populate the manifest and add `--mode full`

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/manifest.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/src/derive.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts`

**Interfaces:**
- Consumes: `inferWriteSemantics` (Task 3); `mode` field (Task 1).
- Produces: `buildManifest({ ..., mode?: "read" | "full" })` sets `mode` and per-endpoint `writeSemantics`; `deriveManifest(harPath, site, opts?: { mode?: "read" | "full" })`.

- [ ] **Step 1: Write the failing test**

Add to `tests/manifest.test.ts`:

```ts
import { buildManifest } from "../src/lib/manifest";

const writeGroup = {
  method: "POST",
  origin: "https://x.test",
  pathTemplate: "/api/events",
  params: [],
  samples: [
    {
      url: "https://x.test/api/events",
      method: "POST",
      status: 201,
      mimeType: "application/json",
      responseBody: "{}",
      postData: '{"name":"x"}',
      startedDateTime: "2026-07-24T00:00:00.000Z",
      requestHeaders: { "content-type": "application/json" },
    },
  ],
} as never;

test("full mode stamps mode and populates writeSemantics", () => {
  const m = buildManifest({
    site: "x",
    groups: [writeGroup],
    harSha256: "d",
    recordedAt: "2026-07-24T00:00:00.000Z",
    mode: "full",
  } as never);
  expect(m.mode).toBe("full");
  expect(m.endpoints[0].writeSemantics).not.toBeNull();
  expect(m.endpoints[0].writeSemantics!.bodyShape).not.toBeNull();
});

test("read mode leaves writeSemantics null and mode read", () => {
  const m = buildManifest({
    site: "x",
    groups: [],
    harSha256: "d",
    recordedAt: "2026-07-24T00:00:00.000Z",
  } as never);
  expect(m.mode ?? "read").toBe("read");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/manifest.test.ts`
Expected: FAIL, `writeSemantics` is null.

- [ ] **Step 3: Implement**

In `src/lib/manifest.ts`, import `inferWriteSemantics` from `./synthesize`, add `mode?: "read" | "full"` to the `buildManifest` input interface, replace the hardcoded field in the endpoints map:

```ts
      selectors: null,
      writeSemantics: inferWriteSemantics(g),
```

and add `mode` to the returned object (omit it entirely in read mode so v2-shaped output is unchanged):

```ts
  return {
    schemaVersion: SCHEMA_VERSION,
    site,
    ...(input.mode === "full" ? { mode: "full" as const } : {}),
    baseUrl: groups[0]?.origin ?? "",
    // ...rest unchanged
```

In `src/derive.ts`:

Change the signature and the two call sites:

```ts
export async function deriveManifest(
  harPath: string,
  site: string,
  opts: { mode?: "read" | "full" } = {},
): Promise<DeriveResult> {
```

```ts
  const { kept, dropped } = filterEntries(originEntries, { allowWrites: opts.mode === "full" });
```

```ts
    manifest: buildManifest({
      site,
      groups,
      harSha256,
      recordedAt,
      auth: bundle?.credentials[0] ?? null,
      authBundle: bundle,
      refresh: detected.spec,
      mode: opts.mode,
    }),
```

In `main()`, parse the flag and pass it, and update the usage line:

```ts
  const mode = arg("mode") === "full" ? "full" : "read";
  if (mode === "full") {
    console.error(
      "FULL MODE: write endpoints (POST/PUT/PATCH/DELETE) will be derived. " +
        "They stay inert until you author a write task and set RKT_ALLOW_WRITES.",
    );
  }
```

```ts
    console.error("usage: bun src/derive.ts --site <site> --har <path> [--mode full]");
```

```ts
  const { manifest, dropped, secrets, origin, notes } = await deriveManifest(absHar, site, { mode });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/manifest.ts plugins/rkt/skills/derive-client/scripts/src/derive.ts plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts
git commit -m "$(cat <<'EOF'
feat: derive write endpoints behind a --mode full flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Transport and scheduler write path (body, env gate, no retry)

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/scheduler.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/transport.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/src/call.ts` (keep it read-only)
- Test: `plugins/rkt/skills/derive-client/scripts/tests/transport.test.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/scheduler.test.ts` (exists, 130 lines; add to it, do not create)

**Interfaces:**
- Produces:
  - `SchedulerRequest { url; method; headers; body?: string }`, forwarded to `fetch`; no backoff retry when the method is non-read.
  - `writesEnabled(env?: NodeJS.ProcessEnv): boolean` exported from `transport.ts`.
  - `buildRequest(manifest, endpoint, params, secret, body?: unknown): BuiltRequest` where `BuiltRequest` gains `body?: string`.
  - `issue(built, scheduler)` sends the body and enforces the env gate for writes.

> **CRITICAL — this task removes a guard that other callers silently depend on.**
> `buildRequest`'s unconditional non-read throw is currently the *only* thing
> stopping `src/call.ts` from issuing a write. `call.ts:89` even documents this
> ("Throws for any non-GET/HEAD endpoint") and `SKILL.md:230` tells the agent to
> run `call.ts` as the smoke step. Once the throw becomes conditional, `call.ts`
> would build and issue **any** endpoint id in a full-mode manifest with no
> curation, no body, no preview, and no `--commit` — a write path with 2 of the 4
> gates. **Step 3b below closes this.** Before finishing this task, re-check every
> caller of `buildRequest`/`issue` for the same assumption.

**Fixture note (this test file has no `BASE_MANIFEST`).** `tests/transport.test.ts`
builds manifests with a local `manifest(auth, baseUrl)` factory. Define the
fixtures used below explicitly at the top of the added block:

```ts
const BASE_MANIFEST = manifest({ kind: "cookie", location: "cookie:s", mintedBy: null, expiry: null }, "https://x.test");
const FULL = { ...BASE_MANIFEST, mode: "full" as const };
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/transport.test.ts`:

```ts
import { buildRequest, issue, writesEnabled } from "../src/lib/transport";

const WRITE_EP = {
  id: "post.api.events",
  method: "POST",
  pathTemplate: "/api/events",
  params: [],
  responseShape: { type: "unknown" as const },
  source: "xhr" as const,
  fragile: false,
  selectors: null,
  writeSemantics: { bodyShape: null, bodyHints: {}, contentType: "application/json" },
};

test("writesEnabled is fail-closed", () => {
  expect(writesEnabled({} as never)).toBe(false);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "" } as never)).toBe(false);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "0" } as never)).toBe(false);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "false" } as never)).toBe(false);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "1" } as never)).toBe(true);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "true" } as never)).toBe(true);
});

test("buildRequest serialises a body and sets content-type for a write", () => {
  const built = buildRequest(FULL, WRITE_EP as never, {}, null, { name: "x" });
  expect(built.method).toBe("POST");
  expect(built.body).toBe('{"name":"x"}');
  expect(built.headers["content-type"]).toBe("application/json");
});

test("buildRequest still refuses a write on a read-mode manifest", () => {
  expect(() => buildRequest(BASE_MANIFEST, WRITE_EP as never, {}, null, {})).toThrow(/read mode/i);
});

test("issue refuses a write when RKT_ALLOW_WRITES is not enabled", async () => {
  const built = buildRequest(FULL, WRITE_EP as never, {}, null, {});
  const scheduler = { run: async () => ({ status: 200, body: "{}", headers: {} }) };
  await expect(issue(built, scheduler, { env: {} as never })).rejects.toThrow(/RKT_ALLOW_WRITES/);
});

test("issue sends the body when writes are enabled", async () => {
  const built = buildRequest(FULL, WRITE_EP as never, {}, null, { a: 1 });
  let seen: unknown;
  const scheduler = {
    run: async (req: unknown) => {
      seen = req;
      return { status: 201, body: "{}", headers: {} };
    },
  };
  await issue(built, scheduler, { env: { RKT_ALLOW_WRITES: "1" } as never });
  expect((seen as { body: string }).body).toBe('{"a":1}');
});
```

**Update the existing refusal test — this task changes its message.**
`tests/transport.test.ts:144-149` currently asserts `issue(... "DELETE" ...)`
rejects with `/GET and HEAD only/i`. After Step 3 that message becomes the
writes-disabled one, so this test goes red unless it is changed here. Replace its
assertion with the new fail-closed message:

```ts
test("issue still refuses a non-read method when writes are disabled", async () => {
  const scheduler = createScheduler({ minDelayMs: 0, maxDelayMs: 0 });
  await expect(
    issue({ url: "https://x.test/api", method: "DELETE", headers: {} }, scheduler, { env: {} as never }),
  ).rejects.toThrow(/writes are disabled/i);
});
```

Add to the existing scheduler tests (`tests/scheduler.test.ts` already exists and
already covers 429/503 backoff and Retry-After; append, do not create):

```ts
test("does not retry a write on 503", async () => {
  let calls = 0;
  const scheduler = createScheduler({
    fetchImpl: (async () => {
      calls++;
      return new Response("", { status: 503 });
    }) as never,
    sleepImpl: async () => {},
  });
  await scheduler.run({ url: "https://x.test/a", method: "POST", headers: {}, body: "{}" });
  expect(calls).toBe(1);
});

test("still retries a read on 503", async () => {
  let calls = 0;
  const scheduler = createScheduler({
    maxRetries: 2,
    fetchImpl: (async () => {
      calls++;
      return new Response("", { status: 503 });
    }) as never,
    sleepImpl: async () => {},
  });
  await scheduler.run({ url: "https://x.test/b", method: "GET", headers: {} });
  expect(calls).toBe(3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/transport.test.ts tests/scheduler.test.ts`
Expected: FAIL, `writesEnabled` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/scheduler.ts`, add the body field and suppress retries for writes.
Declare the retry predicate as its own constant next to `CACHEABLE`:

```ts
/** Methods it is safe to re-send. Deliberately separate from CACHEABLE. */
const RETRY_SAFE_METHODS = new Set(["GET", "HEAD"]);
```


```ts
export interface SchedulerRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** JSON payload for write methods. Never set for reads. */
  body?: string;
}
```

```ts
  async function fetchWithBackoff(req: SchedulerRequest): Promise<SchedulerResponse> {
    // A write is not idempotent: a request the server already committed before
    // answering 429/503 would be applied twice by a retry. Use a dedicated
    // predicate, NOT the CACHEABLE dedup set: coupling retry-safety to a caching
    // constant means a future caching change silently changes write safety.
    const retryable = RETRY_SAFE_METHODS.has(req.method.toUpperCase());
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const out = { status: res.status, body: await res.text(), headers };
      if (!retryable || !RETRYABLE.has(res.status) || attempt >= maxRetries) return out;
      // ...unchanged
```

In `src/lib/transport.ts`:

```ts
export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Serialised JSON payload for write methods. */
  body?: string;
}

/**
 * Fail-closed: only an explicit "1"/"true" enables writes. Reading any
 * non-empty string as truthy would turn RKT_ALLOW_WRITES=0 into "enabled".
 */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.RKT_ALLOW_WRITES;
  return v === "1" || v === "true";
}
```

Replace the `buildRequest` guard and signature:

```ts
export function buildRequest(
  manifest: ClientManifest,
  endpoint: ManifestEndpoint,
  params: Record<string, string>,
  secret: Record<string, string> | string | null,
  body?: unknown,
): BuiltRequest {
  const isWrite = !READ_METHODS.has(endpoint.method.toUpperCase());
  // A read-mode client has no business issuing a write regardless of the env
  // flag: structural check on the manifest, never on names.
  if (isWrite && manifest.mode !== "full") {
    throw new Error(
      `refusing ${endpoint.method} ${endpoint.pathTemplate}: read mode issues GET and HEAD only`,
    );
  }
```

Keep the path/query building unchanged. After `applyCredentials(...)`, add:

```ts
  if (!isWrite) return { url, method: endpoint.method, headers };

  const serialised = body === undefined ? undefined : JSON.stringify(body);
  if (serialised !== undefined) {
    headers["content-type"] = endpoint.writeSemantics?.contentType ?? "application/json";
  }
  return { url, method: endpoint.method, headers, body: serialised };
```

Replace `issue`:

```ts
export async function issue(
  built: BuiltRequest,
  scheduler: Scheduler,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number; body: string }> {
  // The gate lives here, at the send, not in buildRequest: a dry-run preview
  // must still be able to BUILD the request in order to display it.
  if (!READ_METHODS.has(built.method.toUpperCase()) && !writesEnabled(opts.env)) {
    throw new Error(
      `refusing ${built.method} ${built.url}: writes are disabled. ` +
        `Set RKT_ALLOW_WRITES=1 to enable them.`,
    );
  }
  const { status, body } = await scheduler.run({
    url: built.url,
    method: built.method,
    headers: built.headers,
    ...(built.body === undefined ? {} : { body: built.body }),
  });
  return { status, body };
}
```

- [ ] **Step 3b: Keep `src/call.ts` read-only (closes the guard it inherited)**

`call.ts` is the manual debug/smoke invoker. It must stay read-only permanently:
it has no curation, no body materialiser, no preview, and no `--commit`, so it
can never satisfy the four gates. It previously got that refusal for free from
`buildRequest`; now it must enforce it itself.

In `src/call.ts`, immediately after the endpoint is resolved and **before** the
`--dry-run` branch, add:

```ts
// call.ts is a read-only debug invoker. Writes must go through a curated
// command (preview + --commit + env gate); this tool has none of that, so it
// refuses them structurally regardless of manifest mode or RKT_ALLOW_WRITES.
if (!["GET", "HEAD"].includes(endpoint.method.toUpperCase())) {
  console.error(
    `refusing ${endpoint.method} ${endpoint.pathTemplate}: call.ts is read-only. ` +
      `Writes require a curated command in commands.json, run with --commit.`,
  );
  process.exit(2);
}
```

Update the stale comment at `call.ts:89` so it states the guard is now local
rather than inherited from `buildRequest`.

Add a test (`tests/call.test.ts`, or an added case in the existing transport
suite if `call.ts` has no test file) asserting that invoking `call.ts` against a
full-mode manifest with a write endpoint exits non-zero and never reaches the
scheduler, **even with `RKT_ALLOW_WRITES=1`**.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS. Note this includes the **updated** `issue` refusal test from
Step 1 (its message changed in this task) and the new `call.ts` refusal test.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/transport.ts plugins/rkt/skills/derive-client/scripts/src/lib/scheduler.ts plugins/rkt/skills/derive-client/scripts/src/call.ts plugins/rkt/skills/derive-client/scripts/tests/
git commit -m "$(cat <<'EOF'
feat: add a gated write path to transport and scheduler

Writes require a full-mode manifest and RKT_ALLOW_WRITES, are never
auto-retried, and the gate sits at the send so dry-run can still build the
request to preview it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Runtime caller carries a body and never re-issues a write

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/runtime.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/runtime.test.ts`

**Interfaces:**
- Produces: `Caller.call(endpointId, params, body?)`.
- Consumes: `buildRequest(..., body)` and `issue` from Task 5.

- [ ] **Step 1: Write the failing test**

Add to `tests/runtime.test.ts`:

**The fixture must actually reach the renewal branch.** `renew()`
(`runtime.ts:50`) only takes the OIDC path when
`manifest.refresh?.kind === "oidc"` **and** `secret[REFRESH_TOKEN_KEY]` is set
(`REFRESH_TOKEN_KEY` is the literal `"@refresh_token"`, exported from
`./secrets`). With neither present, `renew()` falls through to the real
`reauthViaProfile`, which returns null in a test env, so `renew()` returns false,
no re-issue ever happens, and `call` **resolves** with a 401 instead of throwing.
That fixture fails the test both before and after the implementation. Use:

```ts
import { REFRESH_TOKEN_KEY } from "../src/lib/secrets";

const RENEWABLE = {
  ...FULL_MANIFEST,
  refresh: {
    kind: "oidc" as const,
    tokenEndpoint: "https://idp.test/token",
    clientId: "c",
    accessTokenCookie: "s",
    expiresIn: 300,
    refreshExpiresIn: 3600,
  },
};

test("a write is not re-issued after a 401 renewal", async () => {
  let sends = 0;
  const scheduler = {
    run: async () => {
      sends++;
      return { status: 401, body: "{}", headers: {} };
    },
  };
  const caller = createCaller(
    RENEWABLE as never,
    scheduler as never,
    { "cookie:s": "v", [REFRESH_TOKEN_KEY]: "rt" },
    {
      // Must succeed, or renew() falls through to the real browser re-auth.
      refreshViaOidc: (async () => ({ accessToken: "a2", refreshToken: "rt2" })) as never,
      reauthViaProfile: (async () => null) as never,
      writeSecret: (async () => {}) as never,
      log: () => {},
    },
  );
  await expect(caller.call("post.api.events", {}, { a: 1 })).rejects.toThrow(/may .*have applied/i);
  expect(sends).toBe(1);
});

test("a read IS still re-issued after a 401 renewal", async () => {
  // Regression: suppression must be write-only.
  let sends = 0;
  const scheduler = {
    run: async () => {
      sends++;
      return { status: sends === 1 ? 401 : 200, body: "{}", headers: {} };
    },
  };
  const caller = createCaller(
    RENEWABLE as never,
    scheduler as never,
    { "cookie:s": "v", [REFRESH_TOKEN_KEY]: "rt" },
    {
      refreshViaOidc: (async () => ({ accessToken: "a2", refreshToken: "rt2" })) as never,
      reauthViaProfile: (async () => null) as never,
      writeSecret: (async () => {}) as never,
      log: () => {},
    },
  );
  const res = await caller.call("get.api.events", {});
  expect(res.status).toBe(200);
  expect(sends).toBe(2);
});
```

Confirm `createCaller`'s deps parameter actually accepts `reauthViaProfile`; if it
does not, the OIDC stub above is what keeps the real browser path from running,
and the extra key can be dropped.

Reuse the `FULL_MANIFEST` fixture defined in Task 9 (add a `get.api.events` read
endpoint to it for the second test). Set the env flag around these tests and
**restore it**, since Bun shares one process across test files:

```ts
const PRIOR = process.env.RKT_ALLOW_WRITES;
beforeAll(() => { process.env.RKT_ALLOW_WRITES = "1"; });
afterAll(() => {
  if (PRIOR === undefined) delete process.env.RKT_ALLOW_WRITES;
  else process.env.RKT_ALLOW_WRITES = PRIOR;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/runtime.test.ts`
Expected: FAIL on the write test because the write **is** re-issued: `sends` is 2
and no error is thrown. (If instead it fails with `sends === 1`, the renewal
branch was never entered and the fixture is wrong, not the implementation. Fix
the fixture before touching `runtime.ts`.) The read test should already pass.

- [ ] **Step 3: Implement**

In `src/lib/runtime.ts`, widen the interface:

```ts
export interface Caller {
  call(
    endpointId: string,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: string }>;
  fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown>;
  readonly secret: Record<string, string> | null;
}
```

and replace `call`:

```ts
  const READ_METHODS = new Set(["GET", "HEAD"]);

  async function call(endpointId: string, params: Record<string, string>, body?: unknown) {
    const ep = endpointById(endpointId);
    const isWrite = !READ_METHODS.has(ep.method.toUpperCase());
    let built = buildRequest(manifest, ep, params, secret, body);
    let res = await issue(built, scheduler);
    if (res.status === 401 && secret && (await renew())) {
      // A read is safe to replay. A write is not: the server may have committed
      // it before the token expired, so replaying could apply it twice.
      if (isWrite) {
        throw new CliError(
          `${ep.method} ${ep.pathTemplate} returned HTTP 401 and the credential was renewed, ` +
            `but the write was NOT retried. It may or may not have applied.`,
          "verify the resource on the site before re-running this command",
          4,
        );
      }
      built = buildRequest(manifest, ep, params, secret, body);
      res = await issue(built, scheduler);
    }
    return res;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/runtime.ts plugins/rkt/skills/derive-client/scripts/tests/runtime.test.ts
git commit -m "$(cat <<'EOF'
feat: thread a request body through the runtime caller

A write is never re-issued after a 401 renewal; it surfaces a
may-have-applied error instead of risking a double mutation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Command schema gains `write` and `call.body`

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/commands-schema.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/commands-schema.test.ts`

**Interfaces:**
- Produces: `CommandSpec.write?: boolean`, `CommandSpec.call.body?: unknown`, both surviving `validateCommandsFile`; `assertResolvable(commands, endpoints: Pick<ManifestEndpoint, "id" | "params" | "method" | "writeSemantics">[])` enforcing the write rules.

- [ ] **Step 1: Write the failing tests**

Add to `tests/commands-schema.test.ts`:

```ts
const WRITE_EP = { id: "post.api.events", params: [], method: "POST", writeSemantics: { bodyShape: null, bodyHints: {}, contentType: "application/json" } };
const READ_EP = { id: "get.api.events", params: [], method: "GET", writeSemantics: null };

const file = (cmd: Record<string, unknown>) => ({
  schemaVersion: 1,
  site: "x",
  commands: [{ name: "c", summary: "s", output: { kind: "json" }, redact: [], ...cmd }],
});

test("write and call.body survive validation", () => {
  const f = validateCommandsFile(
    file({ write: true, call: { endpoint: "post.api.events", body: { name: "@arg:title" } } }),
  );
  expect(f.commands[0].write).toBe(true);
  expect(f.commands[0].call.body).toEqual({ name: "@arg:title" });
});

test("rejects a command on a write endpoint without write: true", () => {
  const f = validateCommandsFile(file({ call: { endpoint: "post.api.events" } }));
  expect(() => assertResolvable(f, [WRITE_EP] as never)).toThrow(/write: true/);
});

test("rejects write: true on a read endpoint", () => {
  const f = validateCommandsFile(file({ write: true, call: { endpoint: "get.api.events" } }));
  expect(() => assertResolvable(f, [READ_EP] as never)).toThrow(/is not a write endpoint/);
});

test("rejects a non-boolean write", () => {
  expect(() => validateCommandsFile(file({ write: "yes", call: { endpoint: "x" } }))).toThrow(/write/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/commands-schema.test.ts`
Expected: FAIL, `f.commands[0].write` is undefined (dropped by the whitelist).

- [ ] **Step 3: Implement**

In `src/lib/commands-schema.ts`, extend the type:

```ts
export interface CommandSpec {
  name: string;
  summary: string;
  call: { endpoint: string; params?: Record<string, string>; body?: unknown };
  join?: JoinSpec[];
  output: CommandOutput;
  redact?: string[];
  /** Marks a mutating command. Required when call targets a write endpoint. */
  write?: boolean;
}
```

In `validateCommand`, before the return, validate and then carry both new fields through the reconstruction (the whitelist is why they must be named explicitly):

```ts
  if (o.write !== undefined && typeof o.write !== "boolean") {
    fail(`${o.name}.write`, "must be a boolean");
  }
```

```ts
  return {
    name: o.name,
    summary: o.summary,
    call: {
      endpoint: o.call.endpoint,
      params: validateParams(o.call.params, o.name),
      ...(o.call.body === undefined ? {} : { body: o.call.body }),
    },
    join,
    output: { ...output, columns, rows },
    redact,
    ...(o.write === undefined ? {} : { write: o.write }),
  };
```

Widen `assertResolvable` and add the rules:

```ts
type ResolvableEndpoint = Pick<ManifestEndpoint, "id" | "params" | "method" | "writeSemantics">;

const READ_METHODS = new Set(["GET", "HEAD"]);

export function assertResolvable(
  commands: CommandsFile,
  endpoints: ResolvableEndpoint[],
): void {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const need = (cmd: string, endpoint: string): ResolvableEndpoint => {
```

Inside the `for (const c of commands.commands)` loop, immediately after `need(c.name, c.call.endpoint)`, capture the endpoint and add the fail-closed pair:

```ts
    const ep = need(c.name, c.call.endpoint);
    const isWrite = !READ_METHODS.has(ep.method.toUpperCase());
    if (isWrite && c.write !== true) {
      throw new Error(
        `commands.json: ${c.name} targets write endpoint '${ep.id}' (${ep.method}) ` +
          `but is missing "write": true; a mutating command must declare itself`,
      );
    }
    if (!isWrite && c.write === true) {
      throw new Error(
        `commands.json: ${c.name} declares "write": true but '${ep.id}' is not a write endpoint`,
      );
    }

    // Every @arg: hole must resolve to a modelled body path, so codegen can type
    // its flag. An unknown hole would otherwise surface as an untyped flag that
    // silently resolves to undefined at send time.
    for (const path of argPaths(c.call.body)) {
      if (shapeTypeAt(ep.writeSemantics?.bodyShape ?? null, path) === undefined) {
        throw new Error(
          `commands.json: ${c.name} body path '${path}' has no modelled shape in ` +
            `'${ep.id}'; remove the @arg: hole or re-derive with --mode full`,
        );
      }
    }
```

`argPaths(body)` walks the template and returns the dotted path of every
`@arg:`-valued string leaf. `shapeTypeAt` is the same helper Task 9 adds; define
it once in a module both can import (`commands-schema.ts` is fine, since Task 9's
`command-runner.ts` already imports from it) rather than duplicating it.

Add the matching failing test in Step 1:

```ts
test("rejects an @arg hole with no modelled body shape", () => {
  const f = { schemaVersion: 1, site: "x", commands: [{
    name: "event-create", summary: "", write: true,
    call: { endpoint: "post.api.events", body: { nope: "@arg:nope" } },
    output: { kind: "json" }, redact: [],
  }] };
  expect(() => assertResolvable(f as never, [WRITE_EP] as never)).toThrow(/no modelled shape/);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/commands-schema.ts plugins/rkt/skills/derive-client/scripts/tests/commands-schema.test.ts
git commit -m "$(cat <<'EOF'
feat: add write and call.body to the command schema

A command on a write endpoint must declare write: true, and vice versa, so
a mutation cannot slip through curation as a read.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `@arg:` token

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/tokens.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/tokens.test.ts`

**Interfaces:**
- Produces: `TokenContext.args?: Record<string, string>`; `resolveToken` resolves `@arg:<name>` verbatim from `args`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tokens.test.ts`:

```ts
test("resolves @arg from the supplied args map, verbatim", async () => {
  const ctx = { resolveMe: async () => "me", args: { starts_at: "2026-08-01" } };
  expect(await resolveToken("@arg:starts_at", ctx, new Date())).toBe("2026-08-01");
});

test("a missing @arg names the flag the caller must pass", async () => {
  const ctx = { resolveMe: async () => "me", args: {} };
  await expect(resolveToken("@arg:title", ctx, new Date())).rejects.toThrow(/--title/);
});

test("@@ still escapes a literal leading at-sign", async () => {
  const ctx = { resolveMe: async () => "me" };
  expect(await resolveToken("@@channel", ctx, new Date())).toBe("@channel");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/tokens.test.ts`
Expected: FAIL, throws "unresolvable param token @arg:starts_at".

- [ ] **Step 3: Implement**

In `src/lib/tokens.ts`:

```ts
export interface TokenContext {
  resolveMe: () => Promise<string>;
  timezone?: string;
  /** Parsed --<name> flag values, for @arg: holes in a curated body. */
  args?: Record<string, string>;
}
```

In `resolveToken`, after the `@@` escape and before `@me`:

```ts
  if (value.startsWith("@arg:")) {
    const name = value.slice("@arg:".length);
    const supplied = ctx.args?.[name];
    if (supplied === undefined) {
      throw new Error(`missing required argument --${name} (body field wants ${value})`);
    }
    return supplied;
  }
```

Update the final throw message to mention the new form:

```ts
  throw new Error(
    `unresolvable param token ${value}: not one of @me, @today, @today±<n><d|w|m|y>, @arg:<name>`,
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/tokens.ts plugins/rkt/skills/derive-client/scripts/tests/tokens.test.ts
git commit -m "$(cat <<'EOF'
feat: add the @arg token for caller-supplied body fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Body materialiser, coercion, and the preview/send result

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/command-runner.ts`
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/render.ts` (export `redactClone`)
- Test: `plugins/rkt/skills/derive-client/scripts/tests/command-runner.test.ts`

**Interfaces:**
- Consumes: `writesEnabled` (Task 5), `Caller.call(..., body)` (Task 6), `CommandSpec.write`/`call.body` (Task 7), `@arg:` (Task 8), `maskHeaders` from `./secrets`, `redactClone` from `./render`.
- Produces: `RunOpts.commit?: boolean`, `RunOpts.args?: Record<string,string>`; `RunResult` gains `kind: "preview" | "sent"`; `RunnerCaller.call(endpointId, params, body?)`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/command-runner.test.ts`:

```ts
const WRITE_CMD = {
  name: "event-create",
  summary: "",
  write: true,
  call: {
    endpoint: "post.api.events",
    body: { name: "@arg:title", count: "@arg:count", pinned: "fixed" },
  },
  output: { kind: "json" as const },
  redact: ["body.name"],
};

test("a bare write previews and never calls the network", async () => {
  let called = false;
  const caller = { call: async () => { called = true; return { status: 201, body: "{}" }; }, fetchJson: async () => ({}), secret: { "cookie:s": "sekret" } };
  const res = await runCommand(WRITE_CMD as never, {
    manifest: FULL_MANIFEST, site: "x", caller: caller as never,
    flags: { json: true, raw: false }, now: new Date(),
    commit: false, args: { title: "Party", count: "3" },
  } as never);
  expect(called).toBe(false);
  expect(res.kind).toBe("preview");
  expect(res.rendered).toContain('"method": "POST"');
  expect(res.rendered).toContain("[REDACTED]");   // body.name redacted
  expect(res.rendered).not.toContain("Party");
  expect(res.rendered).not.toContain("sekret");   // credential masked
});

test("coerces an @arg to the shape type and sends on commit", async () => {
  let sentBody: unknown;
  const caller = { call: async (_i: string, _p: unknown, body: unknown) => { sentBody = body; return { status: 201, body: "{}" }; }, fetchJson: async () => ({}), secret: null };
  process.env.RKT_ALLOW_WRITES = "1";
  const res = await runCommand(WRITE_CMD as never, {
    manifest: FULL_MANIFEST, site: "x", caller: caller as never,
    flags: { json: true, raw: false }, now: new Date(),
    commit: true, args: { title: "Party", count: "3" },
  } as never);
  expect(res.kind).toBe("sent");
  expect(sentBody).toEqual({ name: "Party", count: 3, pinned: "fixed" });
});

test("a command missing write:true on a write endpoint STILL cannot mutate", async () => {
  // Structural gate regression: the trigger is the endpoint method, not the
  // declared flag. Without this, omitting write:true drops to the read path and
  // mutates on a bare invocation.
  let called = false;
  const caller = { call: async () => { called = true; return { status: 201, body: "{}" }; }, fetchJson: async () => ({}), secret: null };
  const undeclared = { ...WRITE_CMD, write: undefined };
  const res = await runCommand(undeclared as never, {
    manifest: FULL_MANIFEST, site: "x", caller: caller as never,
    flags: { json: true, raw: false }, now: new Date(),
    commit: false, args: { title: "t", count: "1" },
  } as never);
  expect(called).toBe(false);
  expect(res.kind).toBe("preview");
});

test("an @arg failing its format hint is rejected before the wire", async () => {
  const caller = { call: async () => ({ status: 201, body: "{}" }), fetchJson: async () => ({}), secret: null };
  await expect(
    runCommand(HINTED_CMD as never, {
      manifest: HINTED_MANIFEST, site: "x", caller: caller as never,
      flags: { json: true, raw: false }, now: new Date(),
      commit: false, args: { starts_at: "not-a-date" },
    } as never),
  ).rejects.toThrow(/starts_at.*iso8601/i);
});

test("commit without the env flag raises the enable-writes error", async () => {
  delete process.env.RKT_ALLOW_WRITES;
  const caller = { call: async () => ({ status: 201, body: "{}" }), fetchJson: async () => ({}), secret: null };
  await expect(
    runCommand(WRITE_CMD as never, {
      manifest: FULL_MANIFEST, site: "x", caller: caller as never,
      flags: { json: true, raw: false }, now: new Date(),
      commit: true, args: { title: "t", count: "1" },
    } as never),
  ).rejects.toThrow(/RKT_ALLOW_WRITES/);
});
```

**Define `FULL_MANIFEST` explicitly in this file** (it does not exist anywhere;
prose alone is not executable). Add above the tests:

```ts
const FULL_MANIFEST = {
  schemaVersion: 3,
  site: "x",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-24T00:00:00.000Z",
  harSha256: "d",
  userAgent: "UA",
  clientHints: {},
  auth: { kind: "cookie", location: "cookie:s", mintedBy: null, expiry: null },
  authBundle: null,
  refresh: null,
  mode: "full" as const,
  endpoints: [
    {
      id: "post.api.events",
      method: "POST",
      pathTemplate: "/api/events",
      params: [],
      responseShape: { type: "unknown" as const },
      source: "xhr" as const,
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const },
            count: { type: "number" as const },
            pinned: { type: "string" as const },
          },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    },
  ],
};
```

**Env hygiene (Bun runs test files in one process).** `RKT_ALLOW_WRITES` must not
leak across tests or files. Wrap the env-dependent cases:

```ts
const PRIOR_WRITES_ENV = process.env.RKT_ALLOW_WRITES;
afterAll(() => {
  if (PRIOR_WRITES_ENV === undefined) delete process.env.RKT_ALLOW_WRITES;
  else process.env.RKT_ALLOW_WRITES = PRIOR_WRITES_ENV;
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/command-runner.test.ts`
Expected: FAIL, `res.kind` is undefined and the caller was invoked.

- [ ] **Step 3: Implement**

In `src/lib/render.ts`, export the primitive:

```ts
export function redactClone<T>(data: T, paths: string[]): T {
```

In `src/lib/command-runner.ts`:

Widen the caller and options:

```ts
export interface RunnerCaller {
  call(
    endpointId: string,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: string }>;
  fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown>;
  readonly secret?: Record<string, string> | null;
}
```

```ts
export interface RunOpts {
  // ...existing fields...
  /** True when --commit was passed. A write only sends when this is true. */
  commit?: boolean;
  /** Parsed --<name> flag values, for @arg: holes. */
  args?: Record<string, string>;
}
```

```ts
export interface RunResult {
  /** "preview" means nothing was sent. Optional so existing literals still typecheck. */
  kind?: "preview" | "sent";
  rendered: string;
  // ...existing optional fields unchanged...
}
```

**Why `kind` is optional, not required.** `tests/command-runner.test.ts:296, 308,
319` construct `RunResult` literals directly for `finishRun` with no `kind`.
`bun test` does not typecheck, so a required `kind` would look green here and
only blow up at Task 12's `bunx tsc --noEmit`. Either make it optional as above,
**or** make it required and update those three literals in this task. Do not
leave it required and unfixed. Read-path returns should still set
`kind: "sent"` explicitly so the discriminant is meaningful.

Add the materialiser above `runCommand`:

```ts
// NOTE on imports: command-runner.ts already imports `getPath` from "./render"
// (line 8) and maskSecretValues/redactAll from "./secrets". Do NOT add a second
// import statement for those modules; EXTEND the existing ones, or you get a
// duplicate-identifier compile error.
//   existing: import { getPath, renderJson, renderTable, sortRows } from "./render";
//   becomes:  import { getPath, redactClone, renderJson, renderTable, sortRows } from "./render";
//   existing: import { maskSecretValues, redactAll } from "./secrets";
//   becomes:  import { maskHeaders, maskSecretValues, redactAll } from "./secrets";
import { buildRequest, writesEnabled } from "./transport";

/** The JsonShape type at a dotted body path, if the manifest models one. */
function shapeTypeAt(shape: JsonShape | null | undefined, path: string): string | undefined {
  let node: JsonShape | undefined = shape ?? undefined;
  for (const key of path.split(".").filter(Boolean)) {
    if (!node || node.type !== "object") return undefined;
    node = node.properties[key];
  }
  return node?.type;
}

/**
 * Tokens resolve to strings, but a JSON body needs real numbers and booleans.
 * Coerce against the modelled shape so --count 5 goes on the wire as 5.
 */
function coerce(value: string, type: string | undefined, path: string, hint?: string): unknown {
  // Format hints VALIDATE the string; they never coerce it. A bad --starts_at
  // must fail here, before the value reaches an irreversible request.
  if (hint && type !== "number" && type !== "boolean") {
    const ok =
      hint === "iso8601" ? !Number.isNaN(Date.parse(value))
      : hint === "email" ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
      : hint === "uuid" ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      : hint === "url" ? URL.canParse(value)
      : true;
    if (!ok) throw new Error(`body field ${path} must be ${hint}, got ${JSON.stringify(value)}`);
  }
  if (type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`body field ${path} must be a number, got ${JSON.stringify(value)}`);
    return n;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`body field ${path} must be true or false, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Walk the body template, resolving tokens per string leaf and coercing. */
async function materialiseBody(
  template: unknown,
  shape: JsonShape | null,
  hints: Record<string, string>,
  ctx: TokenContext,
  now: Date,
  path = "",
): Promise<unknown> {
  if (Array.isArray(template)) {
    return Promise.all(template.map((v) => materialiseBody(v, shape, hints, ctx, now, path)));
  }
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = await materialiseBody(v, shape, hints, ctx, now, path ? `${path}.${k}` : k);
    }
    return out;
  }
  if (typeof template !== "string") return template;
  const resolved = await resolveToken(template, ctx, now);
  return coerce(resolved, shapeTypeAt(shape, path), path, hints[path]);
}
```

`hints` is `ep.writeSemantics?.bodyHints ?? {}`, keyed by the same dotted paths
`collectHints` produced in Task 3, so a hint validates the value at its own path.

**Fixtures for the format-hint test.** Define alongside `FULL_MANIFEST`:
`HINTED_MANIFEST` is `FULL_MANIFEST` with the endpoint's
`bodyShape.properties = { starts_at: { type: "string" } }` and
`bodyHints = { starts_at: "iso8601" }`; `HINTED_CMD` is `WRITE_CMD` with
`call.body = { starts_at: "@arg:starts_at" }` and `redact: []`.

At the top of `runCommand`, seed the context with `args` and branch before the existing read path:

```ts
  const ctx: TokenContext = {
    resolveMe: makeResolveMe(site, identity, caller),
    timezone: opts.timezone,
    args: opts.args ?? {},
  };
```

```ts
  // STRUCTURAL GATE. The trigger is the endpoint's METHOD, never the declared
  // cmd.write flag: a command that targets a write endpoint but omits
  // `write: true` must NOT fall through to the read path and mutate on a bare
  // invocation. cmd.write is a declaration that must AGREE with the method
  // (enforced by assertResolvable, Task 7); it is not the gate. This is the
  // Global Constraint "safety checks are structural, never name-based".
  const ep = manifest.endpoints.find((e) => e.id === cmd.call.endpoint);
  if (!ep) throw new Error(`${cmd.name}: endpoint ${cmd.call.endpoint} is missing from client.json`);
  const isWrite = !["GET", "HEAD"].includes(ep.method.toUpperCase());

  if (isWrite) {
    const body =
      cmd.call.body === undefined
        ? undefined
        : await materialiseBody(
            cmd.call.body,
            ep.writeSemantics?.bodyShape ?? null,
            ep.writeSemantics?.bodyHints ?? {},
            ctx,
            now,
          );

    if (!opts.commit) {
      // Build only, never send. This is dry-run-by-default.
      const built = buildRequest(manifest, ep, params, caller.secret ?? null, body);
      const bodyRedact = (cmd.redact ?? [])
        .filter((r) => r.startsWith("body."))
        .map((r) => r.slice("body.".length));
      const preview = {
        method: built.method,
        url: built.url,
        headers: maskHeaders(built.headers, caller.secret ?? null),
        body: body === undefined ? undefined : redactClone(body, bodyRedact),
      };
      const rendered = redactAll(JSON.stringify(maskSecretValues(preview, caller.secret ?? null), null, 2), caller.secret ?? null);
      return { kind: "preview", rendered, fullPayload: rendered };
    }

    if (!writesEnabled()) {
      // RKT_ALLOW_WRITES must appear in the MESSAGE, not only the hint:
      // CliError's second argument is stored as `hint` and `toThrow` only
      // inspects `message`, so a hint-only mention is untestable and easy to miss.
      throw new CliError(
        `${cmd.name} is a write and writes are disabled: set RKT_ALLOW_WRITES=1`,
        "set RKT_ALLOW_WRITES=1 to enable writes for this session",
        2,
      );
    }
    const { status, body: resBody } = await caller.call(cmd.call.endpoint, params, body);
    if (status >= 400) {
      // A failed write may still have been applied server-side (the request can
      // commit before the error is returned), and it is NOT auto-retried. Never
      // suggest a bare re-run: that is the double-mutation this feature exists
      // to prevent.
      throw new CliError(
        `HTTP ${status} from ${cmd.call.endpoint}\n${resBody.slice(0, 2000)}`,
        "this write may or may not have been applied; verify the remote state before re-running",
        1,
      );
    }
    // 204 and other empty successes are a success, not a parse error.
    const rendered = resBody.trim().length === 0 ? "" : renderJson(maskSecretValues(JSON.parse(resBody), caller.secret ?? null), { redact: (cmd.redact ?? []).filter((r) => !r.startsWith("body.")), raw: flags.raw });
    return { kind: "sent", rendered, fullPayload: rendered };
  }
```

Add `kind: "sent"` to the two existing read-path return objects so the type is satisfied.

Filter `body.`-prefixed entries out of the response redact list on the read path too (they address the request, not the response).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/command-runner.ts plugins/rkt/skills/derive-client/scripts/src/lib/render.ts plugins/rkt/skills/derive-client/scripts/tests/command-runner.test.ts
git commit -m "$(cat <<'EOF'
feat: materialise curated write bodies with dry-run by default

A bare write builds and previews the request with credentials masked and
body redactions applied, and never touches the network. Sending requires
--commit plus RKT_ALLOW_WRITES.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Codegen emits gated write commands

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/lib/codegen.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/codegen.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `commandNames`/`emitCli` accept writes only for `mode: "full"`; `emitEndpointCli` skips writes; emitted `main()` filters `COMMANDS` by `writesEnabled()` and passes `commit`/`args` to `runCommand`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/codegen.test.ts`:

```ts
test("full mode no longer throws on a write endpoint", () => {
  expect(() => emitCli(FULL_MANIFEST, COMMANDS_WITH_WRITE)).not.toThrow();
});

test("read mode still refuses a write endpoint", () => {
  expect(() => emitCli({ ...FULL_MANIFEST, mode: undefined }, undefined)).toThrow(/read mode/i);
});

test("the uncurated fallback never emits a write command", () => {
  const cli = emitCli(FULL_MANIFEST, undefined);
  expect(cli).not.toContain("post.api.events");
});

test("a curated write command emits --commit and its @arg flags", () => {
  const cli = emitCli(FULL_MANIFEST, COMMANDS_WITH_WRITE);
  expect(cli).toContain("--commit");
  expect(cli).toContain("--title");
});

test("the generated main gates the command list on writesEnabled", () => {
  const cli = emitCli(FULL_MANIFEST, COMMANDS_WITH_WRITE);
  expect(cli).toContain("writesEnabled");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts`
Expected: FAIL. Note the exact message: `emitCli`'s own loop (`codegen.ts:107-111`)
runs first and throws `... read mode **emits** GET and HEAD only`; "derives" is
`commandNames`'s wording (`codegen.ts:26`). Match on `/GET and HEAD only/` rather
than the verb so the test does not depend on which guard fires first.

**Also define `COMMANDS_WITH_WRITE` in this file** (it does not exist): a
`CommandsFile` with `schemaVersion: 1`, `site: "x"`, and one command equal to
Task 9's `WRITE_CMD` (name `event-create`, `write: true`, `call.endpoint`
`post.api.events`, `call.body { name: "@arg:title", count: "@arg:count", pinned: "fixed" }`).
Reuse the same `FULL_MANIFEST` fixture defined in Task 9.

- [ ] **Step 3: Implement**

In `src/lib/codegen.ts`:

Give `commandNames` an opt-in:

```ts
export function commandNames(
  endpoints: ManifestEndpoint[],
  opts: { allowWrites?: boolean } = {},
): Map<string, string> {
```

```ts
    if (!READ_METHODS.has(method) && !opts.allowWrites) {
      throw new Error(
        `refusing ${endpoint.method} ${endpoint.pathTemplate}: read mode derives GET and HEAD only`,
      );
    }
```

The existing `method === "GET" ? segments : [method.toLowerCase(), ...segments]` naming already handles writes; leave it.

In `emitTypes` and `emitCli`, pass the mode through:

```ts
export function emitTypes(manifest: ClientManifest): string {
  const names = commandNames(manifest.endpoints, { allowWrites: manifest.mode === "full" });
```

```ts
export function emitCli(manifest: ClientManifest, commands?: CommandsFile): string {
  if (manifest.mode !== "full") {
    for (const endpoint of manifest.endpoints) {
      if (!READ_METHODS.has(endpoint.method.toUpperCase())) {
        throw new Error(
          `cannot generate ${endpoint.method} ${endpoint.pathTemplate}: read mode emits GET and HEAD only`,
        );
      }
    }
  }
```

In `emitEndpointCli`, skip writes entirely (the uncurated path has no body assembly, no `--commit`, and opt-in dry-run, so a write there would bypass three of the four gates):

```ts
function emitEndpointCli(manifest: ClientManifest): string {
  // The fallback CLI is uncurated. A write must never appear here; writes
  // require an authored commands.json task.
  const readEndpoints = manifest.endpoints.filter((e) => READ_METHODS.has(e.method.toUpperCase()));
  const names = commandNames(readEndpoints);
  const commands = readEndpoints.map((endpoint) => ({
```

**Filtering the first two lines is NOT enough — the rest of the function still
iterates `manifest.endpoints`.** `codegen.ts:127`, `:128-130` and `:133/:137`
build `responseTypes`, `responseMap`, and the type import by mapping over
`manifest.endpoints` and calling `typeName(names.get(e.id)!)`. For a write
endpoint `names.get(id)` is `undefined`, so `typeName(undefined)` throws
`command.split is not a function` and the "fallback emits no writes" test dies
with a TypeError instead of passing. **Replace `manifest.endpoints` with
`readEndpoints` at every one of those sites**, and use
`readEndpoints.length > 0` for the two `.length > 0` guards. After this edit,
`manifest.endpoints` must not appear anywhere else in `emitEndpointCli`.

In `emitTaskCli`, import the gate into the generated file and filter the command
list at runtime. **`emitTaskCli` imports nothing from `../lib/transport` today**
(only `emitEndpointCli` does, at `codegen.ts:156`), so there is no existing import
to extend: author a new line in the emitted preamble,
`import { writesEnabled } from "../lib/transport";`. Then immediately after
`const COMMANDS: CommandSpec[] = ...`:

```ts
const WRITES_ENABLED = writesEnabled();
// With writes disabled the write commands are not registered at all: they do
// not appear in help and dispatch treats them as unknown.
const VISIBLE: CommandSpec[] = COMMANDS.filter((c) => WRITES_ENABLED || !c.write);
const HAS_HIDDEN_WRITES = COMMANDS.some((c) => c.write) && !WRITES_ENABLED;
```

Replace every subsequent use of `COMMANDS` in `usage()`, `suggest()`, and the
dispatch lookup with `VISIBLE`.

**`usage()` has no `lines` array — `lines` belongs to `commandHelp`.** `usage()`
(`codegen.ts:504-521`) writes with `console.error`; emitting `lines.push(...)`
there is a `ReferenceError` in every generated client. Use the matching idiom in
each function:

```ts
  // in usage(), alongside the other console.error calls:
  if (HAS_HIDDEN_WRITES) {
    console.error("");
    console.error("write commands are hidden; set RKT_ALLOW_WRITES=1 to enable them");
  }
```

```ts
  // in commandHelp(), which does have `lines`:
  if (HAS_HIDDEN_WRITES) {
    lines.push("");
    lines.push("write commands are hidden; set RKT_ALLOW_WRITES=1 to enable them");
  }
```

In the emitted `main()`, collect `@arg:` flags and pass the new options. After the existing `overrideParams` loop:

```ts
  // Collect --<name> values for every @arg: hole in this command's body.
  const args: Record<string, string> = {};
  for (const name of argNames(cmd)) {
    const v = flagValue(name);
    if (v !== undefined) args[name] = v;
  }
```

and add the helper to the emitted preamble:

```ts
function argNames(cmd: CommandSpec): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      if (node.startsWith("@arg:")) found.add(node.slice(5));
      return;
    }
    if (node && typeof node === "object") Object.values(node as Record<string, unknown>).forEach(walk);
  };
  walk(cmd.call.body);
  Object.values(cmd.call.params ?? {}).forEach(walk);
  return [...found];
}
```

Pass them into `runCommand`:

```ts
  const result = await runCommand(toRun, {
    manifest,
    site: SITE,
    caller,
    identity: IDENTITY,
    flags,
    now: new Date(),
    overrideParams,
    commit: hasFlag("commit"),
    args,
  });
```

After the run, short-circuit the preview so overflow handling does not treat it as a payload:

```ts
  if (result.kind === "preview") {
    process.stdout.write(result.rendered + "\\n");
    console.error("preview only. Nothing was sent. Re-run with --commit to apply.");
    return;
  }
```

**Emit the `@arg:` flags into help (this is what makes `--title` appear).**
Nothing above causes a write command's holes to show up in `--help`:
`commandHelp` (`codegen.ts:485-489`) emits `--${k}` only for `call.params`, and
the `COMMANDS` literal serialises `"@arg:title"`, not `"--title"`. Extend
`commandHelp` to also walk the command's `call.body` for `@arg:<name>` leaves and
emit one flag line per hole, typed from `writeSemantics.bodyShape` /
`bodyHints` at that path:

```ts
  // Write holes: one flag per @arg: leaf in the body template.
  for (const { name, type, hint } of argFlags(cmd, manifest)) {
    lines.push(`  --${name} <${hint ?? type ?? "string"}>`);
  }
```

`argFlags(cmd, manifest)` is a new codegen-side helper (sibling to `argNames`)
returning `{ name, type, hint }` per hole. Flag names are used **verbatim**, so
`@arg:starts_at` emits `--starts_at`.

**The flag line at `codegen.ts:496` already advertises `--dry-run`, which
`emitTaskCli` never implemented.** Now that a real preview mode exists, fix the
pre-existing inaccuracy rather than appending to it: `--dry-run` on a write is a
synonym for "no `--commit`" (preview), and on a read it stays unimplemented, so
do not advertise it for reads. Emit:

```ts
  lines.push("global flags: --json --raw --limit <n> --full");
  if (cmd.write) lines.push("write flags:  --commit (send it; without this the write only previews)");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/codegen.ts plugins/rkt/skills/derive-client/scripts/tests/codegen.test.ts
git commit -m "$(cat <<'EOF'
feat: emit gated write commands from curated tasks only

Full-mode codegen emits write commands with their @arg flags and --commit,
hides them unless RKT_ALLOW_WRITES is set, and never emits a write through
the uncurated fallback CLI.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Scaffolder emits valid write stubs

**Files:**
- Modify: `plugins/rkt/skills/derive-client/scripts/src/scaffold-commands.ts`
- Test: `plugins/rkt/skills/derive-client/scripts/tests/scaffold-commands.test.ts`

**Interfaces:**
- Produces: `scaffoldCommands(manifest)` output where each write endpoint yields `write: true` plus an `@arg:`-holed body, and the whole file passes `assertResolvable`.

- [ ] **Step 1: Write the failing test**

```ts
test("scaffolds a write endpoint as a write: true stub with @arg holes", () => {
  const file = scaffoldCommands(FULL_MANIFEST);
  const cmd = file.commands.find((c) => c.call.endpoint === "post.api.events")!;
  expect(cmd.write).toBe(true);
  expect(cmd.call.body).toEqual({ name: "@arg:name", count: "@arg:count" });
  expect(() => assertResolvable(file, FULL_MANIFEST.endpoints)).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/scaffold-commands.test.ts`
Expected: FAIL, `cmd.write` is undefined (and `assertResolvable` throws the missing-`write: true` error from Task 7).

- [ ] **Step 3: Implement**

In `src/scaffold-commands.ts`, pass `allowWrites` to `commandNames` and build the stub:

```ts
const READ_METHODS = new Set(["GET", "HEAD"]);

/** Every scalar leaf becomes an editable hole; the curator prunes and pins. */
function stubBody(shape: JsonShape | null, prefix = ""): unknown {
  if (!shape || shape.type !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape.properties)) {
    // A scrubbed map (Task 3) has a single "*" key standing for data-derived
    // keys. There is no real field name to offer, so skip it and leave a marker
    // rather than emitting a hole the curator cannot interpret.
    if (k === "*") {
      out["__scrubbed__"] = "REPLACE: this object was keyed by data (ids/emails); author it by hand";
      continue;
    }
    const path = prefix ? `${prefix}_${k}` : k;
    // Thread the FULL accumulated prefix, not just this level's key: passing
    // only `k` makes grandparents collide at depth >= 3
    // (a.b.name and c.b.name both become @arg:b_name).
    out[k] = v.type === "object" ? stubBody(v, path) : `@arg:${path}`;
  }
  return out;
}
```

**Array-typed leaves.** `v.type === "array"` currently falls into the scalar
branch and emits a bare `@arg:` string where the API expects a list. Emit
`[ "@arg:<path>_0" ]` for an array of scalars, and for an array of objects emit
`[ stubBody(v.items, `${path}_0`) ]`, so the stub is at least shape-correct. A
curator editing a scaffold should never have to discover this by getting a 400.

**Scaffold output must be valid, not just present.** `stubBody`'s holes are what
Task 7's new `@arg:` check validates against, so a stub whose holes do not match
the modelled shape fails `assertResolvable` immediately. Add a test asserting the
scaffolder's own output for a write endpoint passes `assertResolvable` **and**
that a scrubbed (`"*"`) body does not emit an `@arg:` hole.

```ts
export function scaffoldCommands(manifest: ClientManifest): CommandsFile {
  const allowWrites = manifest.mode === "full";
  const names = commandNames(manifest.endpoints, { allowWrites });
  const identity = detectIdentity(manifest);
  const commands = manifest.endpoints
    .filter((e) => e.id !== identity?.endpoint)
    .map((e) => {
      const isWrite = !READ_METHODS.has(e.method.toUpperCase());
      const body = isWrite ? stubBody(e.writeSemantics?.bodyShape ?? null) : undefined;
      return {
        name: names.get(e.id)!,
        summary: `${e.method} ${e.pathTemplate}`,
        call: {
          endpoint: e.id,
          params: {} as Record<string, string>,
          ...(body === undefined ? {} : { body }),
        },
        output: { kind: "json" as const },
        redact: [] as string[],
        ...(isWrite ? { write: true } : {}),
      };
    });

  return { schemaVersion: 1, site: manifest.site, identity, commands };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/scaffold-commands.ts plugins/rkt/skills/derive-client/scripts/tests/scaffold-commands.test.ts
git commit -m "$(cat <<'EOF'
feat: scaffold write endpoints as curated write stubs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Skill guidance, docs, and end-to-end smoke

**Files:**
- Modify: `plugins/rkt/skills/derive-client/SKILL.md`
- Modify: `plugins/rkt/skills/derive-client/README.md`
- Modify: `plugins/rkt/CHANGELOG.md`
- Modify: `decisions.md` (repo root)
- Modify: `plugins/rkt/skills/derive-client/scripts/src/call.ts` (stale comment, if not already fixed in Task 5)

**Reference sweep — these statements are made FALSE by this plan and must all be
corrected, not just supplemented:**

| File / anchor | Currently says | Must become |
|---|---|---|
| `SKILL.md:30` | "`full` (read + write) mode arrives in a later plan" | full mode exists; point at the new section |
| `SKILL.md:257-258` | "Only GET and HEAD endpoints can be called... `call` refuses them" | `call.ts` is read-only **by its own guard**; writes go through curated commands |
| `SKILL.md:230` | tells the agent to smoke with `call.ts` | unchanged for reads; state explicitly that `call.ts` cannot exercise a write |
| `README.md:188` | "Not yet built: `full` (read + write) mode" | built; describe the four gates |
| `src/call.ts:89` | "Throws for any non-GET/HEAD endpoint" (was inherited from `buildRequest`) | describe the local guard added in Task 5 |

Grep for stragglers before committing:

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack && grep -rn "full (read + write)\|Not yet built\|GET and HEAD" plugins/rkt/skills/derive-client/SKILL.md plugins/rkt/skills/derive-client/README.md plugins/rkt/README.md
```

- [ ] **Step 1: Add the Full mode section to `SKILL.md`**

Insert a `## Full mode (read + write)` section covering, in this order:

1. **Recording a write performs it.** You cannot capture `event-create` without creating an event. Use disposable test data you are willing to leave behind, and say plainly that recording mutates real state.
2. **Derive with `--mode full`:** `bun src/derive.ts --site <site> --har <path> --mode full`.
3. **Author the write task fresh.** Never paste a recorded body; the manifest stores only shape and hints. Mark caller fields `@arg:<name>` (flag name is verbatim), pin everything else. A literal leading `@` must be escaped `@@`.
4. **The two-step gate:** bare run previews, `--commit` sends, and both need `RKT_ALLOW_WRITES=1`.
5. **Agent rule:** an agent MUST show the previewed request to the human and get explicit approval before adding `--commit`. `--commit` is a permission-required action.
6. **Limitations:** JSON request bodies only; writes answering 3xx are not derived; writes never auto-retry, so a 401 mid-write reports may-have-applied.

- [ ] **Step 2: Update `README.md`**

Add a "Full mode" subsection mirroring the pipeline table entry (`--mode full`), the four gates, and the `RKT_ALLOW_WRITES` contract.

- [ ] **Step 2b: Record the decision**

Add a `decisions.md` entry: full mode ships behind four independent gates, the
env flag is fail-closed, `call.ts` stays read-only permanently, and writes are
never auto-retried (attended-path idempotency; unattended/cron writes remain out
of scope).

- [ ] **Step 3: Add the CHANGELOG entry**

`plugins/rkt/CHANGELOG.md` currently starts at `## [0.10.0] - 2026-07-23` and has
**no `## [Unreleased]` heading** — create it above `[0.10.0]` first, then add the
entry under it. Do not bump either `plugin.json`; the version (v0.11.0) is spent
at release time.

```markdown
- derive-client: full mode (`--mode full`) derives write endpoints and emits
  curated write commands. Writes are gated four ways: derived in full mode,
  `RKT_ALLOW_WRITES=1`, an authored `commands.json` task, and `--commit`.
  A bare write previews the request and sends nothing. Writes never auto-retry.
  Request bodies are modelled as shape plus format hints; recorded values are
  never persisted.
```

- [ ] **Step 4: Full gate run**

```bash
cd plugins/rkt/skills/derive-client/scripts && bun test && bunx tsc --noEmit
```

The repo-level shell suite is part of `AGENTS.md`'s "Making Changes" gate and is
not covered by `bun test`:

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack && for t in tests/test-*.sh; do bash "$t"; done
```

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack && claude plugin validate plugins/rkt
```

Expected: all green (compare against the Task 0 Step 3 baseline).

- [ ] **Step 4b: Generated-client closure probe (full mode)**

`tsc --noEmit` in `scripts/` does **not** typecheck a generated client. The
standard closure probe is to generate into a temp dir, install, and typecheck
there — this is what catches a `RUNTIME_FILES` gap from the new
`command-runner -> transport` edge:

```bash
cd /tmp && rm -rf rkt-fullmode-probe && mkdir rkt-fullmode-probe
cd /Users/rocket/Documents/Repositories/rkt-stack/plugins/rkt/skills/derive-client/scripts \
  && bun src/generate.ts --manifest <full-mode client.json> --out /tmp/rkt-fullmode-probe
cd /tmp/rkt-fullmode-probe && bun install && bunx tsc --noEmit
```

Expected: exit 0, no `error TS`.

- [ ] **Step 4c: Read-mode regeneration is unperturbed**

Regenerate an existing v2 read client (luma or kirinari-alayacare) and confirm
its `cli.ts` is unchanged, proving read-mode output did not drift:

```bash
bash ~/Documents/Repositories/rkt-clients/<site>/regenerate.sh && \
  git -C ~/Documents/Repositories/rkt-clients status --short
```

Expected: no diff to the client's `cli.ts`. (A re-**derived** client legitimately
moves to `schemaVersion: 3`; this check is about the regenerate path only.)

- [ ] **Step 5: End-to-end smoke against a generated client**

Generate a full-mode client into a scratch dir from a fixture manifest with one write endpoint and an authored `commands.json`, then verify all four gates by hand:

```bash
cd /private/tmp/claude-501/-Users-rocket/0e5a53a1-802b-47c0-a080-a08b48db7550/scratchpad
# 1. flag off: the write is invisible
bun <out>/<site>/cli.ts help
# expect: no event-create; footer says writes are hidden
# 2. flag on: listed, and a bare run previews without sending
RKT_ALLOW_WRITES=1 bun <out>/<site>/cli.ts event-create --title "Smoke test"
# expect: JSON preview, credentials masked, "Nothing was sent."
# 3. commit with the flag off is an unknown command
bun <out>/<site>/cli.ts event-create --title x --commit
# expect: unknown command
```

**Fill in the placeholders before running.** Use a throwaway directory of your
own choosing for `<out>` (do not reuse a scratchpad path from another session),
and build the two inputs explicitly:

- `<full-mode client.json>`: the Task 9 `FULL_MANIFEST` fixture written to disk,
  or a real manifest re-derived with `--mode full`.
- `<site>`: whatever `site` that manifest declares.
- The authored `commands.json` goes at `<out>/<site>/commands.json` **before**
  generating, and is the Task 10 `COMMANDS_WITH_WRITE` fixture.

```bash
OUT=$(mktemp -d)
# write the fixture manifest to $OUT/client.json, then:
bun src/generate.ts --manifest "$OUT/client.json" --out "$OUT"
# author $OUT/<site>/commands.json, then re-run generate to emit the task CLI
```

Record the exact commands and observed output in the PR description. Do not run
step 3's `--commit` against a real site unless you intend the mutation. If you
smoke against a real site, use disposable data, exactly as the skill instructs
for recording.

- [ ] **Step 6: Commit**

```bash
git add plugins/rkt/skills/derive-client/SKILL.md plugins/rkt/skills/derive-client/README.md plugins/rkt/CHANGELOG.md decisions.md plugins/rkt/skills/derive-client/scripts/src/call.ts
git commit -m "$(cat <<'EOF'
docs: document derive-client full mode and its four write gates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Requirement -> task self-review map

| Spec requirement | Task |
|---|---|
| `WriteSemantics` + `mode`, v2-or-v3 acceptance | 1 |
| Existing v2 clients keep working without re-record | 1 (`SUPPORTED_SCHEMA_VERSIONS`) |
| 204 / bodyless write survives both filter gates | 2 |
| Body shape + hints, no recorded values persisted | 3 |
| Multi-sample body merge | 3 (`inferWriteSemantics` loop) |
| Bodyless and non-JSON bodies handled before `inferShape` | 3 |
| Data-derived object keys scrubbed (PII) | 3 (`scrubShape`/`isDataKey`) |
| `writeSemantics` actually populated at construction | 4 (`manifest.ts`) |
| `--mode full` plumbed through `deriveManifest` | 4 |
| Body reaches the wire (all 5 hops) | 5 (`BuiltRequest`, `buildRequest` param, `SchedulerRequest`), 6 (`Caller`), 9 (`RunnerCaller`) |
| Env gate at the send, fail-closed truthiness | 5 (`writesEnabled`, gate in `issue`) |
| Read-mode manifest cannot write regardless of flag | 5 (`buildRequest` mode check) |
| Writes never auto-retry (no double mutation) | 5 (scheduler), 6 (no 401 re-issue) |
| `write` + `call.body` survive validation whitelist | 7 |
| Write/read command mismatch rejected fail-closed | 7 (`assertResolvable`) |
| `@arg:` token, verbatim flag naming | 8 |
| Body tree-walk + string->JSON coercion | 9 (`materialiseBody`, `coerce`) |
| `call.ts` stays read-only (4th write path closed) | 5 (Step 3b local guard + test) |
| Runtime gate keys on METHOD, not `cmd.write` | 9 (`isWrite` from `ep.method`) + regression test |
| Format hints validate `@arg` values pre-wire | 9 (`coerce` hint branch) |
| Unknown `@arg:` hole rejected | 7 (`argPaths` + `shapeTypeAt` check) |
| Uncurated fallback emits no writes, and does not crash | 10 (`readEndpoints` at every site) |
| `@arg:` holes actually emitted as `--flags` | 10 (`argFlags` in `commandHelp`) |
| Failed write never suggests a bare re-run | 9 (may-have-applied hint) |
| Long ordinary field names not scrubbed | 3 (`isDataKey` false-positive test) |
| Scaffold output passes `assertResolvable` | 11 (stub validity test) |
| Existing tests updated, not silently broken | 1 (`derive.test.ts`), 5 (`transport.test.ts`), 9 (`RunResult` literals) |
| Generated client typechecks in full mode | 12 (Step 4b closure probe) |
| Repo shell-test gate run | 0 (baseline), 12 (Step 4) |
| Docs that become false are corrected | 12 (reference sweep table) |
| Dry-run by default, `--commit` to send | 9 (`kind: "preview"`), 10 (`hasFlag("commit")`) |
| Preview returns a result, no `exit()` in the library | 9 |
| Credentials masked + `body.` redaction in the echo | 9 (`maskHeaders`, `redactClone`) |
| Codegen no longer throws on writes in full mode | 10 |
| Uncurated fallback never exposes a write | 10 (`emitEndpointCli` filter) |
| Flag-off writes hidden from help, generic footer | 10 (`VISIBLE`, `HAS_HIDDEN_WRITES`) |
| Scaffolder emits schema-valid write stubs | 11 |
| Skill: disposable-data recording, two-step, agent consent | 12 |
| JSON-only bodies and 3xx writes documented as limits | 12 |
| Version bump deferred to release time | Global Constraints + 12 (CHANGELOG only) |
