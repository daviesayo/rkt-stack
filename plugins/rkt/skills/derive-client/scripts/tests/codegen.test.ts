import { expect, test } from "bun:test";
import { commandNames, emitCli, emitType, emitTypes, typeName } from "../src/lib/codegen";
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
