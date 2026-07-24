import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateClient } from "../src/generate";

const EXPECTED_RUNTIME = [
  "paths.ts",
  "manifest-schema.ts",
  "secrets.ts",
  "scheduler.ts",
  "transport.ts",
  "refresh.ts",
  "reauth.ts",
  "session.ts",
  "render.ts",
  "commands-schema.ts",
  "tokens.ts",
  "identity.ts",
  "join.ts",
  "runtime.ts",
  "command-runner.ts",
];

let workRoot: string;
let manifestPath: string;

const MANIFEST = {
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
    {
      id: "get.api.roster.id",
      method: "GET",
      pathTemplate: "/api/roster/{id}",
      params: [{ name: "id", in: "path", type: "number" }],
      responseShape: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "rkt-gen-"));
  const manifestDir = join(workRoot, "recording");
  await mkdir(manifestDir, { recursive: true });
  manifestPath = join(manifestDir, "client.json");
  await writeFile(manifestPath, JSON.stringify(MANIFEST));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

test("scaffolds the repo with a gitignore covering secrets and recordings", async () => {
  const out = join(workRoot, "clients-a");
  await generateClient(manifestPath, out);
  const gitignore = await readFile(join(out, ".gitignore"), "utf8");
  expect(gitignore).toContain("secrets/");
  expect(gitignore).toContain("recordings/");
  expect(gitignore).toContain("node_modules/");
  expect(gitignore).toContain("*.storage-state.json");
});

test("copies the shared runtime into lib/", async () => {
  const out = join(workRoot, "clients-b");
  await generateClient(manifestPath, out);
  for (const f of EXPECTED_RUNTIME) {
    const src = await readFile(join(out, "lib", f), "utf8");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/GENERATED|copied/i);
  }
  await expect(readFile(join(out, "lib", "ratelimit.ts"), "utf8")).rejects.toThrow();
});

test("writes the site directory with client.json, types.ts and cli.ts", async () => {
  const out = join(workRoot, "clients-c");
  const { siteDir } = await generateClient(manifestPath, out);
  expect(siteDir).toBe(join(out, "example"));
  expect(JSON.parse(await readFile(join(siteDir, "client.json"), "utf8")).site).toBe("example");
  expect(await readFile(join(siteDir, "types.ts"), "utf8")).toContain("ApiRosterResponse");
  expect(await readFile(join(siteDir, "cli.ts"), "utf8")).toContain('"api-roster"');
});

test("is idempotent: a second run produces identical bytes", async () => {
  const out = join(workRoot, "clients-d");
  await generateClient(manifestPath, out);
  const first = await readFile(join(out, "example", "cli.ts"), "utf8");
  await generateClient(manifestPath, out);
  const second = await readFile(join(out, "example", "cli.ts"), "utf8");
  expect(second).toBe(first);
});

test("every runtime file in the copied set is present", async () => {
  const out = join(workRoot, "clients-e");
  const { written } = await generateClient(manifestPath, out);
  for (const f of EXPECTED_RUNTIME) {
    expect(written.some((p) => p.endsWith(join("lib", f)))).toBe(true);
  }
  // manifest.ts pulls in the derivation pipeline; it must NOT be copied.
  expect(written.some((p) => p.endsWith(join("lib", "manifest.ts")))).toBe(false);
  expect(written.some((p) => p.endsWith(join("lib", "ratelimit.ts")))).toBe(false);
});

