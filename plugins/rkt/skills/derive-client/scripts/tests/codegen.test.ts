import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { commandNames, emitCli, emitMcp, emitType, emitTypes, typeName } from "../src/lib/codegen";
import type { ClientManifest, ManifestEndpoint } from "../src/lib/manifest";
import type { CommandsFile } from "../src/lib/commands-schema";

function ep(over: Partial<ManifestEndpoint>): ManifestEndpoint {
  return {
    id: "get.api.roster.id",
    method: "GET",
    pathTemplate: "/api/roster/{id}",
    params: [],
    responseShape: { type: "unknown" },
    source: "xhr",
    fragile: false,
    selectors: null,
    writeSemantics: null,
    ...over,
  };
}

test("emits an interface for a flat object", () => {
  const src = emitType(
    {
      type: "object",
      properties: { id: { type: "number" }, name: { type: "string" } },
      required: ["id", "name"],
    },
    "Roster",
  );
  expect(src).toBe(
    "export type Roster = {\n  id: number;\n  name: string;\n};\n",
  );
});

test("marks non-required properties optional", () => {
  const src = emitType(
    {
      type: "object",
      properties: { id: { type: "number" }, note: { type: "string" } },
      required: ["id"],
    },
    "Shift",
  );
  expect(src).toContain("id: number;");
  expect(src).toContain("note?: string;");
});

test("emits arrays of objects", () => {
  const src = emitType(
    {
      type: "object",
      properties: {
        shifts: {
          type: "array",
          items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
        },
      },
      required: ["shifts"],
    },
    "RosterList",
  );
  expect(src).toContain("shifts: Array<{");
  expect(src).toContain("id: number;");
});

test("emits unknown for an unknown shape", () => {
  expect(emitType({ type: "unknown" }, "Opaque")).toBe("export type Opaque = unknown;\n");
});

test("emits an empty-array element type as unknown", () => {
  const src = emitType(
    { type: "object", properties: { rows: { type: "array", items: { type: "unknown" } } }, required: ["rows"] },
    "Rows",
  );
  expect(src).toContain("rows: Array<unknown>;");
});

test("emits null-typed fields as null", () => {
  const src = emitType(
    { type: "object", properties: { endedAt: { type: "null" } }, required: ["endedAt"] },
    "Visit",
  );
  expect(src).toContain("endedAt: null;");
});

test("quotes property names that are not valid identifiers", () => {
  const src = emitType(
    { type: "object", properties: { "content-type": { type: "string" } }, required: ["content-type"] },
    "Headers",
  );
  expect(src).toContain('"content-type": string;');
});

