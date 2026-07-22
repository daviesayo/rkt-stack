import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateClient } from "../src/generate";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (typeof addr !== "object" || addr === null) {
        probe.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const port = addr.port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on("error", reject);
  });
}

type CliRun = { exitCode: number; stdout: string; stderr: string };

async function setupTaskCli(shiftsBody: unknown, opts?: { requireAuth?: boolean }) {
  const port = await getFreePort();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/me") return Response.json({ id: 5, first_name: "Ada", email: "ada@x.test" });
      if (url.pathname === "/shifts") return Response.json(shiftsBody);
      if (url.pathname.startsWith("/clients/")) return Response.json({ name: "Acme", secret: "x" });
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const root = await mkdtemp(join(tmpdir(), "rkt-task-"));
  const env = { ...process.env, NODE_ENV: "test", RKT_CLIENTS_ROOT: root };
  const rec = join(root, "recording");
  await mkdir(rec, { recursive: true });
  const manifest = {
    schemaVersion: 2,
    site: "task",
    baseUrl: base,
    recordedAt: "",
    harSha256: "",
    userAgent: "UA",
    clientHints: {},
    auth: opts?.requireAuth
      ? { kind: "cookie", location: "cookie:session", mintedBy: null, expiry: null }
      : null,
    authBundle: null,
    refresh: null,
    endpoints: [
      {
        id: "get.me",
        method: "GET",
        pathTemplate: "/me",
        params: [],
        responseShape: { type: "unknown" },
        source: "xhr",
        fragile: false,
        selectors: null,
        writeSemantics: null,
      },
      {
        id: "get.shifts",
        method: "GET",
        pathTemplate: "/shifts",
        params: [],
        responseShape: { type: "unknown" },
        source: "xhr",
        fragile: false,
        selectors: null,
        writeSemantics: null,
      },
      {
        id: "get.clients.id",
        method: "GET",
        pathTemplate: "/clients/{id}",
        params: [{ name: "id", in: "path", type: "number" }],
        responseShape: { type: "unknown" },
        source: "xhr",
        fragile: false,
        selectors: null,
        writeSemantics: null,
      },
    ],
  };
  await writeFile(join(rec, "client.json"), JSON.stringify(manifest));
  const out = join(root, "clients");
  await generateClient(join(rec, "client.json"), out);
  const commands = {
    schemaVersion: 1,
    site: "task",
    identity: { endpoint: "get.me", idField: "id", display: ["first_name", "email"] },
    commands: [
      {
        name: "shifts",
        summary: "List shifts",
        call: { endpoint: "get.shifts", params: {} },
        join: [{ key: "client_id", endpoint: "get.clients.id", select: ["name"], as: "client", onError: "blank" }],
        output: { kind: "table", columns: ["date", "client.name", "address"], sort: "date" },
        redact: ["address"],
      },
    ],
  };
  await writeFile(join(out, "task", "commands.json"), JSON.stringify(commands));
  await generateClient(join(rec, "client.json"), out);
  const cli = join(out, "task", "cli.ts");
  const runCli = async (args: string[]): Promise<CliRun> => {
    const proc = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode: await proc.exited, stdout, stderr };
  };
  const cleanup = async () => {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  };
  return { server, root, cli, env, runCli, cleanup };
}

const SMALL_SHIFTS = [
  { date: "d1", client_id: 9, address: "1 St" },
  { date: "d2", client_id: 9, address: "2 Ave" },
];
const BIG_SHIFTS = Array.from({ length: 500 }, (_, i) => ({
  date: `d${String(i).padStart(3, "0")}`,
  client_id: 9,
  address: `${i} St`,
}));

let workRoot: string;
let outRoot: string;
let endpointServer: ReturnType<typeof Bun.serve>;
let runEndpointCli: (args: string[]) => Promise<CliRun>;

