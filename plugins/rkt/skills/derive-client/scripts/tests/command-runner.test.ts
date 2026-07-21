import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCaller } from "../src/lib/command-runner";
import { makeResolveMe, runCommand, runWhoami } from "../src/lib/command-runner";

let root: string;
const ORIG_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIG_NODE_ENV = process.env.NODE_ENV;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rkt-id-"));
  process.env.RKT_CLIENTS_ROOT = root;
  process.env.NODE_ENV = "test";
});
afterEach(async () => {
  if (ORIG_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIG_ROOT;
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
  await rm(root, { recursive: true, force: true });
});

const manifest = {
  schemaVersion: 2, site: "example", baseUrl: "https://x.test", recordedAt: "", harSha256: "",
  userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null,
  endpoints: [
    { id: "get.shifts", method: "GET", pathTemplate: "/shifts", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
    { id: "get.clients.id", method: "GET", pathTemplate: "/clients/{id}", params: [{ name: "id", in: "path" as const, type: "string" as const }], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
    { id: "get.me", method: "GET", pathTemplate: "/me", params: [], responseShape: { type: "unknown" as const }, source: "xhr" as const, fragile: false, selectors: null, writeSemantics: null },
  ],
};

// A caller whose responses are keyed by endpoint id; records calls for assertions.
function caller(bodies: Record<string, unknown>, calls: { ep: string; params: Record<string, string> }[] = []): RunnerCaller {
  return {
    call: async (ep, params) => { calls.push({ ep, params }); return { status: 200, body: JSON.stringify(bodies[ep]) }; },
    fetchJson: async (ep) => bodies[ep],
  };
}

const NOW = new Date("2026-07-21T12:00:00Z");
const baseOpts = (c: RunnerCaller) => ({ manifest, site: "example", caller: c, flags: { json: false, raw: false }, timezone: "UTC", now: NOW });

test("renders a table, joining and redacting", async () => {
  const c = caller({
    "get.shifts": [{ date: "d2", client_id: 7, address: "1 St" }, { date: "d1", client_id: 7, address: "2 Ave" }],
    "get.clients.id": { name: "Acme", secret: "x" },
  });
  const cmd = {
    name: "shifts", summary: "",
    call: { endpoint: "get.shifts", params: {} },
    join: [{ key: "client_id", endpoint: "get.clients.id", select: ["name"], as: "client", onError: "blank" as const }],
    output: { kind: "table" as const, columns: ["date", "client.name", "address"], sort: "date" },
    redact: ["address"],
  };
  const out = await runCommand(cmd, baseOpts(c));
  const lines = out.split("\n");
  expect(lines[0]).toMatch(/date\s+client\.name\s+address/);
  expect(lines[1]).toContain("d1"); // sorted ascending
  expect(lines[1]).toContain("Acme"); // joined
  expect(lines[1]).toContain("[REDACTED]"); // address masked by default
});

test("dedups join lookups across rows", async () => {
  const calls: { ep: string; params: Record<string, string> }[] = [];
  const c = caller({ "get.shifts": [{ client_id: 7 }, { client_id: 7 }], "get.clients.id": { name: "A" } }, calls);
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: {} },
    join: [{ key: "client_id", endpoint: "get.clients.id", select: ["name"], as: "client", onError: "blank" as const }],
    output: { kind: "table" as const, columns: ["client.name"] }, redact: [],
  };
  await runCommand(cmd, baseOpts(c));
  expect(calls.filter((x) => x.ep === "get.clients.id").length).toBe(1);
});

test("locates rows via output.rows", async () => {
  const c = caller({ "get.shifts": { data: [{ date: "d1" }] } });
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: {} },
    output: { kind: "table" as const, columns: ["date"], rows: "data" }, redact: [],
  };
  const out = await runCommand(cmd, baseOpts(c));
  expect(out).toContain("d1");
});

test("resolves @today params before calling", async () => {
  const calls: { ep: string; params: Record<string, string> }[] = [];
  const c = caller({ "get.shifts": [] }, calls);
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: { start: "@today", end: "@today+14d" } },
    output: { kind: "table" as const, columns: ["date"] }, redact: [],
  };
  await runCommand(cmd, baseOpts(c));
  expect(calls[0].params).toEqual({ start: "2026-07-21", end: "2026-08-04" });
});

test("resolves @me from the identity endpoint", async () => {
  const calls: { ep: string; params: Record<string, string> }[] = [];
  const c = caller({ "get.me": { id: 924 }, "get.shifts": [] }, calls);
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: { employee: "@me" } },
    output: { kind: "json" as const }, redact: [],
  };
  await runCommand(cmd, { ...baseOpts(c), identity: { endpoint: "get.me", idField: "id", display: ["id"] } });
  expect(calls.find((x) => x.ep === "get.shifts")?.params.employee).toBe("924");
});

test("@me without an identity block is a clear error", async () => {
  const c = caller({ "get.shifts": [] });
  const cmd = {
    name: "shifts", summary: "", call: { endpoint: "get.shifts", params: { employee: "@me" } },
    output: { kind: "json" as const }, redact: [],
  };
  await expect(runCommand(cmd, baseOpts(c))).rejects.toThrow(/identity/i);
});

test("json output redacts by default and passes raw through", async () => {
  const c = caller({ "get.me": { id: 1, ssn: "secret" } });
  const cmd = { name: "me", summary: "", call: { endpoint: "get.me", params: {} }, output: { kind: "json" as const }, redact: ["ssn"] };
  const masked = await runCommand(cmd, baseOpts(c));
  expect(masked).toContain("[REDACTED]");
  const raw = await runCommand(cmd, { ...baseOpts(c), flags: { json: false, raw: true } });
  expect(raw).toContain("secret");
});

test("runWhoami formats the identity display", async () => {
  const c = caller({ "get.me": { id: 1, first_name: "Ada", email: "ada@x.test" } });
  const line = await runWhoami("example", { endpoint: "get.me", idField: "id", display: ["first_name", "email"] }, c);
  expect(line).toBe("Ada (ada@x.test)");
});