test("a top-level array emits an array type", () => {
  const src = emitType(
    { type: "array", items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
    "Items",
  );
  expect(src.startsWith("export type Items = Array<{")).toBe(true);
});

test("names a GET command from its path, dropping param segments", () => {
  const names = commandNames([ep({})]);
  expect(names.get("get.api.roster.id")).toBe("api-roster");
});

test("includes the method for HEAD endpoints", () => {
  const names = commandNames([
    ep({ id: "head.api.roster.id", method: "HEAD" }),
  ]);
  expect(names.get("head.api.roster.id")).toBe("head-api-roster");
});

test("refuses non-GET/HEAD methods in read mode", () => {
  expect(() =>
    commandNames([ep({ id: "post.api.roster", method: "POST" })]),
  ).toThrow(/GET and HEAD only/i);
});

test("disambiguates colliding names deterministically", () => {
  const names = commandNames([
    ep({ id: "get.api.roster.id", pathTemplate: "/api/roster/{id}" }),
    ep({ id: "get.api.roster.week", pathTemplate: "/api/roster/{week}" }),
  ]);
  expect(names.get("get.api.roster.id")).toBe("api-roster");
  expect(names.get("get.api.roster.week")).toBe("api-roster-2");
});

test("a path of only params falls back to the method", () => {
  const names = commandNames([ep({ id: "get.id", pathTemplate: "/{id}" })]);
  expect(names.get("get.id")).toBe("get");
});

test("typeName converts a command to PascalCase with a Response suffix", () => {
  expect(typeName("api-roster")).toBe("ApiRosterResponse");
  expect(typeName("api-roster-2")).toBe("ApiRoster2Response");
});

const manifest: ClientManifest = {
  schemaVersion: 2,
  site: "example",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "deadbeef",
  userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
  clientHints: {},
  auth: { kind: "cookie", location: "cookie:sessionid", mintedBy: null, expiry: null },
  authBundle: null,
  refresh: null,
  endpoints: [
    ep({
      id: "get.api.roster.id",
      params: [
        { name: "id", in: "path", type: "number", required: true, example: "4821" },
        { name: "week", in: "query", type: "string", required: true, example: "2026-W30" },
      ],
      responseShape: {
        type: "object",
        properties: { shifts: { type: "array", items: { type: "unknown" } } },
        required: ["shifts"],
      },
    }),
  ],
};

test("emitTypes declares one exported type per endpoint", () => {
  const src = emitTypes(manifest);
  expect(src).toContain("export type ApiRosterResponse = {");
  expect(src).toContain("shifts: Array<unknown>;");
});

test("emitTypes marks the file as generated", () => {
  expect(emitTypes(manifest)).toMatch(/generated/i);
});

test("emitCli records the manifest hash it was generated from", () => {
  expect(emitCli(manifest)).toContain("deadbeef");
});

test("emitCli emits a subcommand per endpoint with its params", () => {
  const src = emitCli(manifest);
  expect(src).toContain('"api-roster"');
  expect(src).toContain('"id"');
  expect(src).toContain('"week"');
});

test("emitCli imports the shared runtime from the sibling lib", () => {
  const src = emitCli(manifest);
  expect(src).toContain('from "../lib/transport"');
  expect(src).toContain('from "../lib/secrets"');
});

test("emitCli contains no credential value", () => {
  expect(emitCli(manifest)).not.toContain("sessionid=");
});

test("emitCli throws on a write-method endpoint", () => {
  const bad: ClientManifest = {
    ...manifest,
    endpoints: [ep({ id: "delete.api.shift.id", method: "DELETE" })],
  };
  expect(() => emitCli(bad)).toThrow(/GET and HEAD only/i);
});

test("emitCli emits renewal imports and param metadata in COMMANDS", () => {
  const src = emitCli(manifest);
  expect(src).toContain("readSecrets");
  expect(src).toContain("refreshViaOidc");
  expect(src).toContain("reauthViaProfile");
  expect(src).toContain('"required": true');
  expect(src).toContain('"example": "2026-W30"');
});

const taskManifest = {
  schemaVersion: 2,
  site: "example",
  baseUrl: "https://x.test",
  recordedAt: "",
  harSha256: "",
  userAgent: "UA",
  clientHints: {},
  auth: null,
  authBundle: null,
  refresh: null,
  endpoints: [
    {
      id: "get.me",
      method: "GET",
      pathTemplate: "/me",
      params: [],
      responseShape: { type: "unknown" as const },
      source: "xhr" as const,
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
    {
      id: "get.shifts",
      method: "GET",
      pathTemplate: "/shifts",
      params: [],
      responseShape: { type: "unknown" as const },
      source: "xhr" as const,
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};
const taskCommands = {
  schemaVersion: 1,
  site: "example",
  identity: { endpoint: "get.me", idField: "id", display: ["first_name", "email"] },
  commands: [
    {
      name: "shifts",
      summary: "List shifts",
      call: { endpoint: "get.shifts", params: {} },
      output: { kind: "table" as const, columns: ["date"] },
      redact: [],
    },
  ],
};

test("emitCli with commands emits a task CLI that delegates to the runtime", () => {
  const src = emitCli(taskManifest as never, taskCommands as never);
  expect(src).toContain('"name": "shifts"');
  expect(src).toContain("List shifts");
  expect(src).toContain("runCommand");
  expect(src).toContain("createCaller");
  expect(src).toContain('"../lib/command-runner"');
  expect(src).toContain("whoami");
});

test("emitCli with an identity-less commands file omits whoami", () => {
  const src = emitCli(taskManifest as never, { ...taskCommands, identity: undefined } as never);
  expect(src).toContain("runCommand");
  expect(src).not.toMatch(/name === "whoami"/);
});

test("emitCli without commands keeps the endpoint-per-command CLI", () => {
  const src = emitCli(taskManifest as never);
  expect(src).toContain("COMMANDS");
  expect(src).not.toContain("runCommand");
});

function manifestWith(endpoints: ManifestEndpoint[]): ClientManifest {
  return {
    schemaVersion: 2,
    site: "example",
    baseUrl: "https://x.test",
    recordedAt: "2026-07-20T12:00:00.000Z",
    harSha256: "deadbeef",
    userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
    clientHints: {},
    auth: null,
    authBundle: null,
    refresh: null,
    endpoints,
  } as ClientManifest;
}

test("emitted CLI starts with a bun shebang so a symlink can execute it", () => {
  const src = emitCli(manifestWith([ep({})]));
  expect(src.startsWith("#!/usr/bin/env bun\n")).toBe(true);
});

test("the types file is not executable and carries no shebang", () => {
  const src = emitTypes(manifestWith([ep({})]));
  expect(src.startsWith("#!")).toBe(false);
});

test("endpoint CLI help lists the session lifecycle commands including install/uninstall", () => {
  const src = emitCli(manifestWith([ep({})]));
  expect(src).toContain('console.error("session:")');
  expect(src).toContain("login");
  expect(src).toContain("install [--name <x>]");
  expect(src).toContain("uninstall");
});

test("task CLI help lists install and uninstall in its session block", () => {
  const commands: CommandsFile = {
    schemaVersion: 1,
    site: "example",
    commands: [
      {
        name: "roster",
        summary: "List roster entries",
        call: { endpoint: "get.api.roster.id", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  };
  const src = emitCli(manifestWith([ep({})]), commands);
  expect(src).toContain("install [--name <x>]");
  expect(src).toContain("uninstall");
});

test("endpoint CLI treats help/--help/-h as an explicit help request that exits 0", () => {
  const src = emitCli(manifestWith([ep({})]));
  expect(src).toContain("function usage(exitCode = 1)");
  expect(src).toContain('commandName === "help"');
  expect(src).toContain("usage(0)");
});

test("task CLI treats help/--help/-h as an explicit help request that exits 0", () => {
  const commands: CommandsFile = {
    schemaVersion: 1,
    site: "example",
    commands: [
      {
        name: "roster",
        summary: "List roster entries",
        call: { endpoint: "get.api.roster.id", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  };
  const src = emitCli(manifestWith([ep({})]), commands);
  expect(src).toContain("function usage(exitCode = 1)");
  expect(src).toContain('name === "help"');
  expect(src).toContain("usage(0)");
});

test("task CLI emits fail(), footer wiring, per-command help, and --full", () => {
  const src = emitCli(taskManifest as never, taskCommands as never);
  expect(src).toContain("function fail(");
  expect(src).toContain("commandHelp(");
  expect(src).toContain("--full");
  expect(src).toContain("footer(");
  expect(src).toContain("finishRun(");
  expect(src).toContain("suggest(");
  expect(src).toContain("--help for params and an example");
});

test("task CLI resolves commands and --help before the credential gate", () => {
  const authManifest = {
    ...taskManifest,
    auth: { kind: "cookie", location: "cookie:session", mintedBy: null, expiry: null },
  };
  const src = emitCli(authManifest as never, taskCommands as never);
  const helpIdx = src.indexOf('hasFlag("help")');
  const credIdx = src.indexOf("no stored credential");
  expect(helpIdx).toBeGreaterThan(-1);
  expect(credIdx).toBeGreaterThan(-1);
  expect(helpIdx).toBeLessThan(credIdx);
});

test("endpoint CLI emits reduced-tier navigation", () => {
  const src = emitCli(manifest);
  expect(src).toContain("function fail(");
  expect(src).toContain("function endpointHelp(");
  expect(src).toContain("footer(");
  expect(src).toContain("writeSpill(");
  expect(src).not.toContain("--full");
  expect(src).toContain("missing required param");
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
            pinned: { type: "string" },
          },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    },
  ],
};

const COMMANDS_WITH_WRITE: CommandsFile = {
  schemaVersion: 1,
  site: "x",
  commands: [
    {
      name: "event-create",
      summary: "",
      write: true,
      call: {
        endpoint: "post.api.events",
        body: { name: "@arg:title", count: "@arg:count", pinned: "fixed" },
      },
      output: { kind: "json" },
      redact: ["body.name"],
    },
  ],
};

test("full mode no longer throws on a write endpoint", () => {
  expect(() => emitCli(FULL_MANIFEST, COMMANDS_WITH_WRITE)).not.toThrow();
});

test("read mode still refuses a write endpoint", () => {
  expect(() => emitCli({ ...FULL_MANIFEST, mode: undefined }, undefined)).toThrow(/GET and HEAD only/i);
});

test("the uncurated fallback never emits a write command", () => {
  const cli = emitCli(FULL_MANIFEST, undefined);
  expect(cli).not.toContain("post.api.events");
});

test("a curated write command emits --commit and its @arg flags", () => {
  const cli = emitCli(FULL_MANIFEST, COMMANDS_WITH_WRITE);
  expect(cli).toContain("--commit");
  expect(cli).toContain("--title");
});

test("the generated main gates the command list on writesEnabled", () => {
  const cli = emitCli(FULL_MANIFEST, COMMANDS_WITH_WRITE);
  expect(cli).toContain("writesEnabled");
});

test("flagValue refuses to bind the next token when it is another flag", () => {
  const cli = emitCli(FULL_MANIFEST, COMMANDS_WITH_WRITE);
  expect(cli).toMatch(/next\.startsWith\(["'`]--["'`]\)/);
});

const ARRAY_BODY_MANIFEST: ClientManifest = {
  ...FULL_MANIFEST,
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
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          },
          required: ["items"],
        },
        bodyHints: { "items.0.title": "event title" },
        contentType: "application/json",
      },
    },
  ],
};

const COMMANDS_WITH_ARRAY_BODY: CommandsFile = {
  schemaVersion: 1,
  site: "x",
  commands: [
    {
      name: "event-create",
      summary: "Create an event",
      write: true,
      call: {
        endpoint: "post.api.events",
        body: { items: [{ title: "@arg:title" }] },
      },
      output: { kind: "json" },
      redact: [],
    },
  ],
};

test("a curated write with an array body hole emits --title in ARG_HELP", () => {
  const cli = emitCli(ARRAY_BODY_MANIFEST, COMMANDS_WITH_ARRAY_BODY);
  expect(cli).toContain('"event-create":["  --title <event title>"]');
});

const DUP_ARG_MANIFEST: ClientManifest = {
  ...FULL_MANIFEST,
  endpoints: [
    {
      id: "post.api.dup",
      method: "POST",
      pathTemplate: "/api/dup",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    },
  ],
};

const COMMANDS_WITH_DUP_ARG: CommandsFile = {
  schemaVersion: 1,
  site: "x",
  commands: [
    {
      name: "dup-create",
      summary: "",
      write: true,
      call: { endpoint: "post.api.dup", body: { a: "@arg:x", b: "@arg:x" } },
      output: { kind: "json" },
      redact: [],
    },
  ],
};

test("an @arg reused at two body paths prints one --flag, not two", () => {
  const cli = emitCli(DUP_ARG_MANIFEST, COMMANDS_WITH_DUP_ARG);
  const matches = cli.match(/--x </g) ?? [];
  expect(matches.length).toBe(1);
});

const DIVERGENT_MANIFEST: ClientManifest = {
  ...FULL_MANIFEST,
  endpoints: [
    {
      id: "post.items",
      method: "POST",
      pathTemplate: "/items",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: { bodyShape: null, bodyHints: {}, contentType: null },
    },
    {
      id: "get.post.items",
      method: "GET",
      pathTemplate: "/post/items",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

test("emitTypes and the fallback CLI name a collision-prone GET endpoint identically", () => {
  // POST /items and GET /post/items both base-name to "post-items"; the POST
  // wins the base name (it comes first in manifest order over the full
  // endpoint list), so the GET must collide to "post-items-2" everywhere.
  const types = emitTypes(DIVERGENT_MANIFEST);
  const cli = emitCli(DIVERGENT_MANIFEST, undefined);
  expect(types).toContain("export type PostItems2Response");
  expect(cli).toContain('"command": "post-items-2"');
  // Not the un-collided name a read-only-list naming pass would have given it.
  expect(cli).not.toContain('"command": "post-items"');
});

const READ_MANIFEST: ClientManifest = {
  schemaVersion: 3,
  site: "x",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-24T00:00:00.000Z",
  harSha256: "d",
  userAgent: "UA",
  clientHints: {},
  auth: null,
  authBundle: null,
  refresh: null,
  endpoints: [
    {
      id: "get.api.events",
      method: "GET",
      pathTemplate: "/api/events",
      params: [],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (typeof addr !== "object" || addr === null) {
        probe.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const port = addr.port;
      probe.close((err) => (err ? reject(err) : resolvePort(port)));
    });
    probe.on("error", reject);
  });
}

const MCP_FIXTURES: string[] = [];

async function setupMcpFixture(): Promise<{ siteDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "rkt-mcp-emit-"));
  const siteDir = join(root, "x");
  await mkdir(siteDir, { recursive: true });
  await mkdir(join(root, "lib"), { recursive: true });

  const libSrc = join(import.meta.dir, "../src/lib");
  for (const name of ["mcp-server.ts", "mcp-params.ts", "commands-schema.ts", "manifest-schema.ts", "command-runner.ts", "overflow.ts", "runtime.ts", "refresh.ts", "secrets.ts", "scheduler.ts", "transport.ts", "render.ts", "tokens.ts", "identity.ts", "join.ts", "paths.ts", "reauth.ts", "session.ts"]) {
    await cp(join(libSrc, name), join(root, "lib", name));
  }

  await writeFile(join(siteDir, "client.json"), JSON.stringify(READ_MANIFEST));
  await writeFile(
    join(siteDir, "commands.json"),
    JSON.stringify({
      schemaVersion: 1,
      site: "x",
      commands: [
        {
          name: "events",
          summary: "list events",
          call: { endpoint: "get.api.events", params: {} },
          output: { kind: "json" },
          redact: [],
        },
      ],
    }),
  );
  await writeFile(join(siteDir, "mcp.ts"), emitMcp(READ_MANIFEST));
  const scriptsRoot = join(import.meta.dir, "..");
  await symlink(join(scriptsRoot, "node_modules"), join(root, "node_modules"));
  MCP_FIXTURES.push(root);
  return { siteDir, root };
}

afterEach(async () => {
  while (MCP_FIXTURES.length) {
    await rm(MCP_FIXTURES.pop()!, { recursive: true, force: true });
  }
});

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
};

function resolveLibGraph(entryPaths: string[], libRoot: string, seen = new Set<string>()): string[] {
  const out: string[] = [];
  for (const entry of entryPaths) {
    const abs = resolve(entry);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    const src = readFileSync(abs, "utf8");
    for (const m of src.matchAll(/from "\.\.?\/lib\/([^"]+)"/g)) {
      out.push(...resolveLibGraph([join(libRoot, `${m[1]!.replace(/\.js$/, "")}.ts`)], libRoot, seen));
    }
    for (const m of src.matchAll(/from "\.\/([^"]+)"/g)) {
      const rel = m[1]!.replace(/\.js$/, "");
      if (!rel.startsWith(".")) {
        out.push(...resolveLibGraph([join(dirname(abs), `${rel}.ts`)], libRoot, seen));
      }
    }
  }
  return out;
}

test("emitMcp emits stdio by default and a token-gated loopback http mode", () => {
  const src = emitMcp(READ_MANIFEST as never);
  expect(src).toContain("StdioServerTransport");
  expect(src).toContain("RKT_MCP_TOKEN");
  expect(src).toContain("127.0.0.1");
  expect(src).toContain("enableDnsRebindingProtection");
  expect(src).toContain("allowedHosts");
  expect(src).toContain("allowedOrigins");
  expect(src).toContain("timingSafeEqual");
});

test("the emitted entrypoint never writes to stdout (it is the JSON-RPC channel)", () => {
  expect(emitMcp(READ_MANIFEST as never)).not.toMatch(/console\.log/);
});

test("the emitted entrypoint never echoes the token", () => {
  const src = emitMcp(READ_MANIFEST as never);
  for (const line of src.split("\n")) {
    if (/console\./.test(line)) expect(line).not.toMatch(/RKT_MCP_TOKEN|\btoken\b/);
  }
});

test("HTTP mode refuses to start when RKT_MCP_TOKEN is unset", async () => {
  const { siteDir } = await setupMcpFixture();
  const port = await getFreePort();
  const secret = "super-secret-token-value-12345";
  const env: Record<string, string | undefined> = { ...process.env, HOST_SIDE_DECOY: secret };
  delete env.RKT_MCP_TOKEN;
  const proc = Bun.spawn(["bun", join(siteDir, "mcp.ts"), "--http", "--port", String(port)], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/authentication environment variable/i);
  expect(stderr).not.toContain(secret);
  expect(stderr).not.toMatch(/super-secret/);
  expect(stderr).not.toMatch(/\d+\s*characters/);
});

test("HTTP mode starts when RKT_MCP_TOKEN is set", async () => {
  const { siteDir } = await setupMcpFixture();
  const port = await getFreePort();
  const token = "test-mcp-token-set-case";
  const proc = Bun.spawn(["bun", join(siteDir, "mcp.ts"), "--http", "--port", String(port)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RKT_MCP_TOKEN: token },
  });
  await Bun.sleep(500);
  expect(proc.exitCode).toBeNull();
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    headers: {
      authorization: `Bearer ${token}`,
      host: `127.0.0.1:${port}`,
    },
  });
  expect(res.status).not.toBe(401);
  proc.kill();
  await proc.exited;
});

