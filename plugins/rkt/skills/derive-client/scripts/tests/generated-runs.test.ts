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

let workRoot: string;
let outRoot: string;

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
  workRoot = await mkdtemp(join(tmpdir(), "rkt-runs-"));
  const dir = join(workRoot, "recording");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "client.json"), JSON.stringify(MANIFEST));
  outRoot = join(workRoot, "clients");
  await generateClient(join(dir, "client.json"), outRoot);
});

afterAll(async () => {
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
  const proc = Bun.spawn(
    ["bun", join(outRoot, "runs", "cli.ts"), "api-roster", "--id", "4821", "--dry-run"],
    { stderr: "pipe", stdout: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const preview = JSON.parse(stdout);
  expect(preview.url).toBe("https://x.test/api/roster/4821");
  expect(preview.method).toBe("GET");
  expect(preview.headers["user-agent"]).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(preview.headers["sec-ch-ua"]).toBe('"Chromium";v="141"');
});

test("an unknown command exits non-zero and lists the valid ones", async () => {
  const proc = Bun.spawn(["bun", join(outRoot, "runs", "cli.ts"), "nope"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code).not.toBe(0);
  expect(stderr).toContain("unknown command: nope");
  expect(stderr).toContain("api-roster");
});

test("a generated task CLI runs commands, joins, redacts, and answers whoami", async () => {
  const port = await getFreePort();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/me") return Response.json({ id: 5, first_name: "Ada", email: "ada@x.test" });
      if (url.pathname === "/shifts")
        return Response.json([
          { date: "d1", client_id: 9, address: "1 St" },
          { date: "d2", client_id: 9, address: "2 Ave" },
        ]);
      if (url.pathname.startsWith("/clients/")) return Response.json({ name: "Acme", secret: "x" });
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  const root = await mkdtemp(join(tmpdir(), "rkt-task-"));
  // Every spawned CLI inherits these so its identity cache / secrets stay in the sandbox.
  const env = { ...process.env, NODE_ENV: "test", RKT_CLIENTS_ROOT: root };
  try {
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
      auth: null,
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
    await generateClient(join(rec, "client.json"), out); // first pass creates the site dir
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
    await generateClient(join(rec, "client.json"), out); // second pass emits the task CLI

    const cli = join(out, "task", "cli.ts");

    const help = Bun.spawn(["bun", cli], { stdout: "pipe", stderr: "pipe", env });
    const helpText = await new Response(help.stderr).text();
    await help.exited;
    expect(helpText).toContain("shifts");
    expect(helpText).toContain("List shifts");
    expect(helpText).toContain("whoami");

    const who = Bun.spawn(["bun", cli, "whoami"], { stdout: "pipe", stderr: "pipe", env });
    const whoText = await new Response(who.stdout).text();
    expect(await who.exited).toBe(0);
    expect(whoText.trim()).toBe("Ada (ada@x.test)");

    const run = Bun.spawn(["bun", cli, "shifts"], { stdout: "pipe", stderr: "pipe", env });
    const runText = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    expect(runText).toContain("Acme"); // joined
    expect(runText).toContain("[REDACTED]"); // address redacted by default
    expect(runText.indexOf("d1")).toBeLessThan(runText.indexOf("d2")); // sorted

    const raw = Bun.spawn(["bun", cli, "shifts", "--raw"], { stdout: "pipe", stderr: "pipe", env });
    const rawText = await new Response(raw.stdout).text();
    await raw.exited;
    expect(rawText).toContain("1 St"); // --raw shows the address
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

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
