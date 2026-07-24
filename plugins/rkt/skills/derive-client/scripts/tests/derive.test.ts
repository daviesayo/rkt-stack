import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveManifest, parseMode } from "../src/derive";
import { recordingDir } from "../src/lib/paths";

let testRoot: string;
const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;
let stagingCounter = 0;

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "rkt-derive-"));
  process.env.RKT_CLIENTS_ROOT = testRoot;
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  await rm(testRoot, { recursive: true, force: true });
});

async function stageFixture(name: string): Promise<string> {
  const ts = `test${++stagingCounter}`;
  const dir = recordingDir("derive-test", ts);
  await mkdir(dir, { recursive: true });
  const dest = `${dir}/session.har`;
  await copyFile(`${import.meta.dir}/fixtures/${name}`, dest);
  return dest;
}

test("derives a manifest end to end from the fixture HAR", async () => {
  const har = await stageFixture("sample.har");
  const { manifest, dropped } = await deriveManifest(har, "example");

  expect(manifest.schemaVersion).toBe(3);
  expect(manifest.site).toBe("example");
  expect(manifest.baseUrl).toBe("https://example.test");

  // The .js asset is filtered out; only the roster API survives.
  expect(manifest.endpoints).toHaveLength(1);
  expect(manifest.endpoints[0].method).toBe("GET");
  expect(manifest.endpoints[0].pathTemplate).toBe("/api/v2/items/4821");
  expect(dropped.some((d) => d.url.endsWith("app.js"))).toBe(true);
});

test("pins the user agent observed in the recording", async () => {
  const har = await stageFixture("sample.har");
  const { manifest } = await deriveManifest(har, "example");
  expect(manifest.userAgent).toBe("Mozilla/5.0 Chrome/141.0.0.0");
});

test("computes a content hash of the HAR", async () => {
  const har = await stageFixture("sample.har");
  const { manifest } = await deriveManifest(har, "example");
  expect(manifest.harSha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the derived manifest passes its own validator", async () => {
  const har = await stageFixture("sample.har");
  const { manifest } = await deriveManifest(har, "example");
  const { validateManifest } = await import("../src/lib/manifest");
  expect(() => validateManifest(JSON.parse(JSON.stringify(manifest)))).not.toThrow();
});

test("a HAR with no data traffic yields zero endpoints, not a crash", async () => {
  const har = await stageFixture("assets-only.har");
  const { manifest } = await deriveManifest(har, "example");
  expect(manifest.endpoints).toHaveLength(0);
});

test("rejects a HAR outside ~/.rkt-clients", async () => {
  await expect(
    deriveManifest(`${import.meta.dir}/fixtures/sample.har`, "example"),
  ).rejects.toThrow(/must be under/);
});

test("derives auth and returns the secret separately from the manifest", async () => {
  const har = await stageFixture("authed.har");
  const { manifest, secrets } = await deriveManifest(har, "authtest");

  expect(manifest.auth).toMatchObject({ kind: "cookie", location: "cookie:sessionid" });
  expect(Object.values(secrets)).toContain("SUPERSECRETVALUE");
  expect(JSON.stringify(manifest)).not.toContain("SUPERSECRETVALUE");
});

test("auth analysis sees the login response even though the filter drops it", async () => {
  const har = await stageFixture("authed.har");
  const { manifest } = await deriveManifest(har, "authtest");
  // POST /login is dropped from endpoints but must still be traced as the mint point.
  expect(manifest.auth?.mintedBy).toBe("https://auth.test/login");
  expect(manifest.endpoints.every((e) => e.method === "GET")).toBe(true);
});

test("the recorded DELETE never becomes an endpoint in read mode", async () => {
  const har = await stageFixture("authed.har");
  const { manifest, dropped } = await deriveManifest(har, "authtest");
  expect(manifest.endpoints.some((e) => e.method === "DELETE")).toBe(false);
  expect(dropped.some((d) => /write method/i.test(d.reason))).toBe(true);
});

test("parseMode accepts read and full, defaulting to read when --mode is omitted", () => {
  expect(parseMode(undefined)).toBe("read");
  expect(parseMode("read")).toBe("read");
  expect(parseMode("full")).toBe("full");
});

test("parseMode rejects an unrecognized --mode value instead of silently deriving read-only", () => {
  expect(() => parseMode("ful")).toThrow(/--mode/);
  expect(() => parseMode("FULL")).toThrow(/--mode/);
  expect(() => parseMode("")).toThrow(/--mode/);
});
