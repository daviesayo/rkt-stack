# derive-client Generic Identity Derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `whoami`/`@me` work for any client whose current-user endpoint is keyed by the operator's own id, whether that id is a path literal, a path param, or a query param.

**Architecture:** Add an optional `params` map to `IdentitySpec` (fixed args for the identity call, e.g. the operator's own id), thread it through the identity fetch, replace the `.me`-only auto-detector with a response-shape ranker that seeds `params` from recorded examples, and make the skill capture the operator's own profile deterministically and verify `whoami`.

**Tech Stack:** Bun 1.3.x, TypeScript strict, `bun test`.

**Spec:** `docs/specs/2026-07-22-derive-client-generic-identity-design.md` (read it first).

**Working dir for all commands:** `plugins/rkt/skills/derive-client/scripts` (call it `$S`). Absolute: `/Users/rocket/Documents/Repositories/rkt-stack/plugins/rkt/skills/derive-client/scripts`.

**Branch:** `feat/derive-client-generic-identity` (already created; spec committed at `4b072e1`).

## Global Constraints

- Bun + TS strict. Every task ends green on `bun test` and `bunx tsc --noEmit` from `$S`.
- **The recorded `example` is untrustworthy** (it is whatever profile the recording visited); identity must pin the operator's own id explicitly via `params`, never depend on the example silently.
- **Back-compat:** an identity endpoint with no params (AlayaCare's `get.api.v1.employees.924`, a baked literal) must keep validating and working unchanged.
- **`validateCommandsFile` reconstructs identity by whitelist** — any new field must be added to the reconstruction or it is silently dropped before codegen.
- Keep code generic (no site-specific names). Conventional Commits ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Docs (CHANGELOG under `## [Unreleased]`, SKILL.md) change with the code. Version bump is release-time (v0.9.0), NOT in this plan.
- `ulimit -n 4096` before `bun test` (browser-touching suites can exhaust FDs).

---

### Task 1: `IdentitySpec.params` — type + validated carry-through

**Files:**
- Modify: `src/lib/commands-schema.ts` (IdentitySpec interface ~line 5; add `validateStringMap`; `validateCommandsFile` identity block ~lines 114-122)
- Test: `tests/commands-schema.test.ts`

**Interfaces:**
- Produces: `IdentitySpec` now has optional `params?: Record<string,string>`; `validateCommandsFile` preserves it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/commands-schema.test.ts`:

```ts
test("identity carries a validated params map through validation", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "get.user.profile", params: { username: "usr-me" }, idField: "user.api_id", display: ["user.name"] },
    commands: [],
  });
  expect(cf.identity?.params).toEqual({ username: "usr-me" });
});

test("identity.params rejects a non-string value under an identity.params label", () => {
  expect(() =>
    validateCommandsFile({
      schemaVersion: 1, site: "s",
      identity: { endpoint: "e", params: { username: 5 }, idField: "id", display: [] },
      commands: [],
    }),
  ).toThrow(/identity\.params\.username/);
});

test("identity without params still validates (back-compat)", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "e", idField: "id", display: ["full_name"] },
    commands: [],
  });
  expect(cf.identity?.params).toBeUndefined();
});
```

`validateCommandsFile` is already imported at the top of this test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "$S" && bun test tests/commands-schema.test.ts`
Expected: FAIL — `cf.identity.params` is `undefined` (dropped), and the non-string case does not throw with that label.

- [ ] **Step 3: Write the implementation**

In `src/lib/commands-schema.ts`, add `params` to the interface:

```ts
export interface IdentitySpec {
  endpoint: string;
  params?: Record<string, string>;
  idField: string;
  display: string[];
}
```

Add a labelled string-map validator next to `validateStringArray` (do NOT reuse `validateParams`; its labels are hardcoded to `.call.params`):

```ts
function validateStringMap(value: unknown, field: string): Record<string, string> {
  if (!isPlainObject(value)) fail(field, "must be an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") fail(`${field}.${k}`, "must be a string");
    out[k] = v;
  }
  return out;
}
```

In `validateCommandsFile`, replace the identity reconstruction block:

```ts
  let identity: IdentitySpec | undefined;
  if (o.identity) {
    const i = o.identity as Partial<IdentitySpec>;
    if (typeof i.endpoint !== "string" || typeof i.idField !== "string") {
      fail("identity", "needs endpoint, idField, and display[]");
    }
    const display = validateStringArray(i.display, "identity.display");
    const params = i.params === undefined ? undefined : validateStringMap(i.params, "identity.params");
    identity = { endpoint: i.endpoint, idField: i.idField, display, params };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "$S" && bun test tests/commands-schema.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
cd "$S" && git add src/lib/commands-schema.ts tests/commands-schema.test.ts
git commit -m "feat(derive-client): IdentitySpec gains a validated params map

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `assertResolvable` requires identity params

**Files:**
- Modify: `src/lib/commands-schema.ts` (the `if (commands.identity)` block inside `assertResolvable`)
- Test: `tests/commands-schema.test.ts`

**Interfaces:**
- Consumes: `IdentitySpec.params` (Task 1).
- Produces: `assertResolvable` throws unless every required param of the identity endpoint is present in `identity.params`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/commands-schema.test.ts` (`assertResolvable` is already imported):

```ts
test("assertResolvable accepts an identity endpoint whose required query param is supplied", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "get.user.profile", params: { username: "usr-me" }, idField: "user.api_id", display: ["user.name"] },
    commands: [],
  });
  const eps = [{ id: "get.user.profile", params: [{ name: "username", in: "query", type: "string", required: true }] }];
  expect(() => assertResolvable(cf, eps as never)).not.toThrow();
});

test("assertResolvable rejects when a required identity param is missing", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "get.user.profile", idField: "user.api_id", display: ["user.name"] },
    commands: [],
  });
  const eps = [{ id: "get.user.profile", params: [{ name: "username", in: "query", type: "string", required: true }] }];
  expect(() => assertResolvable(cf, eps as never)).toThrow(/username/);
  expect(() => assertResolvable(cf, eps as never)).toThrow(/identity\.params/);
});

test("assertResolvable accepts a param-free identity endpoint (back-compat)", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "get.api.v1.employees.924", idField: "id", display: ["full_name"] },
    commands: [],
  });
  const eps = [{ id: "get.api.v1.employees.924", params: [] }];
  expect(() => assertResolvable(cf, eps as never)).not.toThrow();
});
```

