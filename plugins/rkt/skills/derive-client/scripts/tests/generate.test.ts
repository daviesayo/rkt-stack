import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await proc.exited;
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
