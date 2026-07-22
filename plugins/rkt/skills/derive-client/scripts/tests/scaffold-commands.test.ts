import { expect, test } from "bun:test";
import { scaffoldCommands } from "../src/scaffold-commands";
import { validateCommandsFile } from "../src/lib/commands-schema";
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
