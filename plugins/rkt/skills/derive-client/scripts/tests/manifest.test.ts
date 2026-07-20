import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { groupEndpoints } from "../src/lib/synthesize";
import { buildManifest, SCHEMA_VERSION, validateManifest } from "../src/lib/manifest";

function entry(url: string, body: string): HarEntry {
  return {
    method: "GET",
    url,
    status: 200,
    requestHeaders: {
      "user-agent": "Mozilla/5.0 Chrome/141.0.0.0",
      "sec-ch-ua": '"Chromium";v="141"',
      "sec-ch-ua-platform": '"macOS"',
    },
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: body,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

const groups = () =>
  groupEndpoints([
    entry("https://example.test/api/roster/4821", '{"shifts":[{"id":1}]}'),
    entry("https://example.test/api/roster/9002", '{"shifts":[{"id":2}]}'),
  ]);

test("builds a manifest with the pinned schema version", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc123",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.schemaVersion).toBe(SCHEMA_VERSION);
  expect(m.site).toBe("example");
  expect(m.harSha256).toBe("abc123");
});

test("pins the recorded user agent and client hints", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc123",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.userAgent).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(m.clientHints["sec-ch-ua"]).toBe('"Chromium";v="141"');
});

test("emits auth as null, to be filled by the auth pass", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.auth).toBeNull();
});

test("derives stable endpoint ids from method and template", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.endpoints[0].id).toBe("get.api.roster.id");
  expect(m.endpoints[0].pathTemplate).toBe("/api/roster/{id}");
  expect(m.endpoints[0].source).toBe("xhr");
  expect(m.endpoints[0].fragile).toBe(false);
});

test("marks HTML-sourced endpoints as fragile scrapes", () => {
  const htmlEntry: HarEntry = { ...entry("https://example.test/roster", "<html></html>"), mimeType: "text/html" };
  const m = buildManifest({
    site: "example",
    groups: groupEndpoints([htmlEntry]),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.endpoints[0].source).toBe("scrape");
  expect(m.endpoints[0].fragile).toBe(true);
});

test("validateManifest accepts a manifest it just built", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(validateManifest(JSON.parse(JSON.stringify(m)))).toEqual(m);
});

test("validateManifest rejects an unknown schema version", () => {
  expect(() => validateManifest({ schemaVersion: 99, site: "x", endpoints: [] })).toThrow(
    /schema version/i,
  );
});

test("validateManifest rejects a manifest with no endpoints array", () => {
  expect(() => validateManifest({ schemaVersion: 1, site: "x" })).toThrow(/endpoints/i);
});
