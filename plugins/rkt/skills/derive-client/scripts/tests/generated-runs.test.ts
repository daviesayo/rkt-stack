import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateClient } from "../src/generate";

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
