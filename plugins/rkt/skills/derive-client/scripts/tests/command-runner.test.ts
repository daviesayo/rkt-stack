import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCaller } from "../src/lib/command-runner";
import { finishRun, makeResolveMe, runCommand, runWhoami } from "../src/lib/command-runner";
import { CliError } from "../src/lib/overflow";

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
function caller(
  bodies: Record<string, unknown>,
  calls: { ep: string; params: Record<string, string> }[] = [],
  secret?: Record<string, string> | null,
): RunnerCaller {
  return {
    call: async (ep, params) => { calls.push({ ep, params }); return { status: 200, body: JSON.stringify(bodies[ep]) }; },
    fetchJson: async (ep) => bodies[ep],
    secret,
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
  const out = (await runCommand(cmd, baseOpts(c))).rendered;
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
  const out = (await runCommand(cmd, baseOpts(c))).rendered;
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

test("flags.json forces JSON output for table commands", async () => {
  const c = caller({ "get.shifts": [{ date: "d1" }] });
  const cmd = {
    name: "shifts", summary: "",
    call: { endpoint: "get.shifts", params: {} },
    output: { kind: "table" as const, columns: ["date"] },
    redact: [],
  };
  const out = (await runCommand(cmd, { ...baseOpts(c), flags: { json: true, raw: false } })).rendered;
  expect(out.trimStart().startsWith("[")).toBe(true);
  expect(out).toContain("d1");
  expect(out).not.toMatch(/^date\s/m);
});

test("credential values are masked even with raw", async () => {
  const TOKEN = "super-secret-token-value";
  const c = caller({ "get.me": { id: 1, token: TOKEN, ssn: "visible-ssn" } }, [], { default: TOKEN });
  const cmd = { name: "me", summary: "", call: { endpoint: "get.me", params: {} }, output: { kind: "json" as const }, redact: ["ssn"] };
  const out = (await runCommand(cmd, { ...baseOpts(c), flags: { json: false, raw: true } })).rendered;
  expect(out).toContain("visible-ssn");
  expect(out).not.toContain(TOKEN);
});

test("json output masks secrets with quote and backslash before serialization", async () => {
  const TOKEN = 'va"lue\\tail';
  const c = caller({ "get.me": { id: 1, token: TOKEN } }, [], { default: TOKEN });
  const cmd = { name: "me", summary: "", call: { endpoint: "get.me", params: {} }, output: { kind: "json" as const }, redact: [] };
  const out = (await runCommand(cmd, { ...baseOpts(c), flags: { json: false, raw: true } })).rendered;
  expect(out).not.toContain(TOKEN);
  expect(out).not.toContain('va\\"lue');
  expect(out).toContain("[REDACTED]");
});

test("json output redacts by default and passes raw through", async () => {
  const c = caller({ "get.me": { id: 1, ssn: "secret" } });
  const cmd = { name: "me", summary: "", call: { endpoint: "get.me", params: {} }, output: { kind: "json" as const }, redact: ["ssn"] };
  const masked = (await runCommand(cmd, baseOpts(c))).rendered;
  expect(masked).toContain("[REDACTED]");
  const raw = (await runCommand(cmd, { ...baseOpts(c), flags: { json: false, raw: true } })).rendered;
  expect(raw).toContain("secret");
});

test("runCommand returns rowCount and fullPayload for table output", async () => {
  const c = caller({ "get.shifts": [{ id: "a" }, { id: "b" }] });
  const cmd = {
    name: "items", summary: "s",
    call: { endpoint: "get.shifts", params: {} },
    output: { kind: "table" as const, columns: ["id"] },
  };
  const r = await runCommand(cmd, baseOpts(c));
  expect(r.rowCount).toBe(2);
  expect(JSON.parse(r.fullPayload)).toEqual([{ id: "a" }, { id: "b" }]);
});

test("HTTP >=400 throws CliError with a hint", async () => {
  const c: RunnerCaller = {
    call: async () => ({ status: 500, body: "oops" }),
    fetchJson: async () => ({}),
  };
  const cmd = {
    name: "items", summary: "s",
    call: { endpoint: "get.shifts", params: {} },
    output: { kind: "json" as const },
  };
  await expect(runCommand(cmd, baseOpts(c))).rejects.toThrow(CliError);
});

test("finishRun passes small results through untouched, no spill", async () => {
  const r = { rendered: "id\na\n", rowCount: 1, fullPayload: `[{"id":"a"}]` };
  const done = await finishRun("example", "items", r, { full: false, now: new Date() });
  expect(done.stdout).toBe("id\na\n");
  expect(done.spillPath).toBeUndefined();
  expect(done.size).toEqual({ rows: 1 });
});

test("finishRun caps oversize results and spills the full payload", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: String(i) }));
  const r = {
    rendered: rows.map((x) => x.id).join("\n"),
    rowCount: 500,
    fullPayload: JSON.stringify(rows),
  };
  const done = await finishRun("example", "items", r, { full: false, now: new Date() });
  expect(done.spillPath).toBeDefined();
  expect(done.hint).toContain("--limit");
  expect(await Bun.file(done.spillPath!).text()).toBe(JSON.stringify(rows));
  expect(done.stdout.split("\n").length).toBeLessThanOrEqual(201);
});

test("finishRun with full=true never caps or spills", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: String(i) }));
  const r = { rendered: "big", rowCount: 500, fullPayload: JSON.stringify(rows) };
  const done = await finishRun("example", "items", r, { full: true, now: new Date() });
  expect(done.stdout).toBe("big");
  expect(done.spillPath).toBeUndefined();
});

test("runWhoami formats the identity display", async () => {
  const c = caller({ "get.me": { id: 1, first_name: "Ada", email: "ada@x.test" } });
  const line = await runWhoami("example", { endpoint: "get.me", idField: "id", display: ["first_name", "email"] }, c);
  expect(line).toBe("Ada (ada@x.test)");
});
