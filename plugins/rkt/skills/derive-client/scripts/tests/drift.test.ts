import { expect, test } from "bun:test";
import { detectDrift } from "../src/lib/drift";

const manifest = (ids: string[]) => ({
  schemaVersion: 2, site: "x", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
  userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null,
  endpoints: ids.map((id) => ({ id, method: "GET", pathTemplate: "/" + id, params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null })),
});

const commands = (calls: string[]) => ({
  schemaVersion: 1, site: "x",
  commands: calls.map((ep, i) => ({ name: `c${i}`, summary: "", call: { endpoint: ep, params: {} }, output: { kind: "json" as const }, redact: [] })),
});

test("flags a command whose endpoint vanished", () => {
  const d = detectDrift(commands(["get.gone"]), manifest(["get.here"]));
  expect(d.broken).toEqual([{ command: "c0", endpoint: "get.gone" }]);
});

test("flags manifest endpoints no command references", () => {
  const d = detectDrift(commands(["get.used"]), manifest(["get.used", "get.new"]));
  expect(d.newSurface).toEqual(["get.new"]);
});

test("counts join and identity endpoints as referenced", () => {
  const cf = {
    schemaVersion: 1, site: "x",
    identity: { endpoint: "get.me", idField: "id", display: [] },
    commands: [{
      name: "c", summary: "",
      call: { endpoint: "get.a", params: {} },
      join: [{ key: "k", endpoint: "get.b", select: [], as: "j", onError: "blank" as const }],
      output: { kind: "json" as const }, redact: [],
    }],
  };
  const d = detectDrift(cf, manifest(["get.a", "get.b", "get.me"]));
  expect(d.broken).toEqual([]);
  expect(d.newSurface).toEqual([]);
});

test("a clean match reports no drift", () => {
  const d = detectDrift(commands(["get.a"]), manifest(["get.a"]));
  expect(d.broken).toEqual([]);
  expect(d.newSurface).toEqual([]);
});
