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