test("a generated client answers auth status without a commands.json", async () => {
  const out = join(workRoot, "clients-lifecycle");
  await generateClient(manifestPath, out);
  const proc = Bun.spawn(["bun", join(out, "example", "cli.ts"), "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(text).toMatch(/Access token/);
  expect(text).toMatch(/Refresh window\s+unknown/);
});

test("refuses a manifest with an unsupported schema version", async () => {
  const bad = join(workRoot, "bad.json");
  await writeFile(bad, JSON.stringify({ ...MANIFEST, schemaVersion: 99 }));
  await expect(generateClient(bad, join(workRoot, "clients-f"))).rejects.toThrow(/schema version/i);
});

test("refuses a manifest whose site contains path separators", async () => {
  const bad = join(workRoot, "bad-site.json");
  await writeFile(bad, JSON.stringify({ ...MANIFEST, site: "../escape" }));
  await expect(generateClient(bad, join(workRoot, "clients-g"))).rejects.toThrow(/path segment/i);
});

test("emits a task CLI from commands.json and never overwrites it", async () => {
  const out = join(workRoot, "clients-cmds");
  await generateClient(manifestPath, out); // creates site dir "example"
  const cmdsPath = join(out, "example", "commands.json");
  const commands = {
    schemaVersion: 1,
    site: "example",
    commands: [
      {
        name: "roster",
        summary: "the roster",
        call: { endpoint: "get.api.roster.id", params: { id: "1" } },
        output: { kind: "json" },
        redact: [],
      },
    ],
  };
  await writeFile(cmdsPath, JSON.stringify(commands) + "\n");
  await generateClient(manifestPath, out);
  const cli = await readFile(join(out, "example", "cli.ts"), "utf8");
  expect(cli).toContain('"roster"'); // task name, not the endpoint-per-command name
  // commands.json is byte-for-byte preserved
  expect(await readFile(cmdsPath, "utf8")).toBe(JSON.stringify(commands) + "\n");
});

test("refuses a malformed commands.json rather than falling back", async () => {
  const out = join(workRoot, "clients-badcmds");
  await generateClient(manifestPath, out);
  await writeFile(join(out, "example", "commands.json"), "{ not json");
  await expect(generateClient(manifestPath, out)).rejects.toThrow();
});

test("refuses commands.json whose site does not match the manifest", async () => {
  const out = join(workRoot, "clients-site-mismatch");
  await generateClient(manifestPath, out);
  const commands = {
    schemaVersion: 1,
    site: "other-site",
    commands: [
      {
        name: "roster",
        summary: "the roster",
        call: { endpoint: "get.api.roster.id", params: { id: "1" } },
        output: { kind: "json" },
        redact: [],
      },
    ],
  };
  await writeFile(join(out, "example", "commands.json"), JSON.stringify(commands));
  await expect(generateClient(manifestPath, out)).rejects.toThrow(
    /commands\.json site "other-site" does not match manifest site "example"/,
  );
});

test("stops CLI emission and refreshes client.json when a command references a dead endpoint", async () => {
  const out = join(workRoot, "clients-drift");
  await generateClient(manifestPath, out);
  const commands = {
    schemaVersion: 1,
    site: "example",
    commands: [
      {
        name: "gone",
        summary: "",
        call: { endpoint: "get.nope", params: {} },
        output: { kind: "json" },
        redact: [],
      },
    ],
  };
  await writeFile(join(out, "example", "commands.json"), JSON.stringify(commands));
  await expect(generateClient(manifestPath, out)).rejects.toThrow(/get\.nope|no longer in client\.json/i);
  // client.json still refreshed
  expect(JSON.parse(await readFile(join(out, "example", "client.json"), "utf8")).site).toBe("example");
});

test("generated client typechecks with tsc --noEmit", async () => {
  const out = join(workRoot, "clients-tsc");
  await generateClient(manifestPath, out);

  const install = Bun.spawn(["bun", "install"], { cwd: out, stdout: "pipe", stderr: "pipe" });
  expect(await install.exited).toBe(0);

  const tsc = Bun.spawn(["bunx", "tsc", "--noEmit"], { cwd: out, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(tsc.stderr).text();
  expect(await tsc.exited).toBe(0);
  if (stderr) expect(stderr).not.toMatch(/error TS/i);
});

test("emits an executable install.sh and an executable cli.ts", async () => {
  const out = await mkdtemp(join(tmpdir(), "rkt-gen-"));
  const mPath = join(out, "client.json");
  await writeFile(mPath, JSON.stringify(MANIFEST));
  const { siteDir } = await generateClient(mPath, out);

  const installSh = join(siteDir, "install.sh");
  const cliTs = join(siteDir, "cli.ts");
  const shMode = (await stat(installSh)).mode & 0o111;
  const cliMode = (await stat(cliTs)).mode & 0o111;
  expect(shMode).not.toBe(0);
  expect(cliMode).not.toBe(0);

  const shBody = await readFile(installSh, "utf8");
  expect(shBody).toContain("bun install");
  expect(shBody).toContain('exec bun "$DIR/cli.ts" install');
  expect(shBody).not.toContain(MANIFEST.site); // stays site-agnostic
});

test("emits an executable, site-agnostic regenerate.sh that finds the plugin and regenerates this client", async () => {
  const out = await mkdtemp(join(tmpdir(), "rkt-gen-"));
  const mPath = join(out, "client.json");
  await writeFile(mPath, JSON.stringify(MANIFEST));
  const { siteDir } = await generateClient(mPath, out);

  const regenSh = join(siteDir, "regenerate.sh");
  expect((await stat(regenSh)).mode & 0o111).not.toBe(0); // executable

  const body = await readFile(regenSh, "utf8");
  expect(body).toContain("src/generate.ts"); // runs the generator
  expect(body).toContain('--manifest "$DIR/client.json"'); // this client's manifest
  expect(body).toContain("RKT_PLUGIN_ROOT"); // env override honored
  expect(body).toContain("plugins/cache"); // globs the newest installed plugin
  expect(body).not.toContain(MANIFEST.site); // stays site-agnostic
});

test("full mode with no commands.json warns that derived writes are hidden, instead of dropping them silently", async () => {
  const out = await mkdtemp(join(tmpdir(), "rkt-gen-"));
  const mPath = join(out, "client.json");
  const fullManifest = {
    ...MANIFEST,
    site: "example-full",
    mode: "full",
    endpoints: [
      ...MANIFEST.endpoints,
      {
        id: "post.api.roster",
        method: "POST",
        pathTemplate: "/api/roster",
        params: [],
        responseShape: { type: "object", properties: {}, required: [] },
        source: "xhr",
        fragile: false,
        selectors: null,
        writeSemantics: { bodyShape: null, bodyHints: {}, contentType: null },
      },
    ],
  };
  await writeFile(mPath, JSON.stringify(fullManifest));

  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await generateClient(mPath, out);
  } finally {
    console.error = originalError;
  }
  expect(lines.some((l) => /1 write endpoint/i.test(l) && /commands\.json/i.test(l))).toBe(true);
});

test("full mode with a commands.json present stays silent about hidden writes", async () => {
  const out = await mkdtemp(join(tmpdir(), "rkt-gen-"));
  const mPath = join(out, "client.json");
  const fullManifest = {
    ...MANIFEST,
    site: "example-full-curated",
    mode: "full",
    endpoints: [
      ...MANIFEST.endpoints,
      {
        id: "post.api.roster",
        method: "POST",
        pathTemplate: "/api/roster",
        params: [],
        responseShape: { type: "object", properties: {}, required: [] },
        source: "xhr",
        fragile: false,
        selectors: null,
        writeSemantics: { bodyShape: null, bodyHints: {}, contentType: null },
      },
    ],
  };
  await writeFile(mPath, JSON.stringify(fullManifest));
  await mkdir(join(out, "example-full-curated"), { recursive: true });
  await writeFile(
    join(out, "example-full-curated", "commands.json"),
    JSON.stringify({
      schemaVersion: 1,
      site: "example-full-curated",
      commands: [
        {
          name: "roster-create",
          summary: "",
          write: true,
          call: { endpoint: "post.api.roster", params: {} },
          output: { kind: "json" },
          redact: [],
        },
      ],
    }),
  );

  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await generateClient(mPath, out);
  } finally {
    console.error = originalError;
  }
  expect(lines.some((l) => /write endpoint/i.test(l) && /commands\.json/i.test(l))).toBe(false);
});
