# derive-client Plan 3: Typed Client Generator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a standalone, typed CLI per site from its `client.json`, living in a private `rkt-clients` repo that runs without the plugin present.

**Architecture:** A generator in the skill (`scripts/src/generate.ts`) reads a manifest and writes a site directory into `rkt-clients/`: generated TypeScript types from the recorded response shapes, and a CLI with one readable subcommand per endpoint. The shared runtime (auth loading, rate limiting, UA pinning, transport) is **copied** from the skill's already-tested `lib/` into `rkt-clients/lib/` so the generated client has no runtime dependency on the plugin and can run under cron.

**Tech Stack:** Bun 1.3.11, TypeScript, `bun test`. No new dependencies.

**Source spec:** `docs/specs/2026-07-20-derive-client-skill-design.md`
**Predecessors:** Plan 1 (`...-recorder.md`, shipped 0.4.0), Plan 2 (`...-auth.md`, shipped 0.5.0)

## What this plan completes

After this plan, derive-client is usable end to end: record a site, derive a manifest, and get a typed CLI you can cron. That makes this the release point for the whole feature (see Task 10).

Plans 4 and 5 (repair, DOM scrapers, `full` mode writes) remain, but each is an enhancement to a working tool rather than a missing piece of one.

## Release policy change

`AGENTS.md` is amended **on this branch** (commit `f9cf976`, carried through the merge at `c1e13de`) so plugin versions are bumped **at release time, not per change**. The amendment is already committed here and ships with this plan's PR; Task 0 verifies it is present before anything else runs, because the whole release policy below depends on it.

- Tasks 1 to 9 add entries under `## [Unreleased]` in `plugins/rkt/CHANGELOG.md` and **do not touch the plugin manifests**.
- Task 10 turns `[Unreleased]` into `0.6.0`, bumps both manifests once, and hands the tag to the user.

`plugins/rkt/CHANGELOG.md` currently has **no** `## [Unreleased]` section (it opens with `## 0.5.0 — 2026-07-20`), so the first task to touch it creates the heading.

0.4.0 and 0.5.0 were bumped under the old rule and never tagged. They stay as-is in history; `v0.6.0` is the first tag.

## Design decisions pinned by this plan

**1. The generated client is standalone.** The spec requires the `direct` transport to be cron-capable. A generated client that imported from `${CLAUDE_PLUGIN_ROOT}` would break when the plugin updates or moves, so `rkt-clients/` carries its own copy of the runtime.

**2. The runtime is copied, not re-authored.** `generate.ts` copies a fixed allowlist of already-tested files from the skill's `src/lib/` into `rkt-clients/lib/`, overwriting on every run. There is one source of truth (the skill), and the copies are build artifacts marked with a header. The alternative, re-authoring the runtime as string templates inside the generator, would duplicate logic that Plan 2 already tested and let the two drift.

**3. The copied set must be a genuinely closed import graph, and it is not one today.** `src/lib/manifest.ts:2` value-imports `inferShape` from `./synthesize`, which imports `./har`. Copying only `paths, manifest, secrets, ratelimit, transport` produces a repo that dies at module load:

```
error: Cannot find module './synthesize' from '.../lib/manifest.ts'
```

Reproduced on Bun 1.3.11. Pulling `synthesize.ts` and `har.ts` across would fix resolution but ship the entire derivation half of the toolchain (`buildManifest`, `groupEndpoints`, `inferShape`, the HAR parser) into a client repo that needs exactly one function from it, `validateManifest`. Task 1 therefore splits the schema half of `manifest.ts` into `lib/manifest-schema.ts`, which imports only `./synthesize` **types** (erased at runtime). The copied set becomes closed *and* free of dead code.

**4. Generated files are committed.** `rkt-clients/lib/` and each `rkt-clients/<site>/` are checked in, because the point is a client that runs on a machine that has never seen the plugin. They carry a "generated, do not edit" header and a record of the manifest hash they came from.

**5. Header masking, not string redaction, on the dry-run path.** The shipped `src/call.ts:31` masks header values with `maskHeaders` *before* `JSON.stringify`, and `src/lib/secrets.ts:67-70` documents why: masking at the value level "so `JSON.stringify` escaping cannot hide the secret." A secret containing a quote survives serialize-then-redact, because the serialized form is `ab\"cd` and no longer matches the raw secret. Generated clients use the same `maskHeaders` path, so they are never weaker than the `call` they replace.

## Global Constraints

Everything from Plans 1 and 2 still applies. Restated because a task implementer sees only their own task:

- Runtime artifacts (recordings, profiles, secrets) live under the resolved rkt root only, never cwd-relative.
- Skills resolve bundled files via `RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"`. Never reference `./scripts/`.
- All interactive prompts use `AskUserQuestion`. Never bash `read`.
- No machine-local home paths (`/Users/<name>`) hardcoded in any skill file or generated file.
- Safety checks key on structure or shape, never on names.
- **Read mode only:** the generator emits subcommands for GET and HEAD endpoints. It refuses any other method, which cannot appear in a read-mode manifest but is checked anyway.
- **Secrets never enter `rkt-clients`.** Generated clients read `<rkt-root>/secrets/<site>.json` at runtime; no credential is ever written into a generated file. Task 7 asserts this structurally.
- Tests are idempotent, use temp directories, and clean up. `RKT_CLIENTS_ROOT` redirects the root under `NODE_ENV=test` only.
- Typecheck (`bunx tsc --noEmit`) must pass; it runs in the test wrapper.

---

## File Structure

**Created in the plugin:**

- `scripts/src/lib/codegen.ts` — pure emitters: types, command names, CLI source.
- `scripts/src/generate.ts` — generator CLI.
- `scripts/tests/codegen.test.ts`, `generate.test.ts`, `nosecrets.test.ts`

**Created in `rkt-clients` (a new private repo):**

- `.gitignore` — `secrets/`, `recordings/`, `node_modules/`
- `package.json`, `tsconfig.json`, `README.md`
- `lib/` — copied runtime (`paths.ts`, `manifest.ts`, `secrets.ts`, `ratelimit.ts`, `transport.ts`)
- `<site>/client.json`, `<site>/types.ts`, `<site>/cli.ts`

**Modified:**

- `plugins/rkt/skills/derive-client/SKILL.md` — generate step, generated-client usage.
- `tests/test-derive-client.sh` — guard that generated output carries no secrets.
- `plugins/rkt/CHANGELOG.md` — `[Unreleased]`, then `0.6.0` in Task 10.
- Both plugin manifests — **Task 10 only.**

Paths without a `plugins/` or `tests/` prefix are relative to `plugins/rkt/skills/derive-client/`.

---

## Task 0: Preflight

**Files:** none modified.

Two preconditions this plan asserts. Both are cheap to check and expensive to discover mid-execution.