const MANIFEST = {
  schemaVersion: 2,
  site: "runs",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "deadbeef",
  userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
  clientHints: { "sec-ch-ua": '"Chromium";v="141"' },
  auth: null,
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
  const port = await getFreePort();
  endpointServer = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (/^\/api\/roster\/\d+$/.test(url.pathname)) {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  workRoot = await mkdtemp(join(tmpdir(), "rkt-runs-"));
  const dir = join(workRoot, "recording");
  await mkdir(dir, { recursive: true });
  const manifest = { ...MANIFEST, baseUrl: `http://127.0.0.1:${endpointServer.port}` };
  await writeFile(join(dir, "client.json"), JSON.stringify(manifest));
  outRoot = join(workRoot, "clients");
  await generateClient(join(dir, "client.json"), outRoot);
  runEndpointCli = async (args: string[]): Promise<CliRun> => {
    const env = { ...process.env, NODE_ENV: "test", RKT_CLIENTS_ROOT: workRoot };
    const proc = Bun.spawn(["bun", join(outRoot, "runs", "cli.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode: await proc.exited, stdout, stderr };
  };
});

afterAll(async () => {
  endpointServer.stop(true);
  await rm(workRoot, { recursive: true, force: true });
});

test("the generated CLI lists its commands when run with no arguments", async () => {
  const proc = Bun.spawn(["bun", join(outRoot, "runs", "cli.ts")], { stderr: "pipe", stdout: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  expect(stderr).toContain("api-roster");
  expect(stderr).toContain("/api/roster/{id}");
});

test("--dry-run builds a real request without network access", async () => {
  const { stdout } = await runEndpointCli(["api-roster", "--id", "4821", "--dry-run"]);
  const preview = JSON.parse(stdout);
  expect(preview.url).toMatch(/\/api\/roster\/4821$/);
  expect(preview.method).toBe("GET");
  expect(preview.headers["user-agent"]).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(preview.headers["sec-ch-ua"]).toBe('"Chromium";v="141"');
});

test("an unknown command exits 2 with a help hint", async () => {
  const { exitCode, stderr } = await runEndpointCli(["nope"]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain("unknown command: nope");
  expect(stderr).toContain("run: bun cli.ts help for the command list");
});

test("an unknown command near-miss suggests the closest name", async () => {
  const { exitCode, stderr } = await runEndpointCli(["api-roste"]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain("did you mean api-roster");
});

test("endpoint CLI: missing path param prints help and exits 2", async () => {
  const { exitCode, stderr } = await runEndpointCli(["api-roster"]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain("missing required param");
});

const ROSTER_STUB_BODY = JSON.stringify({ ok: true });

test("endpoint CLI: success stdout is byte-identical and footer reports bytes", async () => {
  const { stdout, stderr } = await runEndpointCli(["api-roster", "--id", "1"]);
  expect(stdout).toBe(ROSTER_STUB_BODY);
  expect(stderr).toMatch(/\[exit:0 \| \d+(\.\d)?s \| \d+ bytes\]/);
});

test("a generated task CLI runs commands, joins, redacts, and answers whoami", async () => {
  const { runCli, cleanup } = await setupTaskCli(SMALL_SHIFTS);
  try {
    const help = await runCli([]);
    expect(help.stderr).toContain("shifts");
    expect(help.stderr).toContain("List shifts");
    expect(help.stderr).toContain("whoami");

    const who = await runCli(["whoami"]);
    expect(who.exitCode).toBe(0);
    expect(who.stdout.trim()).toBe("Ada (ada@x.test)");

    const run = await runCli(["shifts"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Acme");
    expect(run.stdout).toContain("[REDACTED]");
    expect(run.stdout.indexOf("d1")).toBeLessThan(run.stdout.indexOf("d2"));

    const raw = await runCli(["shifts", "--raw"]);
    expect(raw.stdout).toContain("1 St");
  } finally {
    await cleanup();
  }
}, 20000);

test("unknown command suggests nearest and exits 2", async () => {
  const { runCli, cleanup } = await setupTaskCli(SMALL_SHIFTS);
  try {
    const { exitCode, stderr } = await runCli(["shifs"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("did you mean");
    expect(stderr).toMatch(/\[exit:2 \|/);
  } finally {
    await cleanup();
  }
});

test("<command> --help prints params, columns, example", async () => {
  const { runCli, cleanup } = await setupTaskCli(SMALL_SHIFTS);
  try {
    const { exitCode, stdout } = await runCli(["shifts", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("params");
    expect(stdout).toContain("example: bun cli.ts");
  } finally {
    await cleanup();
  }
});

test("task CLI <command> --help works without stored credentials on auth clients", async () => {
  const { runCli, cleanup } = await setupTaskCli(SMALL_SHIFTS, { requireAuth: true });
  try {
    const { exitCode, stdout, stderr } = await runCli(["shifts", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("List shifts");
    expect(stdout).toContain("example: bun cli.ts");
    expect(stderr).not.toContain("no stored credential");
  } finally {
    await cleanup();
  }
});

test("unknown task command exits 2 without credentials on auth clients", async () => {
  const { runCli, cleanup } = await setupTaskCli(SMALL_SHIFTS, { requireAuth: true });
  try {
    const { exitCode, stderr } = await runCli(["shifs"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("did you mean");
    expect(stderr).not.toContain("no stored credential");
  } finally {
    await cleanup();
  }
});

test("success prints footer on stderr, stdout stays pure", async () => {
  const { runCli, cleanup } = await setupTaskCli(SMALL_SHIFTS);
  try {
    const { exitCode, stdout, stderr } = await runCli(["shifts", "--json"]);
    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toMatch(/\[exit:0 \| \d+(\.\d)?s \| \d+ rows\]/);
  } finally {
    await cleanup();
  }
});

test("oversize response caps stdout and spills redacted full payload", async () => {
  const { runCli, cleanup } = await setupTaskCli(BIG_SHIFTS);
  try {
    const { exitCode, stdout, stderr } = await runCli(["shifts"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("full: ");
    const spill = stderr.match(/full: (\S+)\]/)![1];
    const spilled = await Bun.file(spill).text();
    expect(JSON.parse(spilled).length).toBe(500);
    expect(stdout.split("\n").length).toBeLessThanOrEqual(201);
  } finally {
    await cleanup();
  }
});

test("--full disables cap and spill", async () => {
  const { runCli, cleanup } = await setupTaskCli(BIG_SHIFTS);
  try {
    const { stdout, stderr } = await runCli(["shifts", "--full", "--json"]);
    expect(JSON.parse(stdout).length).toBe(500);
    expect(stderr).not.toContain("full: ");
  } finally {
    await cleanup();
  }
});

test("the generated client typechecks on its own", async () => {
  // The emitted tsconfig sets types: ["bun"], so @types/bun must be installed
  // in the generated repo first. Without this the test fails with TS2688 —
  // the same failure the plugin's own wrapper hits on a fresh checkout.
  const install = Bun.spawn(["bun", "install", "--silent"], {
    cwd: outRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const installCode = await install.exited;
  if (installCode !== 0) {
    // Offline or otherwise unable to install: skip rather than report a
    // failure that says nothing about the generated code.
    console.warn("skipping generated-client typecheck: bun install failed");
    return;
  }

  const proc = Bun.spawn(["bunx", "tsc", "--noEmit"], {
    cwd: outRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  // tsc writes diagnostics to stdout, not stderr.
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(stdout).toBe("");
  expect(code).toBe(0);
});