test("emitted HTTP config lists both loopback host strings and matching origins", () => {
  const src = emitMcp(READ_MANIFEST as never);
  expect(src).toMatch(/127\.0\.0\.1:\$\{port\}|127\.0\.0\.1:\`\$\{port\}\`|127\.0\.0\.1:\$\{/);
  expect(src).toMatch(/localhost:\$\{port\}|localhost:\`\$\{port\}\`/);
  expect(src).toMatch(/allowedOrigins/);
  expect(src).toContain("enableDnsRebindingProtection: true");
});

test("DNS rebinding protection rejects an unlisted Host and accepts a listed one", async () => {
  const port = 9876;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowedOrigins = allowedHosts.map((h) => `http://${h}`);
  const badTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts,
    allowedOrigins,
  });
  const bad = await badTransport.handleRequest(
    new Request(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        host: "evil.example:9999",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT_BODY),
    }),
  );
  expect(bad.status).toBe(403);
  await badTransport.close();

  const goodTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts,
    allowedOrigins,
  });
  const good = await goodTransport.handleRequest(
    new Request(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT_BODY),
    }),
  );
  expect(good.status).not.toBe(403);
  await goodTransport.close();
});

test("stdio MCP import graph does not use console.log except session.ts runLifecycle", () => {
  const src = emitMcp(READ_MANIFEST as never);
  expect(src).not.toMatch(/runLifecycle/);
  const libRoot = join(import.meta.dir, "../src/lib");
  const mcpServer = join(libRoot, "mcp-server.ts");
  const graph = resolveLibGraph([mcpServer], libRoot);
  const offenders = graph.filter((file) => /console\.log/.test(readFileSync(file, "utf8")));
  expect(offenders.map((f) => basename(f))).toEqual(["session.ts"]);
});

test("closing an HTTP session reaps the server and transport", async () => {
  const { siteDir } = await setupMcpFixture();
  const port = await getFreePort();
  const token = "reap-session-token";
  const proc = Bun.spawn(["bun", join(siteDir, "mcp.ts"), "--http", "--port", String(port)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RKT_MCP_TOKEN: token },
  });
  await Bun.sleep(500);
  const init = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      host: `127.0.0.1:${port}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(INIT_BODY),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await init.body?.cancel();

  const deleted = await fetch(`http://127.0.0.1:${port}/`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      host: `127.0.0.1:${port}`,
      "mcp-session-id": sessionId!,
      "mcp-protocol-version": "2024-11-05",
    },
  });
  expect(deleted.status).toBe(200);

  const after = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      host: `127.0.0.1:${port}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
      "mcp-protocol-version": "2024-11-05",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 2 }),
  });
  expect(after.status).toBeGreaterThanOrEqual(400);
  proc.kill();
  await proc.exited;
});
