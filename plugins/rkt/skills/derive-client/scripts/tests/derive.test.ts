import { expect, test } from "bun:test";
import { deriveManifest } from "../src/derive";

test("derives a manifest end to end from the fixture HAR", async () => {
  const { manifest, dropped } = await deriveManifest(
    `${import.meta.dir}/fixtures/sample.har`,
    "example",
  );

  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.site).toBe("example");
  expect(manifest.baseUrl).toBe("https://example.test");

  // The .js asset is filtered out; only the roster API survives.
  expect(manifest.endpoints).toHaveLength(1);
  expect(manifest.endpoints[0].method).toBe("GET");
  expect(manifest.endpoints[0].pathTemplate).toBe("/api/v2/roster/4821");
  expect(dropped.some((d) => d.url.endsWith("app.js"))).toBe(true);
});

test("pins the user agent observed in the recording", async () => {
  const { manifest } = await deriveManifest(`${import.meta.dir}/fixtures/sample.har`, "example");
  expect(manifest.userAgent).toBe("Mozilla/5.0 Chrome/141.0.0.0");
});

test("computes a content hash of the HAR", async () => {
  const { manifest } = await deriveManifest(`${import.meta.dir}/fixtures/sample.har`, "example");
  expect(manifest.harSha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the derived manifest passes its own validator", async () => {
  const { manifest } = await deriveManifest(`${import.meta.dir}/fixtures/sample.har`, "example");
  const { validateManifest } = await import("../src/lib/manifest");
  expect(() => validateManifest(JSON.parse(JSON.stringify(manifest)))).not.toThrow();
});

test("a HAR with no data traffic yields zero endpoints, not a crash", async () => {
  const { manifest } = await deriveManifest(
    `${import.meta.dir}/fixtures/assets-only.har`,
    "example",
  );
  expect(manifest.endpoints).toHaveLength(0);
});