- [ ] **Step 1: Confirm the AGENTS.md amendment is present**

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
grep -q "Bump versions at release time" AGENTS.md && echo "release policy present" || {
  echo "MISSING: this plan's release policy depends on the AGENTS.md amendment" >&2
  echo "It lives on this branch in commit f9cf976. If it is absent, you are on the" >&2
  echo "wrong branch or it was reverted; restore it before continuing." >&2
  exit 1
}
```

Expected: `release policy present`. The amendment is on this branch only, not on `main`; checking out `main` will not show it.

- [ ] **Step 2: Confirm the baseline is green**

```bash
cd plugins/rkt/skills/derive-client/scripts && bun install && bun test && bunx tsc --noEmit
```

Expected: all suites pass and the typecheck is silent. `bun install` matters: a checkout without `node_modules` fails the typecheck with `TS2688: Cannot find type definition file for 'bun'`.

---

## Task 1: Split the manifest schema into a runtime-copyable module

**Files:**
- Create: `scripts/src/lib/manifest-schema.ts`
- Modify: `scripts/src/lib/manifest.ts`
- Modify: `scripts/src/lib/transport.ts`
- Modify: `scripts/tests/manifest.test.ts`

**Interfaces:**
- Produces: `lib/manifest-schema.ts` exporting `SCHEMA_VERSION`, `AuthSpec`, `ManifestEndpoint`, `ClientManifest`, and `validateManifest`. It imports **only types** from `./synthesize`, so it has no runtime dependency.
- `lib/manifest.ts` re-exports all of those (so every existing import keeps working) and retains `BuildManifestInput` and `buildManifest`.

This is the fix for the closed-import-graph problem in design decision 3. Doing it first means Task 5's generator copies a set that actually resolves.

- [ ] **Step 1: Write the failing test**

Append to `tests/manifest.test.ts`:

```ts
import {
  SCHEMA_VERSION as SCHEMA_VERSION_FROM_SCHEMA,
  validateManifest as validateFromSchema,
} from "../src/lib/manifest-schema";

test("manifest-schema exports the schema half independently", () => {
  expect(SCHEMA_VERSION_FROM_SCHEMA).toBe(1);
  expect(() => validateFromSchema({ schemaVersion: 99, site: "x", endpoints: [] })).toThrow(
    /schema version/i,
  );
});

test("manifest re-exports the schema half, so existing imports keep working", async () => {
  const fromManifest = await import("../src/lib/manifest");
  expect(fromManifest.SCHEMA_VERSION).toBe(SCHEMA_VERSION_FROM_SCHEMA);
  expect(typeof fromManifest.validateManifest).toBe("function");
});

