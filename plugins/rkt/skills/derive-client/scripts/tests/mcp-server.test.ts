import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RunnerCaller } from "../src/lib/command-runner";
import { authAwareMessage, buildServer } from "../src/lib/mcp-server";
import { CliError, MAX_BYTES, MAX_ROWS } from "../src/lib/overflow";
import { outDir } from "../src/lib/paths";
import { createScheduler } from "../src/lib/scheduler";
import { REFRESH_TOKEN_KEY } from "../src/lib/secrets";
import type { RefreshedTokens } from "../src/lib/refresh";

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
  await mkdir(dir, { recursive: true });
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

test("a tool name beginning with _ is rejected", async () => {
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
  await expect(buildServer(dir, STUBS)).rejects.toThrow(/_secret|valid MCP tool name/i);
});

test("an exposed param beginning with _ is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-mcp-"));
  await mkdir(dir, { recursive: true });
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

let spillRoot: string;
const ORIG_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIG_NODE_ENV = process.env.NODE_ENV;

beforeEach(async () => {
  spillRoot = await mkdtemp(join(tmpdir(), "rkt-mcp-spill-"));
  process.env.RKT_CLIENTS_ROOT = spillRoot;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
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
  return {
    readSecrets: async () => ({
      authorization: "Bearer old",
      [REFRESH_TOKEN_KEY]: "r1",
      "cookie:s": "x",
    }),
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
    ...overrides,
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
  await mkdir(dir, { recursive: true });
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
  expect(out.rows.length).toBeGreaterThan(1);
  expect(Buffer.byteLength(JSON.stringify({ rows: out.rows }, null, 2))).toBeLessThanOrEqual(
    MAX_BYTES,
  );
  expect(out.truncated).toBe(true);
  expect(out.notice).toMatch(/row/i);
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

test("concurrent tool calls never run two credential writes at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const dir = await fixtureRenewableClient();
  const { server } = await buildServer(
    dir,
    renewalDeps({
      writeSecret: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    }),
  );
  await concurrentToolCallsOnServer(server, "events", {}, 2);
  expect(maxInFlight).toBe(1);
});

test("credential write critical sections do not overlap under contention", async () => {
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
  expect(events).toEqual(["enter A", "exit A", "enter B", "exit B"]);
});

test("a rejected credential write does not wedge the serializer chain", async () => {
  let writeCount = 0;
  const outcomes: Array<"ok" | "err"> = [];
  const dir = await fixtureRenewableClient();
  const { server } = await buildServer(
    dir,
    renewalDeps({
      writeSecret: async () => {
        const idx = writeCount++;
        if (idx === 1) throw new Error("simulated write failure");
      },
    }),
  );
  const client = new Client({ name: "t", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  const p1 = client.callTool({ name: "events", arguments: {} }).then(
    (res) => outcomes.push(res.isError ? "err" : "ok"),
    () => outcomes.push("err"),
  );
  const p2 = client.callTool({ name: "events", arguments: {} }).then(
    (res) => outcomes.push(res.isError ? "err" : "ok"),
    () => outcomes.push("err"),
  );
  const p3 = client.callTool({ name: "events", arguments: {} }).then(
    (res) => outcomes.push(res.isError ? "err" : "ok"),
    () => outcomes.push("err"),
  );
  await Promise.all([p1, p2, p3]);
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

test("separate servers do not share a write serializer", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const dir = await fixtureRenewableClient();
  const writeSecret = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 50));
    inFlight--;
  };
  const deps = renewalDeps({ writeSecret });
  const [{ server: serverA }, { server: serverB }] = await Promise.all([
    buildServer(dir, deps),
    buildServer(dir, deps),
  ]);
  const clientA = new Client({ name: "a", version: "1.0" });
  const clientB = new Client({ name: "b", version: "1.0" });
  const [ctA, stA] = InMemoryTransport.createLinkedPair();
  const [ctB, stB] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    clientA.connect(ctA),
    serverA.connect(stA),
    clientB.connect(ctB),
    serverB.connect(stB),
  ]);
  await Promise.all([
    clientA.callTool({ name: "events", arguments: {} }),
    clientB.callTool({ name: "events", arguments: {} }),
  ]);
  await clientA.close();
  await clientB.close();
  expect(maxInFlight).toBe(2);
});
