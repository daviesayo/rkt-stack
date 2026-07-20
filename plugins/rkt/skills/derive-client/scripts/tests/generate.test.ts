import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateClient } from "../src/generate";

let workRoot: string;
let manifestPath: string;

const MANIFEST = {
  schemaVersion: 1,
  site: "example",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "deadbeef",
  userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
  clientHints: {},
  auth: { kind: "cookie", location: "cookie:sessionid", mintedBy: null, expiry: null },
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
});

test("copies the shared runtime into lib/", async () => {
  const out = join(workRoot, "clients-b");
  await generateClient(manifestPath, out);
  for (const f of ["paths.ts", "manifest-schema.ts", "secrets.ts", "ratelimit.ts", "transport.ts"]) {
    const src = await readFile(join(out, "lib", f), "utf8");
    expect(src.length).toBeGreaterThan(0);
    expect(src).toMatch(/GENERATED|copied/i);
  }
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
  for (const f of ["paths.ts", "manifest-schema.ts", "secrets.ts", "ratelimit.ts", "transport.ts"]) {
    expect(written.some((p) => p.endsWith(join("lib", f)))).toBe(true);
  }
  // manifest.ts pulls in the derivation pipeline; it must NOT be copied.
  expect(written.some((p) => p.endsWith(join("lib", "manifest.ts")))).toBe(false);
});

test("refuses a manifest with an unsupported schema version", async () => {
  const bad = join(workRoot, "bad.json");
  await writeFile(bad, JSON.stringify({ ...MANIFEST, schemaVersion: 99 }));
  await expect(generateClient(bad, join(workRoot, "clients-f"))).rejects.toThrow(/schema version/i);
});