test("manifest-schema has no runtime import outside the copyable set", async () => {
  const src = await Bun.file(`${import.meta.dir}/../src/lib/manifest-schema.ts`).text();
  // Every import must be type-only, or resolve to a file in the copied set.
  const imports = [...src.matchAll(/^import\s+(type\s+)?.*?from\s+"([^"]+)";$/gm)];
  expect(imports.length).toBeGreaterThan(0);
  for (const [, typeOnly, from] of imports) {
    if (typeOnly) continue;
    expect(["./paths", "./secrets", "./ratelimit"]).toContain(from);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/manifest.test.ts`
Expected: FAIL at module resolution for `../src/lib/manifest-schema`.

- [ ] **Step 3: Create `src/lib/manifest-schema.ts`**

Move the following out of `src/lib/manifest.ts` verbatim: `SCHEMA_VERSION`, `AuthSpec`, `ManifestEndpoint`, `ClientManifest`, and `validateManifest`. The import line must be **type-only**:

```ts
import type { JsonShape, ParamSpec } from "./synthesize";
```

`import type` is erased at compile time, so this file has no runtime edge to `synthesize.ts`. Do not import `inferShape` here.

- [ ] **Step 4: Reduce `src/lib/manifest.ts` to the builder half**

`manifest.ts` keeps `BuildManifestInput`, `buildManifest`, and the `endpointId` helper. Replace its removed declarations with a re-export so every existing importer is unaffected:

```ts
export type { AuthSpec, ClientManifest, ManifestEndpoint } from "./manifest-schema";
export { SCHEMA_VERSION, validateManifest } from "./manifest-schema";
```

It still value-imports `inferShape` from `./synthesize`, which is correct: the builder belongs to the derivation half and is never copied into a generated client.

- [ ] **Step 5: Point `transport.ts` at the schema module**

In `src/lib/transport.ts`, change the type import so the copied set does not reach into `manifest.ts` at all:

```ts
import type { ClientManifest, ManifestEndpoint } from "./manifest-schema";
```

- [ ] **Step 6: Run tests and prove the copied set now resolves**

```bash
cd plugins/rkt/skills/derive-client/scripts
bun test && bunx tsc --noEmit

# The closure check that fails today.
rm -rf /tmp/rkt-closure && mkdir -p /tmp/rkt-closure/lib
for f in paths manifest-schema secrets ratelimit transport; do
  cp "src/lib/$f.ts" /tmp/rkt-closure/lib/
done
printf 'import { validateManifest } from "./lib/manifest-schema";\nimport { buildRequest } from "./lib/transport";\nconsole.log(typeof validateManifest, typeof buildRequest);\n' > /tmp/rkt-closure/probe.ts
bun /tmp/rkt-closure/probe.ts
rm -rf /tmp/rkt-closure
```

Expected: all tests pass, silent typecheck, and the probe prints `function function`. Before this task the same probe against `manifest.ts` fails with `Cannot find module './synthesize'`.

- [ ] **Step 7: Add the CHANGELOG entry**

`plugins/rkt/CHANGELOG.md` has no `## [Unreleased]` section yet. Create one directly below the `# Changelog` heading:

```markdown
## [Unreleased]

### Changed

- Split the manifest schema (`validateManifest` and its types) into
  `lib/manifest-schema.ts` so it can be copied into a generated client without
  dragging the derivation pipeline along. `lib/manifest.ts` re-exports it, so
  no existing import changes.
```

- [ ] **Step 8: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib plugins/rkt/skills/derive-client/scripts/tests/manifest.test.ts plugins/rkt/CHANGELOG.md
git commit -m "refactor(derive-client): split manifest schema for runtime copying"
```

---

## Task 2: Type emission from recorded shapes

**Files:**
- Create: `scripts/src/lib/codegen.ts`
- Create: `scripts/tests/codegen.test.ts`

**Interfaces:**
- Consumes: `JsonShape` from `lib/synthesize`.
- Produces: `emitType(shape: JsonShape, name: string): string` returning TypeScript source for one exported type. Nested objects become inline literal types, so one endpoint yields exactly one exported name.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { emitType } from "../src/lib/codegen";

test("emits an interface for a flat object", () => {
  const src = emitType(
    {
      type: "object",
      properties: { id: { type: "number" }, name: { type: "string" } },
      required: ["id", "name"],
    },
    "Roster",
  );
  expect(src).toBe(
    "export type Roster = {\n  id: number;\n  name: string;\n};\n",
  );
});

test("marks non-required properties optional", () => {
  const src = emitType(
    {
      type: "object",
      properties: { id: { type: "number" }, note: { type: "string" } },
      required: ["id"],
    },
    "Shift",
  );
  expect(src).toContain("id: number;");
  expect(src).toContain("note?: string;");
});

test("emits arrays of objects", () => {
  const src = emitType(
    {
      type: "object",
      properties: {
        shifts: {
          type: "array",
          items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
        },
      },
      required: ["shifts"],
    },
    "RosterList",
  );
  expect(src).toContain("shifts: Array<{");
  expect(src).toContain("id: number;");
});

test("emits unknown for an unknown shape", () => {
  expect(emitType({ type: "unknown" }, "Opaque")).toBe("export type Opaque = unknown;\n");
});

test("emits an empty-array element type as unknown", () => {
  const src = emitType(
    { type: "object", properties: { rows: { type: "array", items: { type: "unknown" } } }, required: ["rows"] },
    "Rows",
  );
  expect(src).toContain("rows: Array<unknown>;");
});

test("emits null-typed fields as null", () => {
  const src = emitType(
    { type: "object", properties: { endedAt: { type: "null" } }, required: ["endedAt"] },
    "Visit",
  );
  expect(src).toContain("endedAt: null;");
});

test("quotes property names that are not valid identifiers", () => {
  const src = emitType(
    { type: "object", properties: { "content-type": { type: "string" } }, required: ["content-type"] },
    "Headers",
  );
  expect(src).toContain('"content-type": string;');
});

test("a top-level array emits an array type", () => {
  const src = emitType(
    { type: "array", items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
    "Items",
  );
  expect(src.startsWith("export type Items = Array<{")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts`
Expected: FAIL at module resolution for `../src/lib/codegen`.

- [ ] **Step 3: Write the implementation**

```ts
import type { JsonShape } from "./synthesize";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** Render a shape as an inline type expression at the given indent depth. */
function typeExpr(shape: JsonShape, depth: number): string {
  const pad = "  ".repeat(depth);
  const padInner = "  ".repeat(depth + 1);

  switch (shape.type) {
    case "object": {
      const keys = Object.keys(shape.properties);
      if (keys.length === 0) return "Record<string, unknown>";
      const lines = keys.map((key) => {
        const optional = shape.required.includes(key) ? "" : "?";
        return `${padInner}${propKey(key)}${optional}: ${typeExpr(shape.properties[key], depth + 1)};`;
      });
      return `{\n${lines.join("\n")}\n${pad}}`;
    }
    case "array":
      return `Array<${typeExpr(shape.items, depth)}>`;
    case "string":
    case "number":
    case "boolean":
    case "null":
      return shape.type;
    default:
      return "unknown";
  }
}

/** Emit one exported type declaration for an endpoint's response shape. */
export function emitType(shape: JsonShape, name: string): string {
  return `export type ${name} = ${typeExpr(shape, 0)};\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/codegen.ts plugins/rkt/skills/derive-client/scripts/tests/codegen.test.ts
git commit -m "feat(derive-client): emit TypeScript types from recorded shapes"
```

---

## Task 3: Readable command and type names

**Files:**
- Modify: `scripts/src/lib/codegen.ts`
- Modify: `scripts/tests/codegen.test.ts`

**Interfaces:**
- Consumes: `ManifestEndpoint` from `lib/manifest`.
- Produces: `commandNames(endpoints: ManifestEndpoint[]): Map<string, string>` mapping endpoint id to a CLI subcommand name, and `typeName(command: string): string` mapping a command to a PascalCase type name.

Names come from the path, not the raw id, per the repo's readable-identifiers rule. `get.api.roster.id` becomes `api-roster`, not `get-api-roster-id`. Collisions get a deterministic numeric suffix in manifest order, so regenerating the same manifest always produces the same names.

- [ ] **Step 1: Write the failing test**

Append to `tests/codegen.test.ts`:

```ts
import { commandNames, typeName } from "../src/lib/codegen";
import type { ManifestEndpoint } from "../src/lib/manifest";

function ep(over: Partial<ManifestEndpoint>): ManifestEndpoint {
  return {
    id: "get.api.roster.id",
    method: "GET",
    pathTemplate: "/api/roster/{id}",
    params: [],
    responseShape: { type: "unknown" },
    source: "xhr",
    fragile: false,
    selectors: null,
    writeSemantics: null,
    ...over,
  };
}

test("names a GET command from its path, dropping param segments", () => {
  const names = commandNames([ep({})]);
  expect(names.get("get.api.roster.id")).toBe("api-roster");
});

test("includes the method for non-GET endpoints", () => {
  const names = commandNames([
    ep({ id: "head.api.roster.id", method: "HEAD" }),
  ]);
  expect(names.get("head.api.roster.id")).toBe("head-api-roster");
});

test("disambiguates colliding names deterministically", () => {
  const names = commandNames([
    ep({ id: "get.api.roster.id", pathTemplate: "/api/roster/{id}" }),
    ep({ id: "get.api.roster.week", pathTemplate: "/api/roster/{week}" }),
  ]);
  expect(names.get("get.api.roster.id")).toBe("api-roster");
  expect(names.get("get.api.roster.week")).toBe("api-roster-2");
});

test("a path of only params falls back to the method", () => {
  const names = commandNames([ep({ id: "get.id", pathTemplate: "/{id}" })]);
  expect(names.get("get.id")).toBe("get");
});

test("typeName converts a command to PascalCase with a Response suffix", () => {
  expect(typeName("api-roster")).toBe("ApiRosterResponse");
  expect(typeName("api-roster-2")).toBe("ApiRoster2Response");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts`
Expected: FAIL at import — no export named `commandNames`.

- [ ] **Step 3: Append the implementation to `lib/codegen.ts`**

```ts
import type { ManifestEndpoint } from "./manifest";

/**
 * Derive readable subcommand names from paths rather than raw endpoint ids.
 * Collisions are resolved by appending -2, -3 in manifest order, so the same
 * manifest always regenerates the same names.
 */
export function commandNames(endpoints: ManifestEndpoint[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Map<string, number>();

  for (const endpoint of endpoints) {
    const segments = endpoint.pathTemplate
      .split("/")
      .filter(Boolean)
      .filter((s) => !/^\{.*\}$/.test(s))
      .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
      .filter(Boolean);

    const method = endpoint.method.toUpperCase();
    const parts = method === "GET" ? segments : [method.toLowerCase(), ...segments];
    const base = parts.length > 0 ? parts.join("-") : method.toLowerCase();

    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    out.set(endpoint.id, seen === 0 ? base : `${base}-${seen + 1}`);
  }

  return out;
}

export function typeName(command: string): string {
  const pascal = command
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${pascal}Response`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/codegen.ts plugins/rkt/skills/derive-client/scripts/tests/codegen.test.ts
git commit -m "feat(derive-client): derive readable command names from paths"
```

---

## Task 4: CLI source emission

**Files:**
- Modify: `scripts/src/lib/codegen.ts`
- Modify: `scripts/tests/codegen.test.ts`

**Interfaces:**
- Consumes: `ClientManifest`, `commandNames`, `typeName`.
- Produces: `emitTypes(manifest): string` (the whole `types.ts`) and `emitCli(manifest): string` (the whole `cli.ts`). Both are pure string functions, so they are fully unit-testable without touching the filesystem.

- [ ] **Step 1: Write the failing test**

Append to `tests/codegen.test.ts`:

```ts
import { emitCli, emitTypes } from "../src/lib/codegen";
import type { ClientManifest } from "../src/lib/manifest";

const manifest: ClientManifest = {
  schemaVersion: 1,
  site: "example",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "deadbeef",
  userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
  clientHints: {},
  auth: { kind: "cookie", location: "cookie:sessionid", mintedBy: null, expiry: null },
  endpoints: [
    ep({
      id: "get.api.roster.id",
      params: [
        { name: "id", in: "path", type: "number" },
        { name: "week", in: "query", type: "string" },
      ],
      responseShape: {
        type: "object",
        properties: { shifts: { type: "array", items: { type: "unknown" } } },
        required: ["shifts"],
      },
    }),
  ],
};

test("emitTypes declares one exported type per endpoint", () => {
  const src = emitTypes(manifest);
  expect(src).toContain("export type ApiRosterResponse = {");
  expect(src).toContain("shifts: Array<unknown>;");
});

test("emitTypes marks the file as generated", () => {
  expect(emitTypes(manifest)).toMatch(/generated/i);
});

test("emitCli records the manifest hash it was generated from", () => {
  expect(emitCli(manifest)).toContain("deadbeef");
});

test("emitCli emits a subcommand per endpoint with its params", () => {
  const src = emitCli(manifest);
  expect(src).toContain('"api-roster"');
  expect(src).toContain('"id"');
  expect(src).toContain('"week"');
});

test("emitCli imports the shared runtime from the sibling lib", () => {
  const src = emitCli(manifest);
  expect(src).toContain('from "../lib/transport"');
  expect(src).toContain('from "../lib/secrets"');
});

test("emitCli contains no credential value", () => {
  expect(emitCli(manifest)).not.toContain("sessionid=");
});

test("emitCli throws on a write-method endpoint", () => {
  const bad: ClientManifest = {
    ...manifest,
    endpoints: [ep({ id: "delete.api.shift.id", method: "DELETE" })],
  };
  expect(() => emitCli(bad)).toThrow(/GET and HEAD only/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts`
Expected: FAIL at import — no export named `emitTypes`.

- [ ] **Step 3: Append the implementation to `lib/codegen.ts`**

```ts
import type { ClientManifest } from "./manifest";

const GENERATED_HEADER = (manifest: ClientManifest) =>
  `// GENERATED by rkt derive-client. Do not edit.
// site: ${manifest.site}
// manifest schemaVersion: ${manifest.schemaVersion}
// derived from HAR sha256: ${manifest.harSha256}
// recorded: ${manifest.recordedAt}
// Regenerate with: /derive-client, then generate.ts --manifest <path>
`;

const READ_METHODS = new Set(["GET", "HEAD"]);

export function emitTypes(manifest: ClientManifest): string {
  const names = commandNames(manifest.endpoints);
  const blocks = manifest.endpoints.map((endpoint) =>
    emitType(endpoint.responseShape, typeName(names.get(endpoint.id)!)),
  );
  return `${GENERATED_HEADER(manifest)}\n${blocks.join("\n")}`;
}

export function emitCli(manifest: ClientManifest): string {
  for (const endpoint of manifest.endpoints) {
    if (!READ_METHODS.has(endpoint.method.toUpperCase())) {
      throw new Error(
        `cannot generate ${endpoint.method} ${endpoint.pathTemplate}: read mode emits GET and HEAD only`,
      );
    }
  }

  const names = commandNames(manifest.endpoints);
  const commands = manifest.endpoints.map((endpoint) => ({
    command: names.get(endpoint.id)!,
    id: endpoint.id,
    method: endpoint.method,
    pathTemplate: endpoint.pathTemplate,
    params: endpoint.params,
  }));

  // The command table is emitted as data, not as generated control flow:
  // one runtime dispatch loop is far easier to read and debug than N
  // generated functions, and it keeps the generated file small.
  //
  // The table is NOT `as const`. With it, a manifest whose endpoints are all
  // param-less types every `params` as `readonly []`, so the element of
  // `params.map((p) => ...)` is `never` and the generated file fails to
  // typecheck with TS2339. Verified on tsc 5.9 under --strict. A mixed
  // manifest happens to survive via the union, which makes this a defect that
  // only shows up on certain sites.
  return `${GENERATED_HEADER(manifest)}
import { readFile } from "node:fs/promises";
import { validateManifest } from "../lib/manifest-schema";
import { createLimiter } from "../lib/ratelimit";
import { maskHeaders, readSecret, redact } from "../lib/secrets";
import { buildRequest, issue } from "../lib/transport";
import type { ${responseTypes.join(", ")} } from "./types";

interface CommandSpec {
  command: string;
  id: string;
  method: string;
  pathTemplate: string;
  params: Array<{ name: string; in: "path" | "query"; type: "string" | "number" }>;
}

const COMMANDS: CommandSpec[] = ${JSON.stringify(commands, null, 2)};

/** Response type per command, for callers importing this module. */
export type ResponseFor = {
${responseMap.join("\n")}
};

function usage(): never {
  console.error("usage: bun cli.ts <command> [--param value ...] [--dry-run]");
  console.error("");
  console.error("commands:");
  for (const c of COMMANDS) {
    const params = c.params.map((p) => \`--\${p.name} <\${p.type}>\`).join(" ");
    console.error(\`  \${c.command.padEnd(28)} \${c.method} \${c.pathTemplate} \${params}\`);
  }
  process.exit(1);
}

async function main() {
  const commandName = process.argv[2];
  if (!commandName || commandName.startsWith("-")) usage();

  const command = COMMANDS.find((c) => c.command === commandName);
  if (!command) {
    console.error(\`unknown command: \${commandName}\`);
    usage();
  }

  const params: Record<string, string> = {};
  for (const p of command.params) {
    const i = process.argv.indexOf(\`--\${p.name}\`);
    if (i !== -1 && process.argv[i + 1] !== undefined) {
      params[p.name] = process.argv[i + 1];
    }
  }

  const manifest = validateManifest(
    JSON.parse(await readFile(new URL("./client.json", import.meta.url), "utf8")),
  );
  const endpoint = manifest.endpoints.find((e) => e.id === command.id);
  if (!endpoint) {
    console.error(\`endpoint \${command.id} is missing from client.json; regenerate this client\`);
    process.exit(1);
  }

  const secret = await readSecret(manifest.site);
  if (manifest.auth && !secret) {
    console.error(
      \`no stored credential for "\${manifest.site}". Re-run /derive-client to refresh it.\`,
    );
    process.exit(1);
  }

  if (manifest.auth?.expiry && Date.parse(manifest.auth.expiry) < Date.now()) {
    console.error(
      \`warning: stored credential expired at \${manifest.auth.expiry}; expect a 401.\`,
    );
  }

  const built = buildRequest(manifest, endpoint, params, secret);

  if (process.argv.includes("--dry-run")) {
    // Mask header VALUES before serializing. Redacting the serialized string
    // instead would miss a secret containing a quote, because JSON escaping
    // rewrites it (ab"cd becomes ab\\"cd and no longer matches).
    console.log(
      JSON.stringify(
        { method: built.method, url: built.url, headers: maskHeaders(built.headers, secret) },
        null,
        2,
      ),
    );
    return;
  }

  const { status, body } = await issue(built, createLimiter());
  if (status >= 400) {
    console.error(\`HTTP \${status}\`);
    console.error(redact(body, secret).slice(0, 2000));
    process.exit(1);
  }
  console.log(redact(body, secret));
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    // buildRequest throws on a missing path param; without this the user gets
    // a raw stack trace while every other failure path prints a clean message.
    console.error((err as Error).message);
    process.exit(1);
  }
}
`;
}
```

Two things to compute before the template, alongside `commands`:

```ts
  const responseTypes = manifest.endpoints.map((e) => typeName(names.get(e.id)!));
  const responseMap = manifest.endpoints.map(
    (e) => `  ${JSON.stringify(names.get(e.id)!)}: ${typeName(names.get(e.id)!)};`,
  );
```

`responseTypes` feeds the `import type` line and `responseMap` the exported `ResponseFor` map, which is what makes `types.ts` load-bearing rather than dead weight. If a manifest has zero endpoints, emit neither the import nor the map: guard both with `manifest.endpoints.length > 0`, since `import type { } from "./types"` is invalid syntax.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/codegen.test.ts && bunx tsc --noEmit`
Expected: PASS, 20 tests, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/lib/codegen.ts plugins/rkt/skills/derive-client/scripts/tests/codegen.test.ts
git commit -m "feat(derive-client): emit generated client source from a manifest"
```

---

## Task 5: The generator CLI and repo scaffold

**Files:**
- Create: `scripts/src/generate.ts`
- Create: `scripts/tests/generate.test.ts`

**Interfaces:**
- Consumes: `emitTypes`, `emitCli`, `validateManifest`.
- Produces: `generateClient(manifestPath: string, outRoot: string): Promise<GeneratedFiles>` where `GeneratedFiles` is `{ siteDir: string; written: string[] }`, and a CLI runnable as `bun src/generate.ts --manifest <path> --out <rkt-clients-root>`.

`generateClient` scaffolds the repo on first run (`.gitignore`, `package.json`, `tsconfig.json`, `README.md`), refreshes `lib/` from the skill's tested runtime, and writes the site directory. It is idempotent: running it twice produces identical output.

`RUNTIME_FILES` is the allowlist copied into `lib/`. `paths.ts`, `manifest.ts`, `secrets.ts`, `ratelimit.ts`, and `transport.ts` form a closed import graph, so nothing else is needed.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateClient } from "../src/generate";

let workRoot: string;
let manifestPath: string;

const MANIFEST = {
  schemaVersion: 1,
  site: "example",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "deadbeef",
  userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
  clientHints: {},
  auth: { kind: "cookie", location: "cookie:sessionid", mintedBy: null, expiry: null },
  endpoints: [
    {
      id: "get.api.roster.id",
      method: "GET",
      pathTemplate: "/api/roster/{id}",
      params: [{ name: "id", in: "path", type: "number" }],
      responseShape: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "rkt-gen-"));
  const manifestDir = join(workRoot, "recording");
  await mkdir(manifestDir, { recursive: true });
  manifestPath = join(manifestDir, "client.json");
  await writeFile(manifestPath, JSON.stringify(MANIFEST));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

test("scaffolds the repo with a gitignore covering secrets and recordings", async () => {
  const out = join(workRoot, "clients-a");
  await generateClient(manifestPath, out);
  const gitignore = await readFile(join(out, ".gitignore"), "utf8");
  expect(gitignore).toContain("secrets/");
  expect(gitignore).toContain("recordings/");
  expect(gitignore).toContain("node_modules/");
});

test("copies the shared runtime into lib/", async () => {
  const out = join(workRoot, "clients-b");
  await generateClient(manifestPath, out);
  for (const f of ["paths.ts", "manifest.ts", "secrets.ts", "ratelimit.ts", "transport.ts"]) {
    const src = await readFile(join(out, "lib", f), "utf8");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/GENERATED|copied/i);
  }
});

test("writes the site directory with client.json, types.ts and cli.ts", async () => {
  const out = join(workRoot, "clients-c");
  const { siteDir } = await generateClient(manifestPath, out);
  expect(siteDir).toBe(join(out, "example"));
  expect(JSON.parse(await readFile(join(siteDir, "client.json"), "utf8")).site).toBe("example");
  expect(await readFile(join(siteDir, "types.ts"), "utf8")).toContain("ApiRosterResponse");
  expect(await readFile(join(siteDir, "cli.ts"), "utf8")).toContain('"api-roster"');
});

test("is idempotent: a second run produces identical bytes", async () => {
  const out = join(workRoot, "clients-d");
  await generateClient(manifestPath, out);
  const first = await readFile(join(out, "example", "cli.ts"), "utf8");
  await generateClient(manifestPath, out);
  const second = await readFile(join(out, "example", "cli.ts"), "utf8");
  expect(second).toBe(first);
});

test("every runtime file in the copied set is present", async () => {
  const out = join(workRoot, "clients-e");
  const { written } = await generateClient(manifestPath, out);
  for (const f of ["paths.ts", "manifest-schema.ts", "secrets.ts", "ratelimit.ts", "transport.ts"]) {
    expect(written.some((p) => p.endsWith(join("lib", f)))).toBe(true);
  }
  // manifest.ts pulls in the derivation pipeline; it must NOT be copied.
  expect(written.some((p) => p.endsWith(join("lib", "manifest.ts")))).toBe(false);
});

test("refuses a manifest with an unsupported schema version", async () => {
  const bad = join(workRoot, "bad.json");
  await writeFile(bad, JSON.stringify({ ...MANIFEST, schemaVersion: 99 }));
  await expect(generateClient(bad, join(workRoot, "clients-f"))).rejects.toThrow(/schema version/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/generate.test.ts`
Expected: FAIL at module resolution for `../src/generate`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Generate a standalone typed client from a derived manifest.
 *
 * Usage: bun src/generate.ts --manifest <path/to/client.json> --out <rkt-clients-root>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitCli, emitTypes } from "./lib/codegen";
import { validateManifest } from "./lib/manifest";

export interface GeneratedFiles {
  siteDir: string;
  written: string[];
}

/**
 * Runtime modules copied into the generated repo.
 *
 * This set is closed ONLY because Task 1 split the schema out of manifest.ts:
 * manifest-schema.ts imports `./synthesize` type-only (erased at runtime),
 * transport.ts imports manifest-schema type-only, secrets.ts imports paths.ts.
 * Copying manifest.ts instead would drag in synthesize.ts and har.ts, i.e. the
 * whole derivation pipeline, for one function.
 *
 * If you add a file here, re-run the closure probe from Task 1 Step 6.
 */
const RUNTIME_FILES = [
  "paths.ts",
  "manifest-schema.ts",
  "secrets.ts",
  "ratelimit.ts",
  "transport.ts",
];

const COPIED_HEADER = `// Copied from the rkt derive-client skill. Do not edit here.
// Edit the skill's src/lib/ and regenerate.
`;

const GITIGNORE = `# Credentials and recordings never belong in this repo.
secrets/
recordings/
node_modules/

# HAR files carry full session cookies wherever they land.
*.har
*.har.zip
`;

// devDependencies are required: tsconfig sets types: ["bun"], so a repo
// without @types/bun installed fails `tsc --noEmit` with TS2688.
const PACKAGE_JSON = `{
  "name": "rkt-clients",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "5.9.2"
  }
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
`;

const README = `# rkt-clients

Generated API clients derived from recorded browser sessions.

Each directory is one site. Run a client with:

    bun <site>/cli.ts <command> [--param value ...] [--dry-run]

Run any command with no arguments to list the available subcommands.

Credentials are NOT stored here. Each client reads its session credential from
\`~/.rkt-clients/secrets/<site>.json\` at runtime. Delete that file to revoke a
client's access.

\`lib/\` and every \`<site>/\` directory are generated. Do not edit them by hand:
re-run \`/derive-client\` and regenerate instead.
`;

async function write(path: string, contents: string, written: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  written.push(path);
}

export async function generateClient(
  manifestPath: string,
  outRoot: string,
): Promise<GeneratedFiles> {
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const written: string[] = [];

  // Repo scaffold. Written every run so the files stay correct; contents are
  // fixed, so this is idempotent.
  await write(join(outRoot, ".gitignore"), GITIGNORE, written);
  await write(join(outRoot, "package.json"), PACKAGE_JSON, written);
  await write(join(outRoot, "tsconfig.json"), TSCONFIG, written);
  await write(join(outRoot, "README.md"), README, written);

  // Shared runtime, copied from this skill's tested lib.
  const libSrc = join(dirname(fileURLToPath(import.meta.url)), "lib");
  for (const file of RUNTIME_FILES) {
    const contents = await readFile(join(libSrc, file), "utf8");
    await write(join(outRoot, "lib", file), `${COPIED_HEADER}\n${contents}`, written);
  }

  // Site directory.
  const siteDir = join(outRoot, manifest.site);
  await write(join(siteDir, "client.json"), `${JSON.stringify(manifest, null, 2)}\n`, written);
  await write(join(siteDir, "types.ts"), emitTypes(manifest), written);
  await write(join(siteDir, "cli.ts"), emitCli(manifest), written);

  return { siteDir, written };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const manifestPath = arg("manifest");
  const out = arg("out");
  if (!manifestPath || !out) {
    console.error("usage: bun src/generate.ts --manifest <path> --out <rkt-clients-root>");
    process.exit(1);
  }

  const { siteDir, written } = await generateClient(manifestPath, out);
  console.error(`Generated ${written.length} file(s).`);
  console.error(`Client: ${siteDir}`);
  console.error(`Run it: bun ${join(siteDir, "cli.ts")}`);
}

if (import.meta.main) {
  await main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/generate.test.ts && bunx tsc --noEmit`
Expected: PASS, 6 tests, silent typecheck.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/src/generate.ts plugins/rkt/skills/derive-client/scripts/tests/generate.test.ts
git commit -m "feat(derive-client): generate standalone typed clients"
```

---

## Task 6: Verify a generated client actually runs

**Files:**
- Create: `scripts/tests/generated-runs.test.ts`

**Interfaces:**
- Consumes: `generateClient`.

Emitting plausible TypeScript is not the same as emitting TypeScript that runs. This task generates a client into a temp directory, then executes it as a subprocess to prove the import graph resolves, the dispatch works, and `--dry-run` produces a real request.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateClient } from "../src/generate";

let workRoot: string;
let outRoot: string;

const MANIFEST = {
  schemaVersion: 1,
  site: "runs",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "deadbeef",
  userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
  clientHints: { "sec-ch-ua": '"Chromium";v="141"' },
  auth: null,
  endpoints: [
    {
      id: "get.api.roster.id",
      method: "GET",
      pathTemplate: "/api/roster/{id}",
      params: [{ name: "id", in: "path", type: "number" }],
      responseShape: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "rkt-runs-"));
  const dir = join(workRoot, "recording");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "client.json"), JSON.stringify(MANIFEST));
  outRoot = join(workRoot, "clients");
  await generateClient(join(dir, "client.json"), outRoot);
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

test("the generated CLI lists its commands when run with no arguments", async () => {
  const proc = Bun.spawn(["bun", join(outRoot, "runs", "cli.ts")], { stderr: "pipe", stdout: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  expect(stderr).toContain("api-roster");
  expect(stderr).toContain("/api/roster/{id}");
});

test("--dry-run builds a real request without network access", async () => {
  const proc = Bun.spawn(
    ["bun", join(outRoot, "runs", "cli.ts"), "api-roster", "--id", "4821", "--dry-run"],
    { stderr: "pipe", stdout: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const preview = JSON.parse(stdout);
  expect(preview.url).toBe("https://x.test/api/roster/4821");
  expect(preview.method).toBe("GET");
  expect(preview.headers["user-agent"]).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(preview.headers["sec-ch-ua"]).toBe('"Chromium";v="141"');
});

test("an unknown command exits non-zero and lists the valid ones", async () => {
  const proc = Bun.spawn(["bun", join(outRoot, "runs", "cli.ts"), "nope"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code).not.toBe(0);
  expect(stderr).toContain("unknown command: nope");
  expect(stderr).toContain("api-roster");
});

test("the generated client typechecks on its own", async () => {
  // The emitted tsconfig sets types: ["bun"], so @types/bun must be installed
  // in the generated repo first. Without this the test fails with TS2688 —
  // the same failure the plugin's own wrapper hits on a fresh checkout.
  const install = Bun.spawn(["bun", "install", "--silent"], {
    cwd: outRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const installCode = await install.exited;
  if (installCode !== 0) {
    // Offline or otherwise unable to install: skip rather than report a
    // failure that says nothing about the generated code.
    console.warn("skipping generated-client typecheck: bun install failed");
    return;
  }

  const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
    cwd: outRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  // tsc writes diagnostics to stdout, not stderr.
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(stdout).toBe("");
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/generated-runs.test.ts`

If Task 4's emitted source has any defect (unresolved import, syntax error, wrong dispatch), these tests fail here. Fix `lib/codegen.ts` until they pass; do not weaken the assertions. The `--dry-run` output must parse as JSON, which means the emitted dry-run branch must print exactly one JSON document.

- [ ] **Step 3: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/tests/generated-runs.test.ts
git commit -m "test(derive-client): execute a generated client end to end"
```

---

## Task 7: Structural no-secrets guarantee for generated output

**Files:**
- Create: `scripts/tests/nosecrets.test.ts`
- Modify: `tests/test-derive-client.sh`

**Interfaces:**
- Consumes: `generateClient`, `writeSecret`.

Plan 2 proved manifests carry no secrets. Generated clients are a new output surface with the same requirement, so it gets the same structural test rather than a grep.

- [ ] **Step 1: Write the test**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateClient } from "../src/generate";
import { writeSecret } from "../src/lib/secrets";

const SECRET = "SUPERSECRETVALUE";
let workRoot: string;
const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;

const MANIFEST = {
  schemaVersion: 1,
  site: "nosecrets",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "deadbeef",
  userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
  clientHints: {},
  auth: { kind: "cookie", location: "cookie:sessionid", mintedBy: null, expiry: null },
  endpoints: [
    {
      id: "get.api.roster.id",
      method: "GET",
      pathTemplate: "/api/roster/{id}",
      params: [{ name: "id", in: "path", type: "number" }],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "rkt-nosecret-"));
  process.env.RKT_CLIENTS_ROOT = join(workRoot, "root");
  // A real stored credential must exist, so the test proves generation does
  // not reach for it rather than passing because none was available.
  await writeSecret("nosecrets", SECRET);
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  await rm(workRoot, { recursive: true, force: true });
});

test("no generated file contains the stored credential", async () => {
  const dir = join(workRoot, "recording");
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "client.json");
  await writeFile(manifestPath, JSON.stringify(MANIFEST));

  const { written } = await generateClient(manifestPath, join(workRoot, "clients"));
  expect(written.length).toBeGreaterThan(0);

  for (const path of written) {
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain(SECRET);
    expect(contents).not.toContain(SECRET.slice(0, 10));
  }
});

test("the generated repo gitignores everything that could hold a credential", async () => {
  // Generate here rather than relying on the previous test's side effect, so
  // this passes under -t filtering and any test ordering.
  const dir = join(workRoot, "recording-gi");
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "client.json");
  await writeFile(manifestPath, JSON.stringify(MANIFEST));
  const out = join(workRoot, "clients-gi");
  await generateClient(manifestPath, out);

  const gitignore = await readFile(join(out, ".gitignore"), "utf8");
  expect(gitignore).toContain("secrets/");
  expect(gitignore).toContain("recordings/");
  // HAR files carry full session cookies wherever they land.
  expect(gitignore).toContain("*.har");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd plugins/rkt/skills/derive-client/scripts && bun test tests/nosecrets.test.ts`
Expected: PASS, 2 tests. A failure means generated output is leaking a credential and must be fixed before proceeding.

- [ ] **Step 3: Add the wrapper guard**

In `tests/test-derive-client.sh`, alongside the existing leak-test check:

```bash
if [[ ! -f "$SCRIPTS/tests/nosecrets.test.ts" ]]; then
  echo "missing structural no-secrets test for generated clients" >&2
  exit 1
fi
```

- [ ] **Step 4: Fix the fresh-clone failure**

Plan 2 added `bunx tsc --noEmit` to this wrapper, which needs `@types/bun` from
`node_modules`. The wrapper skips cleanly when `bun` is absent but not when
dependencies are merely uninstalled, so on a fresh clone the suite **fails**
with `TS2688: Cannot find type definition file for 'bun'`. Verified on this
repo: a checkout without `scripts/node_modules` fails, and `bun install` fixes
it.

Do **not** fix this by running `bun install` inside the wrapper. `tests/test-derive-client.sh`
is one of twelve suite scripts, and AGENTS.md Guardrails require tests to be
idempotent; installing would mutate `bun.lock` and `node_modules/` and require
network on every run, pulling `playwright` and `fflate`. Skip the typecheck
instead, and say so loudly:

```bash
if [[ -d "$SCRIPTS/node_modules" ]]; then
  ( cd "$SCRIPTS" && bunx tsc --noEmit )
else
  echo "derive-client: node_modules absent, skipping typecheck" >&2
  echo "derive-client: run 'cd $SCRIPTS && bun install' to enable it" >&2
fi
```

The unit tests below it still run: `bun test` resolves the workspace's own
source without `node_modules`, and only the typecheck needs the type package.

- [ ] **Step 5: Verify the fix against the reported case**

Use a throwaway clone rather than moving the real `node_modules`, so a failure
cannot leave the working checkout broken:

```bash
TMPCLONE=$(mktemp -d)/rkt-stack
git clone -q --no-hardlinks . "$TMPCLONE"
( cd "$TMPCLONE" && git checkout -q "$(git rev-parse --abbrev-ref HEAD)" && bash tests/test-derive-client.sh )
rm -rf "$(dirname "$TMPCLONE")"
```

Expected: PASS, with the skip message on stderr. Before this change the same
clone fails with `TS2688`.

- [ ] **Step 6: Verify the wrapper passes**

Run: `bash tests/test-derive-client.sh`
Expected: PASS, ending `OK`.

- [ ] **Step 7: Commit**

```bash
git add plugins/rkt/skills/derive-client/scripts/tests/nosecrets.test.ts tests/test-derive-client.sh
git commit -m "test(derive-client): assert generated clients carry no credentials"
```

---

## Task 8: Create the rkt-clients repo and generate the first real client

**Files:** none in this repo. This task produces the private `rkt-clients` repo.

This is the task that turns the feature into something usable. It is a live smoke test, not a unit test.

- [ ] **Step 1: Confirm a real recording exists**

```bash
ls -t ~/.rkt-clients/recordings/*/*/client.json 2>/dev/null | head -3
```

If none has endpoints, run `/derive-client` against a site the user owns first. The Plan 1 example.com recording serves only HTML and will not exercise this path.

- [ ] **Step 2: Generate into a fresh directory**

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
MANIFEST=<path to a client.json with endpoints>
OUT="${HOME}/Documents/Repositories/rkt-clients"

(cd "$SCRIPTS" && bun src/generate.ts --manifest "$MANIFEST" --out "$OUT")
```

Expected: a file count, the site directory path, and a runnable command.

- [ ] **Step 3: Run the generated client**

```bash
bun "$OUT/<site>/cli.ts"                                  # lists commands
bun "$OUT/<site>/cli.ts" <command> --dry-run              # inspect the request
bun "$OUT/<site>/cli.ts" <command> | jq '.' | head -40    # real call
```

Compare the real output against what the browser showed during recording **by shape**: the same fields, the same types, the same nesting. Values will differ, and that is expected.

If the call returns 401 or 403, stop: the credential is wrong, expired, or bound to something the transport does not replay. Re-record rather than guessing.

- [ ] **Step 4: Initialize the repo, private**

```bash
cd "$OUT"
git init -q
git add -A
if git diff --cached --name-only | grep -Ei "secrets/|\.har(\.zip)?$|\.env"; then
  echo "STOP: credential-bearing files are staged. Unstage and fix .gitignore." >&2
else
  git commit -q -m "feat: initial generated clients"
  echo "committed"
fi
```

The `.gitignore` written by the generator already excludes `secrets/` and `recordings/`; the grep above is a second check before anything is committed.

Create the remote only with the user's explicit approval, and only as **private**:

```bash
gh repo create rkt-clients --private --source=. --remote=origin
```

Do not push without asking. This repo describes the shape of the user's personal accounts.

- [ ] **Step 5: Record the outcome**

Report to the user: which site, how many commands, whether the live call matched by shape, and the repo path. If anything did not match, say so plainly rather than declaring success.

---

## Task 9: SKILL.md generate step

**Files:**
- Modify: `plugins/rkt/skills/derive-client/SKILL.md`

- [ ] **Step 1: Add the generate step**

Append immediately before the `## Artifacts` heading:

````markdown
## Step 9: Generate the typed client

`call` is the manual path. For repeat use, generate a standalone client:

```bash
RKT_PLUGIN_ROOT="${RKT_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-<installed-rkt-plugin-root>}}"
SCRIPTS="${RKT_PLUGIN_ROOT}/skills/derive-client/scripts"
MANIFEST="<recordingDir>/client.json"
OUT="${HOME}/Documents/Repositories/rkt-clients"
(cd "$SCRIPTS" && bun src/generate.ts --manifest "$MANIFEST" --out "$OUT")
```

This writes `$OUT/<site>/` with `client.json`, `types.ts`, and `cli.ts`, and
refreshes the shared runtime in `$OUT/lib/`. The generated client has no
dependency on this plugin and can be run from cron.

Use it:

```bash
bun "$OUT/<site>/cli.ts"                        # list commands
bun "$OUT/<site>/cli.ts" <command> --dry-run    # inspect the request
bun "$OUT/<site>/cli.ts" <command>              # run it, JSON to stdout
```

Verify a generated client the same way as `call`: compare against the browser
by shape, not by value.

Generated files carry a "do not edit" header. To change one, re-record or
re-derive and regenerate; hand edits are overwritten on the next run.

Credentials are never written into `rkt-clients`. Each client reads
`<rkt-root>/secrets/<site>.json` at runtime.
````

- [ ] **Step 2: Verify the wrapper passes**

Run: `bash tests/test-derive-client.sh`
Expected: PASS, ending `OK`.

- [ ] **Step 3: Commit**

```bash
git add plugins/rkt/skills/derive-client/SKILL.md
git commit -m "docs(derive-client): document the typed client generator"
```

---

## Task 10: Release 0.6.0

**Files:**
- Modify: `plugins/rkt/CHANGELOG.md`
- Modify: `plugins/rkt/.claude-plugin/plugin.json`
- Modify: `plugins/rkt/.codex-plugin/plugin.json`

This is the **only** task in this plan that touches a version number, per the amended `AGENTS.md` Release Flow that ships on this branch. Tasks 1 to 9 accumulate under `## [Unreleased]`.

- [ ] **Step 1: Confirm the accumulated entry**

`plugins/rkt/CHANGELOG.md` should carry an `## [Unreleased]` section created by Task 1 Step 7 and extended by later tasks. Verify it exists and holds this plan's entries:

```bash
grep -n "## \[Unreleased\]" plugins/rkt/CHANGELOG.md
```

If it is missing (earlier tasks skipped their CHANGELOG step), create it below the `# Changelog` heading with the full set now:

```markdown
## [Unreleased]

### Added

- **Typed client generator** — `/derive-client` now emits a standalone CLI per
  site into a private `rkt-clients` repo: generated TypeScript types from the
  recorded response shapes, one readable subcommand per endpoint, and a copy of
  the shared runtime so the client runs without the plugin installed. Suitable
  for cron.
- Generated clients read their credential from `<rkt-root>/secrets/<site>.json`
  at runtime; no credential is ever written into generated output, which is
  asserted structurally rather than by grep.
```

- [ ] **Step 2: Rename `[Unreleased]` to the release version**

Replace the `## [Unreleased]` heading with `## 0.6.0 — <today's date>` and add a one-line summary beneath it:

```markdown
## 0.6.0 — 2026-07-20

Completes `derive-client`: record a logged-in session, derive a manifest, and
generate a standalone typed CLI for the site's internal API.
```

- [ ] **Step 3: Bump both manifests in lockstep**

Set `"version": "0.6.0"` in both `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json` (current value in both: `0.5.0`).

Verify: `jq -r .version plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json`
Expected: `0.6.0` twice.

- [ ] **Step 4: Run the full gate**

From the main checkout, not a worktree:

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
LANG=en_US.UTF-8 bash -c 'for t in tests/test-*.sh; do bash "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"; done'
claude plugin validate plugins/rkt
```

Expected: all 12 tests OK, validation clean. `LANG` is set because `tests/test-plugin-manifests.sh` uses Ruby's `File.read`, which defaults to US-ASCII and throws on the non-ASCII characters in several SKILL.md files.

- [ ] **Step 5: Commit**

```bash
git add plugins/rkt/CHANGELOG.md plugins/rkt/.claude-plugin/plugin.json plugins/rkt/.codex-plugin/plugin.json
git commit -m "chore: release 0.6.0"
```

- [ ] **Step 6: Stop and hand the tag to the user**

Do **not** tag or push. Report that 0.6.0 is ready and give the user the exact commands:

```bash
git tag -a v0.6.0 -m "v0.6.0"
git push origin main v0.6.0
```

`AGENTS.md` requires explicit approval before pushing to main or pushing tags. Note for the user: 0.4.0 and 0.5.0 were bumped under the previous per-change rule and were never tagged, so `v0.6.0` is the first tag; it covers everything from the start of derive-client.

---

## Requirement → task map

| Spec requirement | Task |
| --- | --- |
| Bun/TypeScript CLI, one subcommand per endpoint | 4 |
| Typed responses derived from recorded shapes | 2 (emission), 4 (`types.ts` imported and exposed as `ResponseFor`) |
| Readable identifiers over raw ids | 3 |
| Shared runtime lib | 5 (copied allowlist), closed by 1 |
| Generated client is standalone and cron-capable | 1 (closed import graph), 5 (no plugin imports), 6 (executes as a subprocess) |
| Auth loaded from the gitignored secrets file | 4 (emitted `readSecret` call), 7 (no credential in output) |
| Human-shaped rate limiting in generated clients | 4 (emitted `createLimiter`) — this is where the Plan 2 limiter finally has multiple calls to pace |
| Pinned UA and client hints | 4, asserted live in 6 |
| `--dry-run` masks credentials | 4 (`maskHeaders` before serialization), asserted live in 6 |
| Read mode only | 4 (`emitCli` refuses writes) |
| `rkt-clients` repo with `.gitignore` for `secrets/`, `recordings/`, `*.har` | 5, verified in 7, enforced again in 8 Step 4 |
| Private repo, no push without approval | 8 |
| Smoke-test the real thing end to end | 6 (generated client runs), 8 (against a real site) |
| Shape-not-value comparison | 8 Step 3, 9 |
| Version bumped once at release, not per plan | 0 (policy present), 10 (single bump) |

**Deferred to later plans, by design:** repair with `flows.json` replay and stale-endpoint retention (Plan 4), DOM scraper endpoints and `full` mode writes with the rollback journal (Plan 5).

## Open risks carried into execution

1. **Task 6 is where emitted-source defects surface.** Tasks 2 to 5 test strings; Task 6 is the first to execute them. Expect to iterate on `emitCli` there. If the emitted dry-run branch prints anything other than exactly one JSON document, the test's `JSON.parse` fails, which is the intended signal.
2. **The copied runtime can drift.** `lib/` in `rkt-clients` is refreshed on every generate, but a client generated months ago and never regenerated runs old code. The copied-file header says where the source lives; Plan 4's repair path is the natural place to also refresh `lib/`.
3. **A manifest with zero endpoints generates an empty CLI.** That is correct behavior for an HTML-only site, but the user should be told plainly rather than handed a client with no commands. Task 8 Step 5 covers reporting it.
4. **`schemaVersion` is pinned at 1.** If Plan 5 makes `AuthSpec` a list (a live risk from Plan 2), generated clients from before the bump will refuse to load newer manifests. That is the intended fail-loud behavior, but it means regenerating every client at that point.
