import { expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/lib/mcp-server";

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
