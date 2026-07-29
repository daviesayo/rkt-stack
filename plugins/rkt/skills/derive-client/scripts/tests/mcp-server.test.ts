import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RunnerCaller } from "../src/lib/command-runner";
import { RESERVED_ARGS } from "../src/lib/mcp-params";
import { authAwareMessage, buildServer, stripHostPaths } from "../src/lib/mcp-server";
import { CliError, MAX_BYTES, MAX_ROWS } from "../src/lib/overflow";
import { outDir } from "../src/lib/paths";
import { createScheduler } from "../src/lib/scheduler";
import { REFRESH_TOKEN_KEY } from "../src/lib/secrets";
import type { RefreshedTokens } from "../src/lib/refresh";
import { installIdentityWriteMock, restoreIdentityWriteMock } from "./identity-write-mock";

const MANIFEST = {
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
  endpoints: [
    {
      id: "get.api.events",
      method: "GET",
      pathTemplate: "/api/events",
      params: [{ name: "q", in: "query", type: "string" }],
      responseShape: { type: "unknown" as const },
      source: "xhr" as const,
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

const trackedTempDirs: string[] = [];

afterAll(async () => {
  for (const dir of trackedTempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Writes a temp client dir and returns its path. */
async function fixtureClient(
  opts: {
    withIdentity?: boolean;
    commands?: unknown[];
    withWriteEndpoint?: boolean;
    manifest?: unknown;
  } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rkt-mcp-"));
  trackedTempDirs.push(dir);
  const endpoints: unknown[] = [...MANIFEST.endpoints];
  if (opts.withWriteEndpoint) {
    endpoints.push({
      ...MANIFEST.endpoints[0],
      id: "post.api.events",
      method: "POST",
      writeSemantics: { bodyShape: null, bodyHints: {}, contentType: "application/json" },
    });
  }
  const manifest =
    opts.manifest ??
    ({
      ...MANIFEST,
      endpoints,
      mode: opts.withWriteEndpoint ? "full" : undefined,
    } as typeof MANIFEST & { mode?: string });
  await writeFile(join(dir, "client.json"), JSON.stringify(manifest));
  await writeFile(
    join(dir, "commands.json"),
    JSON.stringify({
      schemaVersion: 1,
      site: "x",
      ...(opts.withIdentity
        ? { identity: { endpoint: "get.api.events", idField: "id", display: ["name"] } }
        : {}),
      commands: opts.commands ?? [
        {
          name: "events",
          summary: "list events",
          call: { endpoint: "get.api.events", params: {} },
          output: { kind: "table", rows: "data.items", columns: ["id"] },
          redact: [],
        },
      ],
    }),
  );
  return dir;
}

const STUBS = { runTool: async () => "{}", runWhoamiTool: async () => "me" };

async function toolsOf(dir: string) {
  const { server } = await buildServer(dir, STUBS);
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.server.connect(st)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

test("registers one tool per read command plus whoami", async () => {
  const names = (await toolsOf(await fixtureClient({ withIdentity: true })))
    .map((t) => t.name)
    .sort();
  expect(names).toEqual(["events", "whoami"]);
});

test("omits whoami when the client has no identity block", async () => {
  const names = (await toolsOf(await fixtureClient())).map((t) => t.name);
  expect(names).not.toContain("whoami");
});

test("every tool is annotated read-only", async () => {
  for (const t of await toolsOf(await fixtureClient({ withIdentity: true }))) {
    expect(t.annotations?.readOnlyHint).toBe(true);
  }
});

test("a POST command missing write:true fails startup loudly", async () => {
  const dir = await fixtureClient({
    withWriteEndpoint: true,
    commands: [
      {
        name: "create",
        summary: "",
        call: { endpoint: "post.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  await expect(buildServer(dir, STUBS)).rejects.toThrow(/write/i);
});

test("write commands are skipped and counted", async () => {
  const dir = await fixtureClient({
    withIdentity: true,
    withWriteEndpoint: true,
    commands: [
      {
        name: "events",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "table", rows: "data.items", columns: ["id"] },
        redact: [],
      },
      {
        name: "create",
        summary: "",
        write: true,
        call: { endpoint: "post.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  const { skippedWrites } = await buildServer(dir, STUBS);
  expect(skippedWrites).toBe(1);
});

test("a curated command named whoami is rejected", async () => {
  const dir = await fixtureClient({
    withIdentity: true,
    commands: [
      {
        name: "whoami",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  await expect(buildServer(dir, STUBS)).rejects.toThrow(/whoami/);
});

test("an @arg hole with no ParamSpec is rejected at startup, not per call", async () => {
  const dir = await fixtureClient({
    commands: [
      {
        name: "events",
        summary: "",
        call: { endpoint: "get.api.events", params: { nope: "@arg:nope" } },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  await expect(buildServer(dir, STUBS)).rejects.toThrow(/nope/);
});

test("the skipped-write count reaches the client over the protocol", async () => {
  const dir = await fixtureClient({
    withWriteEndpoint: true,
    commands: [
      {
        name: "events",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "table", rows: "data.items", columns: ["id"] },
        redact: [],
      },
      {
        name: "create",
        summary: "",
        write: true,
        call: { endpoint: "post.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  const { server } = await buildServer(dir, STUBS);
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.server.connect(st)]);
  expect(client.getInstructions() ?? "").toMatch(/1 write/i);
  await client.close();
});

test("duplicate tool names fail startup instead of last-one-wins", async () => {
  const dir = await fixtureClient({
    commands: [
      {
        name: "events",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
      {
        name: "events",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  await expect(buildServer(dir, STUBS)).rejects.toThrow(/collides/i);
});

test("a tool name beginning with _ is rejected as reserved by this server", async () => {
  const dir = await fixtureClient({
    commands: [
      {
        name: "_secret",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  await expect(buildServer(dir, STUBS)).rejects.toThrow(/_secret.*reserved.*_/i);
});

test("an exposed param beginning with _ is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-mcp-"));
  trackedTempDirs.push(dir);
  await writeFile(
    join(dir, "client.json"),
    JSON.stringify({
      ...MANIFEST,
      endpoints: [
        {
          ...MANIFEST.endpoints[0],
          params: [{ name: "_secret", in: "query", type: "string" }],
        },
      ],
    }),
  );
  await writeFile(
    join(dir, "commands.json"),
    JSON.stringify({
      schemaVersion: 1,
      site: "x",
      commands: [
        {
          name: "events",
          summary: "",
          call: { endpoint: "get.api.events", params: { _secret: "@arg:query" } },
          output: { kind: "json" },
          redact: [],
        },
      ],
    }),
  );
  await expect(buildServer(dir, STUBS)).rejects.toThrow(/reserved.*_/i);
});

test("malformed client.json is rejected by validateManifest", async () => {
  const dir = await fixtureClient({
    manifest: { schemaVersion: 99, site: "x", endpoints: [] },
  });
  await expect(buildServer(dir, STUBS)).rejects.toThrow(/schemaVersion|schema version/i);
});

test("events tool inputSchema exposes q, _limit, and _offset over the protocol", async () => {
  const dir = await fixtureClient({
    commands: [
      {
        name: "events",
        summary: "list events",
        call: { endpoint: "get.api.events", params: { q: "@arg:q" } },
        output: { kind: "table", rows: "data.items", columns: ["id"] },
        redact: [],
      },
    ],
  });
  const events = (await toolsOf(dir)).find((t) => t.name === "events");
  expect(events).toBeDefined();
  const props =
    (events!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  expect(Object.keys(props).sort()).toEqual(["_limit", "_offset", "q"]);
  // The paging keys are DERIVED from RESERVED_ARGS, not written as literals, so
  // the published schema and the names realRunTool destructures cannot drift.
  for (const name of RESERVED_ARGS) expect(Object.keys(props)).toContain(name);
});

test("callTool round-trips injected runTool output over the protocol", async () => {
  const sentinel = "mcp-handler-round-trip";
  const dir = await fixtureClient();
  const { server } = await buildServer(dir, {
    runTool: async () => sentinel,
    runWhoamiTool: async () => "me",
  });
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.server.connect(st)]);
  const result = await client.callTool({ name: "events", arguments: {} });
  expect(result.content).toEqual([{ type: "text", text: sentinel }]);
  await client.close();
});

describe("MCP tool runtime with spill-root isolation", () => {
let spillRoot: string;
const ORIG_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIG_NODE_ENV = process.env.NODE_ENV;

beforeEach(async () => {
  restoreIdentityWriteMock();
  spillRoot = await realpath(await mkdtemp(join(tmpdir(), "rkt-mcp-spill-")));
  process.env.RKT_CLIENTS_ROOT = spillRoot;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  restoreIdentityWriteMock();
  if (ORIG_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIG_ROOT;
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
  await rm(spillRoot, { recursive: true, force: true });
});

function rowsCaller(rows: unknown[]): RunnerCaller {
  return {
    call: async () => ({ status: 200, body: JSON.stringify({ data: { items: rows } }) }),
    fetchJson: async () => ({}),
    secret: null,
  };
}

async function spillFileCount(site: string): Promise<number> {
  try {
    const files = await readdir(outDir(site));
    return files.filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function callTool(
  dir: string,
  name: string,
  args: Record<string, unknown>,
  deps: Parameters<typeof buildServer>[1] = {},
) {
  const { server } = await buildServer(dir, deps);
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.server.connect(st)]);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  const text = (res.content as { text: string }[])[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

async function callToolText(
  dir: string,
  name: string,
  args: Record<string, unknown>,
  deps: Parameters<typeof buildServer>[1] = {},
): Promise<string> {
  const { server } = await buildServer(dir, deps);
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.server.connect(st)]);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  const text = (res.content as { text: string }[])[0].text;
  if (res.isError) throw new Error(text);
  return text;
}

async function callToolError(
  dir: string,
  name: string,
  args: Record<string, unknown>,
  deps: Parameters<typeof buildServer>[1] = {},
): Promise<string> {
  let msg: string | undefined;
  try {
    await callTool(dir, name, args, deps);
  } catch (e) {
    msg = (e as Error).message;
  }
  if (msg === undefined) throw new Error("expected tool call to fail");
  return msg;
}

async function callToolOnServer(
  server: Awaited<ReturnType<typeof buildServer>>["server"],
  name: string,
  args: Record<string, unknown>,
) {
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  return JSON.parse((res.content as { text: string }[])[0].text);
}

async function fixtureRenewableClient(): Promise<string> {
  return fixtureClient({
    manifest: {
      ...MANIFEST,
      refresh: {
        kind: "oidc",
        tokenEndpoint: "https://idp.test/token",
        clientId: "c",
        accessTokenCookie: "s",
        expiresIn: 300,
        refreshExpiresIn: 3600,
      },
      authBundle: {
        credentials: [{ kind: "bearer", location: "authorization" }],
      },
    },
  });
}

function authHeader(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get("authorization") ?? undefined;
  const rec = headers as Record<string, string>;
  return rec.authorization ?? rec.Authorization;
}

function renewalDeps(
  overrides: Parameters<typeof buildServer>[1] = {},
): Parameters<typeof buildServer>[1] {
  let bundle: Record<string, string> = {
    authorization: "Bearer old",
    [REFRESH_TOKEN_KEY]: "r1",
    "cookie:s": "x",
  };
  const baseWriteSecret = async (_site: string, values: string | Record<string, string>) => {
    bundle = typeof values === "string" ? { default: values } : { ...values };
  };
  const { writeSecret: overrideWrite, readSecrets: overrideRead, ...rest } = overrides;
  return {
    readSecrets: overrideRead ?? (async () => ({ ...bundle })),
    schedulerFetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (authHeader(init) === "Bearer old") {
        return new Response("{}", { status: 401 });
      }
      return new Response(JSON.stringify({ data: { items: [{ id: 1 }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as never,
    refreshViaOidc: async () =>
      ({ accessToken: "new", refreshToken: "r2", expiresIn: null }) satisfies RefreshedTokens,
    writeSecret: overrideWrite
      ? async (site: string, values: string | Record<string, string>) => {
          await overrideWrite(site, values);
          bundle = typeof values === "string" ? { default: values } : { ...values };
        }
      : baseWriteSecret,
    ...rest,
  };
}

async function concurrentToolCallsOnServer(
  server: Awaited<ReturnType<typeof buildServer>>["server"],
  name: string,
  args: Record<string, unknown>,
  count: number,
) {
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  const promises = Array.from({ length: count }, () => client.callTool({ name, arguments: args }));
  const results = await Promise.all(promises);
  await client.close();
  return results;
}

test("a tool call returns shaped rows as JSON", async () => {
  const out = await callTool(await fixtureClient(), "events", {}, {
    caller: rowsCaller([{ id: 1 }, { id: 2 }, { id: 3 }]),
  });
  expect(out.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  expect(out.truncated).toBe(false);
});

test("_limit and _offset page the rows and report truncation", async () => {
  const out = await callTool(
    await fixtureClient(),
    "events",
    { _limit: 1, _offset: 1 },
    { caller: rowsCaller([{ id: 1 }, { id: 2 }, { id: 3 }]) },
  );
  expect(out.rows).toEqual([{ id: 2 }]);
  expect(out.truncated).toBe(true);
  expect(out.notice).toMatch(/_offset/);
});

test("an out-of-range _offset returns an empty page WITH the notice", async () => {
  const out = await callTool(await fixtureClient(), "events", { _offset: 999 }, {
    caller: rowsCaller([{ id: 1 }]),
  });
  expect(out.rows).toEqual([]);
  expect(out.notice).toMatch(/1 row/);
});

test("a json-kind command returns the raw body, not an empty rows array", async () => {
  const dir = await fixtureClient({
    commands: [
      {
        name: "raw",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  const out = await callTool(dir, "raw", {}, { caller: rowsCaller([{ id: 1 }]) });
  expect(out).toHaveProperty("data.items");
  expect(out.rows).toBeUndefined();
});

test("an agent-supplied @me is sent as a literal, not resolved", async () => {
  let seen: Record<string, string> = {};
  const caller: RunnerCaller = {
    call: async (_id, params) => {
      seen = params;
      return { status: 200, body: JSON.stringify({ data: { items: [] } }) };
    },
    fetchJson: async () => ({}),
    secret: null,
  };
  const dir = await fixtureClient({
    commands: [
      {
        name: "events",
        summary: "",
        call: { endpoint: "get.api.events", params: { q: "default" } },
        output: { kind: "table", rows: "data.items", columns: ["id"] },
        redact: [],
      },
    ],
  });
  await callTool(dir, "events", { q: "@me" }, { caller });
  expect(seen.q).toBe("@me");
  expect(seen.q).not.toMatch(/^usr-/);
});

test("an agent-supplied @today is sent as a literal, not resolved", async () => {
  let seen: Record<string, string> = {};
  const caller: RunnerCaller = {
    call: async (_id, params) => {
      seen = params;
      return { status: 200, body: JSON.stringify({ data: { items: [] } }) };
    },
    fetchJson: async () => ({}),
    secret: null,
  };
  const dir = await fixtureClient({
    commands: [
      {
        name: "events",
        summary: "",
        call: { endpoint: "get.api.events", params: { q: "default" } },
        output: { kind: "table", rows: "data.items", columns: ["id"] },
        redact: [],
      },
    ],
  });
  await callTool(dir, "events", { q: "@today" }, { caller });
  expect(seen.q).toBe("@today");
  expect(seen.q).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
});

test("a numeric MCP argument is coerced before escaping", async () => {
  let seen: Record<string, string> = {};
  const caller: RunnerCaller = {
    call: async (_id, params) => {
      seen = params;
      return { status: 200, body: JSON.stringify({ data: { items: [] } }) };
    },
    fetchJson: async () => ({}),
    secret: null,
  };
  const dir = await mkdtemp(join(tmpdir(), "rkt-mcp-num-"));
  trackedTempDirs.push(dir);
  await writeFile(
    join(dir, "client.json"),
    JSON.stringify({
      ...MANIFEST,
      endpoints: [
        {
          ...MANIFEST.endpoints[0],
          params: [
            { name: "q", in: "query", type: "string" },
            { name: "count", in: "query", type: "number" },
          ],
        },
      ],
    }),
  );
  await writeFile(
    join(dir, "commands.json"),
    JSON.stringify({
      schemaVersion: 1,
      site: "x",
      commands: [
        {
          name: "events",
          summary: "",
          call: { endpoint: "get.api.events", params: { count: "@arg:count" } },
          output: { kind: "table", rows: "data.items", columns: ["id"] },
          redact: [],
        },
      ],
    }),
  );
  await callTool(dir, "events", { count: 10 }, { caller });
  expect(seen.count).toBe("10");
});

test("a 4xx neither launches a browser, writes a spill, nor leaks a host path", async () => {
  let reauthCalls = 0;
  const before = await spillFileCount("x");
  const caller: RunnerCaller = {
    call: async () => ({ status: 403, body: "{}" }),
    fetchJson: async () => ({}),
    secret: null,
  };
  const out = await callToolError(await fixtureClient(), "events", {}, {
    caller,
    onReauth: () => reauthCalls++,
  });
  expect(reauthCalls).toBe(0);
  expect(String(out)).not.toMatch(/\.rkt-clients|\/tmp|\/Users/);
  expect(await spillFileCount("x")).toBe(before);
});

test("a 5xx neither writes a spill nor leaks a host path", async () => {
  const before = await spillFileCount("x");
  const caller: RunnerCaller = {
    call: async () => ({ status: 500, body: JSON.stringify({ error: "boom" }) }),
    fetchJson: async () => ({}),
    secret: null,
  };
  const out = await callToolError(await fixtureClient(), "events", {}, { caller });
  expect(String(out)).not.toMatch(/\.rkt-clients|\/tmp|\/Users|full body:/i);
  expect(await spillFileCount("x")).toBe(before);
});

test("a 401 auth failure does not invoke browser re-auth", async () => {
  let reauthCalls = 0;
  const scheduler = createScheduler({
    minDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: (async () => new Response("{}", { status: 401 })) as never,
    sleepImpl: async () => {},
  });
  const dir = await fixtureClient();
  const msg = await callToolError(dir, "events", {}, {
    scheduler,
    readSecrets: async () => null,
    onReauth: () => reauthCalls++,
  });
  expect(reauthCalls).toBe(0);
  expect(msg).toMatch(/expired|login/i);
});

test("secrets are re-read on every call", async () => {
  let reads = 0;
  const dir = await fixtureClient();
  const deps = {
    caller: rowsCaller([]),
    readSecrets: async () => {
      reads++;
      return null;
    },
  };
  await callTool(dir, "events", {}, deps);
  await callTool(dir, "events", {}, deps);
  expect(reads).toBe(2);
});

test("row cap truncates when more than MAX_ROWS are available", async () => {
  const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ id: i }));
  const out = await callTool(await fixtureClient(), "events", {}, { caller: rowsCaller(rows) });
  expect(out.rows.length).toBeLessThanOrEqual(MAX_ROWS);
  expect(out.truncated).toBe(true);
  expect(out.notice).toMatch(/row/i);
});

test("byte cap shrinks a page that fits the row cap but exceeds MAX_BYTES", async () => {
  const pad = "x".repeat(2000);
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: i, pad }));
  const out = await callTool(await fixtureClient(), "events", {}, { caller: rowsCaller(rows) });
  expect(out.rows.length).toBeLessThan(80);
  expect(out.rows.length).toBeGreaterThan(10);
  expect(Buffer.byteLength(JSON.stringify({ rows: out.rows }, null, 2))).toBeLessThanOrEqual(
    MAX_BYTES,
  );
  expect(out.truncated).toBe(true);
  expect(out.notice).toMatch(/row/i);
});

test("a single oversized row is capped with truncated true", async () => {
  const row = { id: 1, pad: "x".repeat(MAX_BYTES) };
  const out = await callTool(await fixtureClient(), "events", {}, { caller: rowsCaller([row]) });
  expect(out.rows).toHaveLength(1);
  expect(out.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_BYTES);
});

test("a single oversized row whose bulk is NOT a string is still capped", async () => {
  // The field-shrinking pass only shortens strings. A large array or nested
  // object holds the envelope over the cap unless it is handled separately.
  const row = { id: 1, blob: Array.from({ length: MAX_BYTES }, (_, i) => i) };
  const out = await callTool(await fixtureClient(), "events", {}, { caller: rowsCaller([row]) });
  expect(out.rows).toHaveLength(1);
  expect(out.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_BYTES);
});

test("stripHostPaths preserves URL path segments", () => {
  expect(stripHostPaths("failed at https://x.test/var/x")).toBe("failed at https://x.test/var/x");
});

test("stripHostPaths strips a /var temp path that is not under rktRoot", () => {
  // macOS temp dirs live under /var/folders. A path from outside rktRoot (a
  // stack trace, an OS temp file) must not survive just because the exact-root
  // pass missed it.
  expect(stripHostPaths("wrote /var/folders/ab/cd/T/leak.json")).toBe("wrote [path]");
});

test("stripHostPaths removes paths under a custom RKT_CLIENTS_ROOT", () => {
  const custom = "/opt/rkt-custom-root/secrets/x.json";
  process.env.RKT_CLIENTS_ROOT = "/opt/rkt-custom-root";
  process.env.NODE_ENV = "test";
  expect(stripHostPaths(`read failed: ${custom}`)).toBe("read failed: [path]/secrets/x.json");
});

test("tool errors redact embedded secrets", async () => {
  const TOKEN = "super-secret-token-value";
  const caller: RunnerCaller = {
    call: async () => ({ status: 500, body: JSON.stringify({ error: TOKEN }) }),
    fetchJson: async () => ({}),
    secret: { authorization: `Bearer ${TOKEN}` },
  };
  const msg = await callToolError(await fixtureClient(), "events", {}, { caller });
  expect(msg).not.toContain(TOKEN);
  expect(msg).toContain("[REDACTED]");
});

test("readSecrets throw surfaces as a curated tool error", async () => {
  const msg = await callToolError(await fixtureClient(), "events", {}, {
    readSecrets: async () => {
      throw new Error("simulated secrets read failure");
    },
  });
  expect(msg).toMatch(/simulated secrets read failure/i);
});

test("the paging reserved-arg guard runs for json-only curations", async () => {
  let guardRan = false;
  const dir = await fixtureClient({
    commands: [
      {
        name: "stats",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  await buildServer(dir, {
    ...STUBS,
    onReservedPagingCheck: () => {
      guardRan = true;
    },
  });
  expect(guardRan).toBe(true);
});

test("the paging reserved-arg guard runs when every command is skipped as write", async () => {
  let guardRan = false;
  const dir = await fixtureClient({
    withWriteEndpoint: true,
    commands: [
      {
        name: "create",
        summary: "",
        write: true,
        call: { endpoint: "post.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  await buildServer(dir, {
    ...STUBS,
    onReservedPagingCheck: () => {
      guardRan = true;
    },
  });
  expect(guardRan).toBe(true);
});

test("a missing endpoint reference fails with a curated message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-mcp-missing-ep-"));
  trackedTempDirs.push(dir);
  await writeFile(join(dir, "client.json"), JSON.stringify(MANIFEST));
  await writeFile(
    join(dir, "commands.json"),
    JSON.stringify({
      schemaVersion: 1,
      site: "x",
      commands: [
        {
          name: "events",
          summary: "",
          call: { endpoint: "get.api.missing", params: {} },
          output: { kind: "json" },
          redact: [],
        },
      ],
    }),
  );
  await expect(buildServer(dir, STUBS)).rejects.toThrow(
    /references endpoint 'get\.api\.missing', which is not in client\.json/i,
  );
});

test("reuses one scheduler with cache disabled across tool calls", async () => {
  let createSchedulerCalls = 0;
  let fetches = 0;
  const dir = await fixtureClient();
  const { server } = await buildServer(dir, {
    readSecrets: async () => null,
    onCreateScheduler: () => createSchedulerCalls++,
    schedulerFetchImpl: (async () => {
      fetches++;
      return new Response(JSON.stringify({ data: { items: [{ id: 1 }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as never,
  });
  await callToolOnServer(server, "events", {});
  await callToolOnServer(server, "events", {});
  expect(fetches).toBe(2);
  expect(createSchedulerCalls).toBe(1);
});

test("a 401 with stored credentials consults the disabled browser stub", async () => {
  let reauthCalls = 0;
  const scheduler = createScheduler({
    minDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: (async () => new Response("{}", { status: 401 })) as never,
    sleepImpl: async () => {},
  });
  const dir = await fixtureClient();
  const msg = await callToolError(dir, "events", {}, {
    scheduler,
    readSecrets: async () => ({ "cookie:s": "x" }),
    onReauth: () => reauthCalls++,
  });
  expect(reauthCalls).toBe(1);
  expect(msg).toMatch(/expired|login/i);
});

test("a json-kind response exceeding MAX_BYTES is capped with a notice", async () => {
  const bigPayload = { data: { blob: "x".repeat(MAX_BYTES) } };
  const dir = await fixtureClient({
    commands: [
      {
        name: "raw",
        summary: "",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  const caller: RunnerCaller = {
    call: async () => ({ status: 200, body: JSON.stringify(bigPayload) }),
    fetchJson: async () => ({}),
    secret: null,
  };
  const text = await callToolText(dir, "raw", {}, { caller });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_BYTES);
  expect(text).toMatch(/truncat/i);
});

test("whoami maps a 401 to login remediation", async () => {
  const scheduler = createScheduler({
    minDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: (async () => new Response("{}", { status: 401 })) as never,
    sleepImpl: async () => {},
  });
  const dir = await fixtureClient({ withIdentity: true });
  const msg = await callToolError(dir, "whoami", {}, {
    scheduler,
    readSecrets: async () => ({ "cookie:s": "x" }),
  });
  expect(msg).toMatch(/expired|login/i);
  expect(msg).not.toMatch(/^HTTP 401/i);
});

test("whoami strips host paths from filesystem errors", async () => {
  await writeFile(join(spillRoot, "secrets"), "not-a-directory");
  const scheduler = createScheduler({
    minDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ id: "u1", name: "Ada" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as never,
    sleepImpl: async () => {},
  });
  const dir = await fixtureClient({ withIdentity: true });
  const msg = await callToolError(dir, "whoami", {}, {
    scheduler,
    readSecrets: async () => null,
  });
  expect(msg).not.toMatch(/expired|login/i);
  expect(msg).not.toContain(spillRoot);
});

test("authAwareMessage maps exhausted credentials to a login remediation", () => {
  const err = new CliError("HTTP 401 from get.api.events\n{}", "run: login  (then check: auth status)", 4);
  expect(authAwareMessage(err, "x")).toBe(
    "the stored session for x has expired. Run 'x login' on the host machine; the next call picks up the new credential.",
  );
});

test("authAwareMessage strips host paths from other errors", () => {
  const err = new CliError(
    "HTTP 403 from get.api.events\n{}",
    "try: login. full body: /Users/me/.rkt-clients/out/x/spill.json",
    1,
  );
  const msg = authAwareMessage(err, "x");
  expect(msg).not.toMatch(/\/Users|\.rkt-clients/);
  expect(msg).toMatch(/403/);
});

test("single-flight collapses concurrent same-site renewals to one credential write", async () => {
  const events: string[] = [];
  let writeIndex = 0;
  const dir = await fixtureRenewableClient();
  const { server } = await buildServer(
    dir,
    renewalDeps({
      writeSecret: async () => {
        const label = String.fromCharCode(65 + writeIndex++);
        events.push(`enter ${label}`);
        await new Promise((r) => setTimeout(r, 50));
        events.push(`exit ${label}`);
      },
    }),
  );
  await concurrentToolCallsOnServer(server, "events", {}, 2);
  expect(events).toEqual(["enter A", "exit A"]);
});

test("a rejected credential write does not wedge the serializer chain", async () => {
  let writeCount = 0;
  const outcomes: Array<"ok" | "err"> = [];
  const stale: Record<string, string> = {
    authorization: "Bearer old",
    [REFRESH_TOKEN_KEY]: "r1",
    "cookie:s": "x",
  };
  let bundle: Record<string, string> = { ...stale };
  const dir = await fixtureRenewableClient();
  const { server } = await buildServer(
    dir,
    renewalDeps({
      readSecrets: async () => ({ ...bundle }),
      writeSecret: async (_site: string, values: string | Record<string, string>) => {
        const idx = writeCount++;
        if (idx === 1) throw new Error("simulated write failure");
        bundle = typeof values === "string" ? { default: values } : { ...values };
      },
    }),
  );
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  for (let i = 0; i < 3; i++) {
    bundle = { ...stale };
    await client
      .callTool({ name: "events", arguments: {} })
      .then(
        (res) => outcomes.push(res.isError ? "err" : "ok"),
        () => outcomes.push("err"),
      );
  }
  await client.close();
  expect(writeCount).toBe(3);
  expect(outcomes.filter((o) => o === "ok").length).toBe(2);
  expect(outcomes.filter((o) => o === "err").length).toBe(1);
});

test("two tool calls on one server share one write serializer", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const dir = await fixtureRenewableClient();
  const { server } = await buildServer(
    dir,
    renewalDeps({
      writeSecret: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      },
    }),
  );
  await concurrentToolCallsOnServer(server, "events", {}, 2);
  expect(maxInFlight).toBe(1);
});

test("table-kind tools expose _limit and _offset; json-kind tools do not", async () => {
  const dir = await fixtureClient({
    commands: [
      {
        name: "events",
        summary: "list events",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "table", rows: "data.items", columns: ["id"] },
        redact: [],
      },
      {
        name: "stats",
        summary: "site stats",
        call: { endpoint: "get.api.events", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  });
  const tools = await toolsOf(dir);
  const events = tools.find((t) => t.name === "events");
  const stats = tools.find((t) => t.name === "stats");
  expect(events).toBeDefined();
  expect(stats).toBeDefined();
  const eventProps =
    (events!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const statsProps =
    (stats!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  expect(Object.keys(eventProps).sort()).toEqual(["_limit", "_offset"]);
  expect(Object.keys(statsProps)).toEqual([]);
});

test("concurrent tool calls on one server single-flight renew: one refresh, one write", async () => {
  let refreshCalls = 0;
  let writeCalls = 0;
  const dir = await fixtureRenewableClient();
  const { server } = await buildServer(
    dir,
    renewalDeps({
      refreshViaOidc: async () => {
        refreshCalls++;
        await new Promise((r) => setTimeout(r, 50));
        return { accessToken: "new", refreshToken: "r2", expiresIn: null };
      },
      writeSecret: async () => {
        writeCalls++;
      },
    }),
  );
  const results = await concurrentToolCallsOnServer(server, "events", {}, 2);
  expect(results.every((r) => !r.isError)).toBe(true);
  expect(refreshCalls).toBe(1);
  expect(writeCalls).toBe(1);
});

test("a rejected renewal on one server does not wedge later renewals", async () => {
  let refreshCalls = 0;
  const outcomes: Array<"ok" | "err"> = [];
  const dir = await fixtureRenewableClient();
  const { server } = await buildServer(
    dir,
    renewalDeps({
      refreshViaOidc: async () => {
        refreshCalls++;
        if (refreshCalls === 1) throw new Error("simulated refresh failure");
        return { accessToken: "new", refreshToken: "r2", expiresIn: null };
      },
    }),
  );
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  const p1 = client.callTool({ name: "events", arguments: {} }).then(
    () => outcomes.push("err"),
    () => outcomes.push("err"),
  );
  await p1;
  const p2 = client.callTool({ name: "events", arguments: {} }).then(
    (res) => outcomes.push(res.isError ? "err" : "ok"),
    () => outcomes.push("err"),
  );
  await p2;
  await client.close();
  expect(refreshCalls).toBe(2);
  expect(outcomes).toEqual(["err", "ok"]);
});

test("concurrent tool calls on one server never run two identity cache writes at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const tracker = installIdentityWriteMock({
    delayMs: 50,
    forceCacheMiss: true,
    onWriteEnter: () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
    },
    onWriteExit: () => {
      inFlight--;
    },
  });
  const scheduler = createScheduler({
    minDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ id: "u1", name: "Ada" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as never,
    sleepImpl: async () => {},
  });
  const dir = await fixtureClient({ withIdentity: true });
  const { server } = await buildServer(dir, {
    scheduler,
    readSecrets: async () => ({ "cookie:s": "x" }),
  });
  await concurrentToolCallsOnServer(server, "whoami", {}, 2);
  expect(tracker.writeCallCount).toBe(2);
  expect(maxInFlight).toBe(1);
});
});
