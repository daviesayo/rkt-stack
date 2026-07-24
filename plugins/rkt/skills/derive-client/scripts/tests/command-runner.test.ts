import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
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

const FULL_MANIFEST = {
  schemaVersion: 3,
  site: "x",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-24T00:00:00.000Z",
  harSha256: "d",
  userAgent: "UA",
  clientHints: {},
  auth: { kind: "cookie" as const, location: "cookie:s", mintedBy: null, expiry: null },
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

const HINTED_MANIFEST = {
  ...FULL_MANIFEST,
  endpoints: [
    {
      ...FULL_MANIFEST.endpoints[0],
      writeSemantics: {
        bodyShape: {
          type: "object" as const,
          properties: {
            starts_at: { type: "string" as const },
          },
          required: [],
        },
        bodyHints: { starts_at: "iso8601" },
        contentType: "application/json",
      },
    },
  ],
};

const HINTED_CMD = {
  ...WRITE_CMD,
  call: { endpoint: "post.api.events", body: { starts_at: "@arg:starts_at" } },
  redact: [],
};

const PRIOR_WRITES_ENV = process.env.RKT_ALLOW_WRITES;
afterAll(() => {
  if (PRIOR_WRITES_ENV === undefined) delete process.env.RKT_ALLOW_WRITES;
  else process.env.RKT_ALLOW_WRITES = PRIOR_WRITES_ENV;
});

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

test("table fullPayload masks secrets with quote and backslash before serialization", async () => {
  const TOKEN = 'va"lue\\tail';
  const c = caller({ "get.shifts": [{ id: "a", token: TOKEN }] }, [], { default: TOKEN });
  const cmd = {
    name: "shifts", summary: "",
    call: { endpoint: "get.shifts", params: {} },
    output: { kind: "table" as const, columns: ["id", "token"] },
  };
  const r = await runCommand(cmd, { ...baseOpts(c), flags: { json: false, raw: true } });
  expect(r.fullPayload).not.toContain(TOKEN);
  expect(r.fullPayload).not.toContain('va\\"lue');
  expect(r.fullPayload).toContain("[REDACTED]");
});

test("HTTP 401 throws CliError with exit code 4 and login hint", async () => {
  const c: RunnerCaller = {
    call: async () => ({ status: 401, body: "unauthorized" }),
    fetchJson: async () => ({}),
  };
  const cmd = {
    name: "items", summary: "s",
    call: { endpoint: "get.shifts", params: {} },
    output: { kind: "json" as const },
  };
  try {
    await runCommand(cmd, baseOpts(c));
    throw new Error("expected CliError");
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    const e = err as CliError;
    expect(e.exitCode).toBe(4);
    expect(e.hint).toContain("login");
    expect(e.hint).toContain("auth status");
  }
});

test("HTTP 403 throws CliError with exit code 1 and permission hint", async () => {
  const c: RunnerCaller = {
    call: async () => ({ status: 403, body: "forbidden" }),
    fetchJson: async () => ({}),
  };
  const cmd = {
    name: "items", summary: "s",
    call: { endpoint: "get.shifts", params: {} },
    output: { kind: "json" as const },
  };
  try {
    await runCommand(cmd, baseOpts(c));
    throw new Error("expected CliError");
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    const e = err as CliError;
    expect(e.exitCode).toBe(1);
    expect(e.hint).toMatch(/permission/i);
  }
});

test("HTTP 500 JSON error masks secrets with quote and backslash before spill", async () => {
  const TOKEN = 'va"lue\\tail';
  const body = JSON.stringify({ error: TOKEN, message: "internal error" });
  const c: RunnerCaller = {
    call: async () => ({ status: 500, body }),
    fetchJson: async () => ({}),
    secret: { default: TOKEN },
  };
  const cmd = {
    name: "items", summary: "s",
    call: { endpoint: "get.shifts", params: {} },
    output: { kind: "json" as const },
  };
  try {
    await runCommand(cmd, baseOpts(c));
    throw new Error("expected CliError");
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    const e = err as CliError;
    expect(e.exitCode).toBe(1);
    expect(e.hint).toMatch(/full body:/);
    const spillMatch = e.hint.match(/full body: (.+\.json)/);
    expect(spillMatch).not.toBeNull();
    const spillPath = spillMatch![1];
    const spillText = await Bun.file(spillPath).text();
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain('va\\"lue');
    expect(spillText).not.toContain(TOKEN);
    expect(spillText).not.toContain('va\\"lue');
    expect(spillText).toContain("[REDACTED]");
  }
});

test("HTTP error spills redacted body and mentions spill path in hint", async () => {
  const c: RunnerCaller = {
    call: async () => ({ status: 500, body: "error details here" }),
    fetchJson: async () => ({}),
  };
  const cmd = {
    name: "items", summary: "s",
    call: { endpoint: "get.shifts", params: {} },
    output: { kind: "json" as const },
  };
  try {
    await runCommand(cmd, baseOpts(c));
    throw new Error("expected CliError");
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    const e = err as CliError;
    expect(e.exitCode).toBe(1);
    expect(e.hint).toMatch(/full body:/);
    const spillMatch = e.hint.match(/full body: (.+\.json)/);
    expect(spillMatch).not.toBeNull();
    const spillPath = spillMatch![1];
    expect(await Bun.file(spillPath).text()).toBe("error details here");
    expect(e.message).toContain("HTTP 500");
    expect(e.message).toContain("error details here");
  }
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

test("a bare write previews and never calls the network", async () => {
  let called = false;
  const caller = {
    call: async () => {
      called = true;
      return { status: 201, body: "{}" };
    },
    fetchJson: async () => ({}),
    secret: { "cookie:s": "sekret" },
  };
  const res = await runCommand(WRITE_CMD as never, {
    manifest: FULL_MANIFEST,
    site: "x",
    caller: caller as never,
    flags: { json: true, raw: false },
    now: new Date(),
    commit: false,
    args: { title: "Party", count: "3" },
  } as never);
  expect(called).toBe(false);
  expect(res.kind).toBe("preview");
  expect(res.rendered).toContain('"method": "POST"');
  expect(res.rendered).toContain("[REDACTED]");
  expect(res.rendered).not.toContain("Party");
  expect(res.rendered).not.toContain("sekret");
});

test("coerces an @arg to the shape type and sends on commit", async () => {
  let sentBody: unknown;
  const caller = {
    call: async (_i: string, _p: unknown, body: unknown) => {
      sentBody = body;
      return { status: 201, body: "{}" };
    },
    fetchJson: async () => ({}),
    secret: null,
  };
  process.env.RKT_ALLOW_WRITES = "1";
  const res = await runCommand(WRITE_CMD as never, {
    manifest: FULL_MANIFEST,
    site: "x",
    caller: caller as never,
    flags: { json: true, raw: false },
    now: new Date(),
    commit: true,
    args: { title: "Party", count: "3" },
  } as never);
  expect(res.kind).toBe("sent");
  expect(sentBody).toEqual({ name: "Party", count: 3, pinned: "fixed" });
});

test("a command missing write:true on a write endpoint STILL cannot mutate", async () => {
  let called = false;
  const caller = {
    call: async () => {
      called = true;
      return { status: 201, body: "{}" };
    },
    fetchJson: async () => ({}),
    secret: null,
  };
  const undeclared = { ...WRITE_CMD, write: undefined };
  const res = await runCommand(undeclared as never, {
    manifest: FULL_MANIFEST,
    site: "x",
    caller: caller as never,
    flags: { json: true, raw: false },
    now: new Date(),
    commit: false,
    args: { title: "t", count: "1" },
  } as never);
  expect(called).toBe(false);
  expect(res.kind).toBe("preview");
});

test("an @arg failing its format hint is rejected before the wire", async () => {
  const caller = {
    call: async () => ({ status: 201, body: "{}" }),
    fetchJson: async () => ({}),
    secret: null,
  };
  await expect(
    runCommand(HINTED_CMD as never, {
      manifest: HINTED_MANIFEST,
      site: "x",
      caller: caller as never,
      flags: { json: true, raw: false },
      now: new Date(),
      commit: false,
      args: { starts_at: "not-a-date" },
    } as never),
  ).rejects.toThrow(/starts_at.*iso8601/i);
});

test("commit without the env flag raises the enable-writes error", async () => {
  delete process.env.RKT_ALLOW_WRITES;
  const caller = {
    call: async () => ({ status: 201, body: "{}" }),
    fetchJson: async () => ({}),
    secret: null,
  };
  await expect(
    runCommand(WRITE_CMD as never, {
      manifest: FULL_MANIFEST,
      site: "x",
      caller: caller as never,
      flags: { json: true, raw: false },
      now: new Date(),
      commit: true,
      args: { title: "t", count: "1" },
    } as never),
  ).rejects.toThrow(/RKT_ALLOW_WRITES/);
});
