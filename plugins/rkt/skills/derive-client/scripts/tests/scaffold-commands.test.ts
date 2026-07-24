import { expect, test } from "bun:test";
import { scaffoldCommands } from "../src/scaffold-commands";
import { assertResolvable, validateCommandsFile } from "../src/lib/commands-schema";
import type { ClientManifest, JsonShape, ManifestEndpoint } from "../src/lib/manifest-schema";

function e(over: Partial<ManifestEndpoint>): ManifestEndpoint {
  return {
    id: "get.x", method: "GET", pathTemplate: "/x", params: [],
    responseShape: { type: "unknown" }, source: "xhr", fragile: false,
    selectors: null, writeSemantics: null, ...over,
  };
}
function manifestOnly(endpoints: ManifestEndpoint[]): ClientManifest {
  return {
    schemaVersion: 2, site: "s", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
    userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null, endpoints,
  } as ClientManifest;
}

const manifest = (extra: unknown[] = []) => ({
  schemaVersion: 2, site: "example", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
  userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null,
  endpoints: [
    { id: "get.api.shifts", method: "GET", pathTemplate: "/api/shifts", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
    ...extra,
  ],
});

const userObj: JsonShape = {
  type: "object",
  properties: { api_id: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
  required: ["api_id"],
};

test("scaffolds a valid commands.json with one json command per endpoint", () => {
  const cf = scaffoldCommands(manifest() as never);
  expect(() => validateCommandsFile(cf)).not.toThrow();
  expect(cf.commands.map((c) => c.name)).toContain("api-shifts");
  expect(cf.commands[0].output.kind).toBe("json");
  expect(cf.identity).toBeUndefined();
});

test("guesses identity from an id-free .me endpoint", () => {
  const me = {
    id: "get.api.employees.me", method: "GET", pathTemplate: "/api/employees/me", params: [],
    responseShape: {
      type: "object" as const,
      properties: { id: { type: "string" as const }, full_name: { type: "string" as const } },
      required: ["id"],
    },
    source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null,
  };
  const cf = scaffoldCommands(manifest([me]) as never);
  expect(cf.identity?.endpoint).toBe("get.api.employees.me");
  expect(cf.identity?.idField).toBe("id");
  // the identity endpoint is not also emitted as a plain command
  expect(cf.commands.some((c) => c.call.endpoint === "get.api.employees.me")).toBe(false);
});

test("detects a nested user-object endpoint and seeds params from the example", () => {
  const cf = scaffoldCommands(manifestOnly([
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
  const cf = scaffoldCommands(manifestOnly([
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
  const cf = scaffoldCommands(manifestOnly([
    e({ id: "get.viewer", pathTemplate: "/viewer",
        responseShape: { type: "object", properties: { username: { type: "string" }, name: { type: "string" } }, required: ["username"] } }),
  ]));
  expect(cf.identity).toEqual({ endpoint: "get.viewer", idField: "username", display: ["name"], params: undefined });
});

test("emits no identity when nothing looks like a user object", () => {
  const cf = scaffoldCommands(manifestOnly([
    e({ id: "get.things", pathTemplate: "/things",
        responseShape: { type: "object", properties: { things: { type: "array", items: { type: "unknown" } } }, required: [] } }),
  ]));
  expect(cf.identity).toBeUndefined();
});

const FULL_MANIFEST: ClientManifest = {
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
  mode: "full",
  endpoints: [
    {
      id: "post.api.events",
      method: "POST",
      pathTemplate: "/api/events",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: {
          type: "object",
          properties: {
            name: { type: "string" },
            count: { type: "number" },
          },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    },
  ],
};

test("scaffolds a write endpoint as a write: true stub with @arg holes", () => {
  const file = scaffoldCommands(FULL_MANIFEST);
  const cmd = file.commands.find((c) => c.call.endpoint === "post.api.events")!;
  expect(cmd.write).toBe(true);
  expect(cmd.call.body).toEqual({ name: "@arg:name", count: "@arg:count" });
  expect(() => assertResolvable(file, FULL_MANIFEST.endpoints)).not.toThrow();
});

test("scaffolds array-typed body leaves as shape-correct stubs", () => {
  const manifest: ClientManifest = {
    ...FULL_MANIFEST,
    endpoints: [{
      id: "post.api.tags",
      method: "POST",
      pathTemplate: "/api/tags",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" } },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" } },
                required: [],
              },
            },
          },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    }],
  };
  const file = scaffoldCommands(manifest);
  const cmd = file.commands[0];
  expect(cmd.call.body).toEqual({
    tags: ["@arg:tags_0"],
    items: [{ label: "@arg:items_0_label" }],
  });
  expect(() => assertResolvable(file, manifest.endpoints)).not.toThrow();
});

test("threads full accumulated prefix for nested @arg holes", () => {
  const manifest: ClientManifest = {
    ...FULL_MANIFEST,
    endpoints: [{
      id: "post.api.nested",
      method: "POST",
      pathTemplate: "/api/nested",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: {
          type: "object",
          properties: {
            a: {
              type: "object",
              properties: { b: { type: "object", properties: { name: { type: "string" } }, required: [] } },
              required: [],
            },
            c: {
              type: "object",
              properties: { b: { type: "object", properties: { name: { type: "string" } }, required: [] } },
              required: [],
            },
          },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    }],
  };
  const file = scaffoldCommands(manifest);
  const body = file.commands[0].call.body as Record<string, unknown>;
  expect(body).toEqual({
    a: { b: { name: "@arg:a_b_name" } },
    c: { b: { name: "@arg:c_b_name" } },
  });
  expect(() => assertResolvable(file, manifest.endpoints)).not.toThrow();
});

test("scrubbed map keys emit an @arg hole that fails generation, not a silent marker", () => {
  // The old plain-string "REPLACE: ..." marker bypassed assertResolvable
  // entirely (argPaths ignores non-@arg: strings), so an un-authored scrub
  // could ship as a literal body field with no error. It must now be an
  // @arg: value that resolves to no modelled shape, so generation fails
  // loudly until the curator hand-authors it.
  const manifest: ClientManifest = {
    ...FULL_MANIFEST,
    endpoints: [{
      id: "post.api.map",
      method: "POST",
      pathTemplate: "/api/map",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: {
          type: "object",
          properties: {
            meta: {
              type: "object",
              properties: { "*": { type: "string" } },
              required: [],
            },
            title: { type: "string" },
          },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    }],
  };
  const file = scaffoldCommands(manifest);
  const body = file.commands[0].call.body as Record<string, unknown>;
  const meta = body.meta as Record<string, unknown>;
  expect(typeof meta.__scrubbed__).toBe("string");
  expect(meta.__scrubbed__ as string).toMatch(/^@arg:/);
  expect(body.title).toBe("@arg:title");
  expect(() => assertResolvable(file, manifest.endpoints)).toThrow(/no modelled shape/i);
});

test("a non-object (array) root body fails generation loudly instead of scaffolding no body at all", () => {
  const manifest: ClientManifest = {
    ...FULL_MANIFEST,
    endpoints: [{
      id: "post.api.array-root",
      method: "POST",
      pathTemplate: "/api/array-root",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: { type: "array", items: { type: "string" } },
        bodyHints: {},
        contentType: "application/json",
      },
    }],
  };
  const file = scaffoldCommands(manifest);
  const cmd = file.commands[0];
  expect(cmd.write).toBe(true);
  // The bug: cmd.call.body was `undefined` here, so the curator got no
  // signal a body was expected at all. It must now be a stub that fails
  // assertResolvable, forcing the curator to author it by hand.
  expect(cmd.call.body).toBeDefined();
  expect(() => assertResolvable(file, manifest.endpoints)).toThrow(/no modelled shape/i);
});

test("a non-object (scalar) root body also fails generation loudly", () => {
  const manifest: ClientManifest = {
    ...FULL_MANIFEST,
    endpoints: [{
      id: "post.api.scalar-root",
      method: "POST",
      pathTemplate: "/api/scalar-root",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: { type: "string" },
        bodyHints: {},
        contentType: "application/json",
      },
    }],
  };
  const file = scaffoldCommands(manifest);
  const cmd = file.commands[0];
  expect(cmd.call.body).toBeDefined();
  expect(() => assertResolvable(file, manifest.endpoints)).toThrow(/no modelled shape/i);
});

test("disambiguates colliding _-flattened arg names within one command", () => {
  // a.b and a top-level a_b both flatten to the arg name "a_b"; sharing one
  // --a_b flag would silently write one value into two unrelated body paths.
  const manifest: ClientManifest = {
    ...FULL_MANIFEST,
    endpoints: [{
      id: "post.api.collide",
      method: "POST",
      pathTemplate: "/api/collide",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: {
          type: "object",
          properties: {
            a: { type: "object", properties: { b: { type: "string" } }, required: [] },
            a_b: { type: "string" },
          },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    }],
  };
  const file = scaffoldCommands(manifest);
  const body = file.commands[0].call.body as Record<string, unknown>;
  const names: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === "string" && node.startsWith("@arg:")) names.push(node.slice(5));
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") Object.values(node as Record<string, unknown>).forEach(collect);
  };
  collect(body);
  expect(names.length).toBe(2);
  expect(new Set(names).size).toBe(2); // no collision: two distinct flag names
  expect(() => assertResolvable(file, manifest.endpoints)).not.toThrow();
});