Also FIND the existing test that asserts the old "identity endpoint ... must be id-free ... path param" behavior (search `tests/commands-schema.test.ts` for `id-free` or `path param`). The old rule is being replaced; update that test: an identity endpoint with a required path param NOT in `params` should now throw a message containing the param name and `identity.params` (not "must be id-free"). If the test wired a path param and expected the old message, change its `.toThrow(...)` regex to `/identity\.params/`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "$S" && bun test tests/commands-schema.test.ts`
Expected: the "missing param" test FAILS (current code ignores query params, so it does not throw), and the updated old-behavior test FAILS on the new message.

- [ ] **Step 3: Write the implementation**

In `src/lib/commands-schema.ts`, replace the identity block inside `assertResolvable`:

```ts
  if (commands.identity) {
    const idEp = need("identity", commands.identity.endpoint);
    const supplied = new Set(Object.keys(commands.identity.params ?? {}));
    const missing = idEp.params.filter((p) => p.required && !supplied.has(p.name));
    if (missing.length) {
      throw new Error(
        `commands.json: identity endpoint '${commands.identity.endpoint}' needs ` +
          `param(s) ${missing.map((p) => p.name).join(", ")} in identity.params ` +
          `(set them to your own id, e.g. from your profile URL)`,
      );
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "$S" && bun test tests/commands-schema.test.ts`
Expected: PASS (all, including the updated old-behavior test). Then `bunx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
cd "$S" && git add src/lib/commands-schema.ts tests/commands-schema.test.ts
git commit -m "feat(derive-client): require identity endpoint params be pinned explicitly

Replaces the id-free-only rule; the recorded example is untrustworthy, so
every required identity param must be set in identity.params.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Thread `params` through the identity call

**Files:**
- Modify: `src/lib/runtime.ts` (`Caller` interface ~line 15-18; `fetchJson` impl ~line 93)
- Modify: `src/lib/identity.ts` (`FetchEndpoint` type line 13; `resolveIdentity` fetch call line 34)
- Modify: `src/lib/command-runner.ts` (`RunnerCaller` line 11; `makeResolveMe` line 46; `runWhoami` line 56)
- Test: `tests/runtime.test.ts`, `tests/identity.test.ts`

**Interfaces:**
- Consumes: `IdentitySpec.params` (Task 1).
- Produces: `Caller.fetchJson(id, params?)`, `RunnerCaller.fetchJson(id, params?)`, `FetchEndpoint = (id, params?) => Promise<unknown>`; `resolveIdentity` calls `fetchEndpoint(spec.endpoint, spec.params ?? {})`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/runtime.test.ts` (uses the file's `baseManifest` and `Scheduler` import):

```ts
test("fetchJson forwards params into the request URL", async () => {
  const seen: string[] = [];
  const sched: Scheduler = {
    run: async (req) => { seen.push(req.url); return { status: 200, body: "{}", headers: {} }; },
  };
  const m = baseManifest();
  m.endpoints = [
    {
      id: "get.user.profile", method: "GET", pathTemplate: "/user/profile",
      params: [{ name: "username", in: "query", type: "string", required: true }],
      responseShape: { type: "unknown" as const }, source: "xhr" as const,
      fragile: false, selectors: null, writeSemantics: null,
    },
  ];
  const caller = createCaller(m, sched, { authorization: "Bearer x" });
  await caller.fetchJson("get.user.profile", { username: "usr-me" });
  expect(seen[0]).toContain("username=usr-me");
});
```

Add to `tests/identity.test.ts`:

```ts
test("resolveIdentity passes spec.params to the fetch and reads nested idField", async () => {
  let seenParams: unknown;
  const s = { endpoint: "get.user.profile", params: { username: "usr-me" }, idField: "user.api_id", display: ["user.name"] };
  const fetchEndpoint = async (_id: string, params?: Record<string, string>) => {
    seenParams = params;
    return { user: { api_id: "usr-me", name: "Ada" } };
  };
  const r = await resolveIdentity("s", s, fetchEndpoint);
  expect(seenParams).toEqual({ username: "usr-me" });
  expect(r.id).toBe("usr-me");
  expect(r.display["user.name"]).toBe("Ada");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "$S" && bun test tests/runtime.test.ts tests/identity.test.ts`
Expected: FAIL — `fetchJson` takes no second arg (param ignored, URL has no query string), and `resolveIdentity` calls `fetchEndpoint(spec.endpoint)` with no params.

- [ ] **Step 3: Write the implementation**

`src/lib/runtime.ts` — widen the `Caller.fetchJson` signature and impl:

```ts
  fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown>;
```
```ts
  async function fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown> {
    const { status, body } = await call(endpointId, params ?? {});
    if (status >= 400) throw new Error(`endpoint ${endpointId} returned HTTP ${status}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`endpoint ${endpointId} did not return JSON`);
    }
  }
```

`src/lib/identity.ts` — widen `FetchEndpoint` and pass params:

```ts
export type FetchEndpoint = (endpointId: string, params?: Record<string, string>) => Promise<unknown>;
```
Change the fetch line in `resolveIdentity` from `await fetchEndpoint(spec.endpoint)` to:
```ts
  const body = await fetchEndpoint(spec.endpoint, spec.params ?? {});
```

`src/lib/command-runner.ts` — widen `RunnerCaller.fetchJson` (line 11):
```ts
  fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown>;
```
Update both closures (in `makeResolveMe` and `runWhoami`) from `(id) => caller.fetchJson(id)` to:
```ts
    (id, p) => caller.fetchJson(id, p)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "$S" && bun test tests/runtime.test.ts tests/identity.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` — clean (this is the step that catches a missed `RunnerCaller` widening).

- [ ] **Step 5: Commit**

```bash
cd "$S" && git add src/lib/runtime.ts src/lib/identity.ts src/lib/command-runner.ts tests/runtime.test.ts tests/identity.test.ts
git commit -m "feat(derive-client): pass identity params through the whoami fetch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Shape-based identity detection in the scaffolder

**Files:**
- Modify: `src/scaffold-commands.ts` (replace the `identityEp` finder in `scaffoldCommands`; add detection helpers; add `JsonShape`/`ParamSpec`/`ManifestEndpoint` imports as needed)
- Test: `tests/scaffold-commands.test.ts`

**Interfaces:**
- Consumes: `IdentitySpec.params` (Task 1).
- Produces: `scaffoldCommands` emits a shape-detected `identity` (with `params` seeded from examples) or none.

- [ ] **Step 1: Write the failing tests**

Add to `tests/scaffold-commands.test.ts`. Define a local endpoint helper if the file lacks one:

```ts
import type { ClientManifest, JsonShape, ManifestEndpoint } from "../src/lib/manifest-schema";

function e(over: Partial<ManifestEndpoint>): ManifestEndpoint {
  return {
    id: "get.x", method: "GET", pathTemplate: "/x", params: [],
    responseShape: { type: "unknown" }, source: "xhr", fragile: false,
    selectors: null, writeSemantics: null, ...over,
  };
}
function manifest(endpoints: ManifestEndpoint[]): ClientManifest {
  return {
    schemaVersion: 2, site: "s", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
    userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null, endpoints,
  } as ClientManifest;
}
const userObj: JsonShape = {
  type: "object",
  properties: { api_id: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
  required: ["api_id"],
};

test("detects a nested user-object endpoint and seeds params from the example", () => {
  const cf = scaffoldCommands(manifest([
    e({ id: "get.notifications.list", pathTemplate: "/notifications/list",
        responseShape: { type: "object", properties: { items: { type: "array", items: { type: "unknown" } } }, required: [] } }),
    e({ id: "get.user.profile", pathTemplate: "/user/profile",
        params: [{ name: "username", in: "query", type: "string", required: true, example: "usr-me" }],
        responseShape: { type: "object", properties: { user: userObj }, required: ["user"] } }),
  ]));
  expect(cf.identity).toEqual({
    endpoint: "get.user.profile", idField: "user.api_id",
    display: ["user.name", "user.email"], params: { username: "usr-me" },
  });
  expect(cf.commands.some((c) => c.call.endpoint === "get.user.profile")).toBe(false);
});

test("prefers a true id-free /me over a param-keyed candidate", () => {
  const cf = scaffoldCommands(manifest([
    e({ id: "get.user.profile", pathTemplate: "/user/profile",
        params: [{ name: "username", in: "query", type: "string", required: true, example: "usr-me" }],
        responseShape: { type: "object", properties: { user: userObj }, required: ["user"] } }),
    e({ id: "get.api.me", pathTemplate: "/api/me",
        responseShape: { type: "object", properties: { id: { type: "string" }, full_name: { type: "string" } }, required: ["id"] } }),
  ]));
  expect(cf.identity?.endpoint).toBe("get.api.me");
  expect(cf.identity?.idField).toBe("id");
  expect(cf.identity?.params).toBeUndefined();
});

test("falls back to username as the idField when no other id field is present", () => {
  const cf = scaffoldCommands(manifest([
    e({ id: "get.viewer", pathTemplate: "/viewer",
        responseShape: { type: "object", properties: { username: { type: "string" }, name: { type: "string" } }, required: ["username"] } }),
  ]));
  expect(cf.identity).toEqual({ endpoint: "get.viewer", idField: "username", display: ["name"], params: undefined });
});

test("emits no identity when nothing looks like a user object", () => {
  const cf = scaffoldCommands(manifest([
    e({ id: "get.things", pathTemplate: "/things",
        responseShape: { type: "object", properties: { things: { type: "array", items: { type: "unknown" } } }, required: [] } }),
  ]));
  expect(cf.identity).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "$S" && bun test tests/scaffold-commands.test.ts`
Expected: FAIL — the current `/\.me$/`-only finder detects none of these (endpoint ids do not end in `.me` except one, and it does not seed params/display/idField from shape).

- [ ] **Step 3: Write the implementation**

In `src/scaffold-commands.ts`, add the imports and detection helpers, and rewrite `scaffoldCommands` to use them:

```ts
import type { ClientManifest, JsonShape, ManifestEndpoint, ParamSpec } from "./lib/manifest-schema";
import type { CommandsFile, IdentitySpec } from "./lib/commands-schema";

const NAME_FIELDS = ["name", "full_name", "display_name", "first_name"];
const ID_FIELDS = ["api_id", "id", "uuid", "user_id", "username"];
const USER_PROP_NAMES = ["user", "profile", "account", "me", "viewer", "employee", "member"];

function objProps(shape: JsonShape | undefined): Record<string, JsonShape> | null {
  return shape && shape.type === "object" ? shape.properties : null;
}
function firstPresent(props: Record<string, JsonShape>, names: string[]): string | null {
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const hit = lower.get(n);
    if (hit) return hit;
  }
  return null;
}
function findUserObject(shape: JsonShape): { userPath: string; props: Record<string, JsonShape> } | null {
  const root = objProps(shape);
  if (!root) return null;
  const has = (props: Record<string, JsonShape>) =>
    (firstPresent(props, NAME_FIELDS) || firstPresent(props, ["email"])) && firstPresent(props, ID_FIELDS);
  if (has(root)) return { userPath: "", props: root };
  for (const name of USER_PROP_NAMES) {
    const key = firstPresent(root, [name]);
    if (!key) continue;
    const sub = objProps(root[key]);
    if (sub && has(sub)) return { userPath: `${key}.`, props: sub };
  }
  return null;
}
function score(e: ManifestEndpoint, rootLevel: boolean): number {
  const p = e.pathTemplate;
  let s = 0;
  if (/(^|\/)(me|self|current|viewer|whoami)(\/|$)/.test(p)) s += 3;
  if (/(^|\/)(user|profile|account|employee|member)(\/|$)/.test(p)) s += 1;
  if (!e.params.some((x) => x.required)) s += 2;
  if (rootLevel) s += 1;
  return s;
}
function detectIdentity(manifest: ClientManifest): IdentitySpec | undefined {
  const cands = manifest.endpoints
    .map((e) => ({ e, u: findUserObject(e.responseShape) }))
    .filter((c): c is { e: ManifestEndpoint; u: { userPath: string; props: Record<string, JsonShape> } } => c.u !== null)
    .map((c) => ({ ...c, s: score(c.e, c.u.userPath === "") }));
  if (!cands.length) return undefined;
  const reqCount = (e: ManifestEndpoint) => e.params.filter((p) => p.required).length;
  cands.sort(
    (a, b) => b.s - a.s || reqCount(a.e) - reqCount(b.e) || manifest.endpoints.indexOf(a.e) - manifest.endpoints.indexOf(b.e),
  );
  const w = cands[0];
  const idKey = firstPresent(w.u.props, ID_FIELDS)!;
  const nameKey = firstPresent(w.u.props, NAME_FIELDS);
  const emailKey = firstPresent(w.u.props, ["email"]);
  const display = [nameKey, emailKey].filter((k): k is string => k !== null).map((k) => `${w.u.userPath}${k}`);
  const params: Record<string, string> = {};
  for (const p of w.e.params as ParamSpec[]) if (p.required) params[p.name] = p.example ?? "";
  return {
    endpoint: w.e.id,
    idField: `${w.u.userPath}${idKey}`,
    display,
    params: Object.keys(params).length ? params : undefined,
  };
}
```

Rewrite `scaffoldCommands` to use it (replace the `const identityEp = ...` finder and the return):

```ts
export function scaffoldCommands(manifest: ClientManifest): CommandsFile {
  const names = commandNames(manifest.endpoints);
  const identity = detectIdentity(manifest);
  const commands = manifest.endpoints
    .filter((e) => e.id !== identity?.endpoint)
    .map((e) => ({
      name: names.get(e.id)!,
      summary: `${e.method} ${e.pathTemplate}`,
      call: { endpoint: e.id, params: {} as Record<string, string> },
      output: { kind: "json" as const },
      redact: [] as string[],
    }));

  return { schemaVersion: 1, site: manifest.site, identity, commands };
}
```

Remove the now-unused old `identityEp` import of `ClientManifest` duplication if the linter flags a duplicate type import; keep a single `import type { ClientManifest, JsonShape, ManifestEndpoint, ParamSpec } from "./lib/manifest-schema";`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "$S" && bun test tests/scaffold-commands.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
cd "$S" && git add src/scaffold-commands.ts tests/scaffold-commands.test.ts
git commit -m "feat(derive-client): detect identity by response shape, seed params

Ranks endpoints returning a single user object; seeds idField/display and
identity.params from recorded examples. Replaces the .me-only finder.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Skill guidance, mandatory verify, CHANGELOG

**Files:**
- Modify: `plugins/rkt/skills/derive-client/SKILL.md` (Step 5, Step 10 identity bullet, Step 11)
- Modify: `plugins/rkt/CHANGELOG.md` (`## [Unreleased]`)

No unit test (docs). Deliverable: the skill instructs deterministic capture, documents `params`, and mandates the verify.

- [ ] **Step 1: SKILL.md Step 5 — deterministic identity capture**

In `plugins/rkt/skills/derive-client/SKILL.md`, find the Step 5 paragraph that currently begins "**Capture identity too.**" (added in v0.8.1) and replace it with:

```markdown
**Capture identity deterministically.** `whoami` and `@me` need a call that
returns the signed-in user. Open **your own** profile or account through the
app's own UI (its avatar or account menu), never by typing a guessed
`/settings`-style URL — a wrong URL can land on a stranger's public profile and
poison the captured id. If the app routes profiles by id (URL like
`/user/<id>`, `/u/<id>`, `/employees/<id>`), that `<id>` in the URL is **your**
id; the current-user endpoint fires on that page and records your id as its
param example. If you skip this, nothing downstream can wire `whoami`.
```

- [ ] **Step 2: SKILL.md Step 10 — document `params`**

Replace the Step 10 identity bullet (currently begins "**`identity`** wires `whoami`") with:

```markdown
- **`identity`** wires `whoami` and `@me`; wire it whenever a current-user
  endpoint exists. It names the endpoint, an `idField` (dotted path to the
  user's id in the response, e.g. `user.api_id`), a `display` list (dotted
  paths to show, e.g. `["user.name"]`), and, when the endpoint needs your own
  id, a `params` map supplying it (e.g. `{"username": "usr-<you>"}`). The
  scaffolder auto-detects the endpoint by response shape and seeds `params`
  from the recorded example, but that example is only correct if you recorded
  **your own** profile: confirm the seeded id is yours (matches your profile
  URL), not a placeholder or a stranger's. Every required param of the identity
  endpoint must appear in `params` or generation fails.
```

- [ ] **Step 3: SKILL.md Step 11 — mandatory whoami verify**

In Step 11 ("Regenerate and read the drift report"), after the regeneration guidance, add:

```markdown
**Verify identity (required when an identity block exists).** Run
`bun "$OUT/<site>/cli.ts" whoami` and confirm it prints the operator's real
name/email. If it prints a stranger, a blank, or an error, the identity is
wrong: fix `identity.params` (or re-record visiting your own profile) and
regenerate. Do not report identity as working without this check.
```

- [ ] **Step 4: CHANGELOG**

In `plugins/rkt/CHANGELOG.md`, under `## [Unreleased]`, add:

```markdown
### Added

- **derive-client: generic identity/`whoami` derivation.** `identity` in
  `commands.json` gains a `params` map, so `whoami`/`@me` work when the
  current-user endpoint is keyed by the operator's own id via a query or path
  param (not only a path literal). The scaffolder now detects the identity
  endpoint by response shape and seeds `params` from the recorded example, and
  the skill captures the operator's own profile deterministically and requires a
  `whoami` verify.
```

- [ ] **Step 5: Verify docs + commit**

Run: `cd /Users/rocket/Documents/Repositories/rkt-stack && claude plugin validate plugins/rkt` (expected: Validation passed) and confirm SKILL.md step numbering is intact (`grep -n "^## Step" plugins/rkt/skills/derive-client/SKILL.md`).

```bash
cd /Users/rocket/Documents/Repositories/rkt-stack
git add plugins/rkt/skills/derive-client/SKILL.md plugins/rkt/CHANGELOG.md
git commit -m "docs(derive-client): deterministic identity capture + mandatory whoami verify

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end smoke + full gate

Proves the mechanism against the real luma client and runs every gate. Writes no production code.

- [ ] **Step 1: Full gate**

```bash
cd "$S"
ulimit -n 4096
bun test
bunx tsc --noEmit
GEN=$(mktemp -d)
bun src/generate.ts --manifest ~/.rkt-clients/recordings/luma/*/client.json --out "$GEN" >/dev/null 2>&1 \
  || bun src/generate.ts --manifest "$(ls -t ~/.rkt-clients/recordings/luma/*/client.json | head -1)" --out "$GEN"
ln -s "$S/node_modules" "$GEN/node_modules"
( cd "$GEN" && bunx tsc --noEmit )
cd /Users/rocket/Documents/Repositories/rkt-stack && claude plugin validate plugins/rkt
```
Expected: `bun test` all pass; both `tsc --noEmit` clean; validation passed.

- [ ] **Step 2: Mechanism proof against real luma**

The operator's own Luma id is visible in their profile URL (`luma.com/user/usr-…`). Wire it by hand into the real client's `commands.json` identity, regenerate, and confirm `whoami` shows the operator, not a stranger:

```bash
S=/Users/rocket/Documents/Repositories/rkt-stack/plugins/rkt/skills/derive-client/scripts
L=~/Documents/Repositories/rkt-clients/luma
# Edit $L/commands.json to add (use the Edit tool, not sed):
#   "identity": { "endpoint": "get.user.profile",
#     "params": { "username": "<operator's own usr- id from their profile URL>" },
#     "idField": "user.api_id", "display": ["user.name"] }
cd "$S" && bun src/generate.ts --manifest "$L/client.json" --out ~/Documents/Repositories/rkt-clients
bun "$L/cli.ts" whoami
```
Expected: prints the operator's real name (e.g. their own Luma display name), not "David Tesler" or a blank. If it prints a stranger, the `params.username` is wrong — fix and re-run.

- [ ] **Step 3: Report**

Report: gate results, the `whoami` output (operator's name), and confirm the 5 existing luma commands still resolve (`bun "$L/cli.ts" help` lists them). Clean up `$GEN`.

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| `IdentitySpec.params` + validation + carry-through | Task 1 |
| `assertResolvable` requires required params in `params` | Task 2 |
| identity call passes params (runtime/identity/command-runner, incl. `RunnerCaller`) | Task 3 |
| shape-based detection replaces `.me`-only; seeds idField/display/params | Task 4 |
| `username` in both detection and idField sets | Task 4 (`ID_FIELDS`) |
| display order name-first | Task 4 (`NAME_FIELDS` order) |
| ranker runs on `pathTemplate` | Task 4 (`score`) |
| example-seed transparent; `""` only when no example | Task 4 (`p.example ?? ""`) |
| no candidate → no identity | Task 4 (test) |
| deterministic detection | Task 4 (sort tie-breaks) |
| deterministic capture guidance | Task 5 (Step 5) |
| `params` documented | Task 5 (Step 10) |
| mandatory whoami verify | Task 5 (Step 11) |
| back-compat (param-free identity) | Tasks 1-2 (tests) |
| array-payload scope limit | accepted, not implemented (spec) |
| JWT-sub | out of scope (spec Future work) |
| mechanism proven end to end | Task 6 |

No gaps.

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code. Task 6 Step 2 requires a hand-edit whose exact JSON is given.

**3. Type consistency:** `IdentitySpec.params?: Record<string,string>` is defined in Task 1 and consumed identically in Tasks 2-4. `fetchJson(id, params?)` / `FetchEndpoint(id, params?)` signatures match across runtime.ts, command-runner.ts (`RunnerCaller`), and identity.ts in Task 3. `detectIdentity` returns the same `IdentitySpec` shape the validator accepts. `firstPresent`/`findUserObject`/`score`/`detectIdentity` are all defined in Task 4.

## Release (after all tasks green, per AGENTS.md — needs approval, NOT in this plan)

New user-visible capability → minor. When usable end to end: rename `## [Unreleased]` → `## [0.9.0] - <date>`, bump both plugin manifests to 0.9.0 in lockstep, commit, tag `v0.9.0`, push branch + tag only after approval.
