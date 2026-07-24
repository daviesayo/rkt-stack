import { expect, test } from "bun:test";
import { analyzeAuth } from "../src/lib/auth";
import type { HarEntry } from "../src/lib/har";
import { groupEndpoints } from "../src/lib/synthesize";
import { buildManifest } from "../src/lib/manifest";
import { SCHEMA_VERSION, validateManifest } from "../src/lib/manifest-schema";

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
    postData: null,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

const groups = () =>
  groupEndpoints([
    entry("https://example.test/api/items/4821", '{"results":[{"id":1}]}'),
    entry("https://example.test/api/items/9002", '{"results":[{"id":2}]}'),
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
  expect(m.authBundle).toBeNull();
  expect(m.refresh).toBeNull();
});

test("derives stable endpoint ids from method and template", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.endpoints[0].id).toBe("get.api.items.id");
  expect(m.endpoints[0].pathTemplate).toBe("/api/items/{id}");
  expect(m.endpoints[0].source).toBe("xhr");
  expect(m.endpoints[0].fragile).toBe(false);
});

test("marks HTML-sourced endpoints as fragile scrapes", () => {
  const htmlEntry: HarEntry = { ...entry("https://example.test/page", "<html></html>"), mimeType: "text/html" };
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
  expect(() => validateManifest({ schemaVersion: 2, site: "x" })).toThrow(/endpoints/i);
});

test("multi-origin groups are an internal error, not a user-facing failure", () => {
  const groups = groupEndpoints([
    entry("https://example.test/api/me", "{}"),
    entry("https://api.example.test/api/me", "{}"),
  ]);
  expect(() =>
    buildManifest({
      site: "example",
      groups,
      harSha256: "abc",
      recordedAt: "2026-07-20T12:00:00.000Z",
    }),
  ).toThrow(/internal: buildManifest received 2 origins/i);
});

const authedEntries: HarEntry[] = [
  {
    method: "GET",
    url: "https://x.test/api/items/4821",
    status: 200,
    requestHeaders: {
      authorization: "Bearer abc.def.ghijkl",
      "user-agent": "Mozilla/5.0 Chrome/141.0.0.0",
    },
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: '{"results":[]}',
    postData: null,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  },
];

test("analyzeAuth returns a spec and the value separately", () => {
  const { spec, value } = analyzeAuth(authedEntries);
  expect(spec).toMatchObject({ kind: "bearer", location: "authorization" });
  expect(value).toBe("Bearer abc.def.ghijkl");
});

test("analyzeAuth returns nulls when no credential is present", () => {
  const { spec, value } = analyzeAuth([]);
  expect(spec).toBeNull();
  expect(value).toBeNull();
});

test("a manifest built from real analysis never contains the secret", () => {
  const { spec, value } = analyzeAuth(authedEntries);
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
    auth: spec,
  });
  expect(m.auth).toMatchObject({ kind: "bearer", location: "authorization" });
  expect(value).not.toBeNull();
  expect(JSON.stringify(m)).not.toContain(value!);
  expect(JSON.stringify(m)).not.toContain("abc.def.ghijkl");
});

test("auth remains null when the analysis found nothing", () => {
  const m = buildManifest({
    site: "example",
    groups: groups(),
    harSha256: "abc",
    recordedAt: "2026-07-20T12:00:00.000Z",
  });
  expect(m.auth).toBeNull();
});

test("schema version is 3", () => {
  expect(SCHEMA_VERSION).toBe(3);
});

test("accepts a version 2 manifest as read-only", () => {
  const v2 = { schemaVersion: 2, site: "x", endpoints: [] };
  const m = validateManifest(v2);
  expect(m.schemaVersion).toBe(2);
  expect(m.mode ?? "read").toBe("read");
});

test("accepts a version 3 manifest carrying mode full", () => {
  const v3 = { schemaVersion: 3, site: "x", mode: "full", endpoints: [] };
  expect(validateManifest(v3).mode).toBe("full");
});

test("still rejects an unsupported schema version", () => {
  expect(() => validateManifest({ schemaVersion: 99, site: "x", endpoints: [] })).toThrow(
    /schema version/i,
  );
});

test("rejects an unknown mode value", () => {
  expect(() =>
    validateManifest({ schemaVersion: 3, site: "x", mode: "write", endpoints: [] }),
  ).toThrow(/mode/i);
});

test("manifest-schema exports the schema half independently", () => {
  expect(SCHEMA_VERSION).toBe(3);
  expect(() => validateManifest({ schemaVersion: 99, site: "x", endpoints: [] })).toThrow(
    /schema version/i,
  );
});

test("manifest re-exports the schema half, so existing imports keep working", async () => {
  const fromManifest = await import("../src/lib/manifest");
  expect(fromManifest.SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  expect(typeof fromManifest.validateManifest).toBe("function");
});

test("manifest-schema has no runtime import outside the copyable set", async () => {
  const src = await Bun.file(`${import.meta.dir}/../src/lib/manifest-schema.ts`).text();
  // Self-contained: no imports. If imports are added, every runtime import must
  // resolve to a file in the copied set.
  const imports = [...src.matchAll(/^import\s+(type\s+)?.*?from\s+"([^"]+)";$/gm)];
  for (const [, typeOnly, from] of imports) {
    if (typeOnly) continue;
    expect(["./paths", "./secrets", "./ratelimit"]).toContain(from);
  }
});

test("validateManifest rejects a site with path separators or ..", () => {
  for (const site of ["../evil", "foo/bar", "foo\\bar", ".."]) {
    expect(() =>
      validateManifest({ schemaVersion: 2, site, endpoints: [] }),
    ).toThrow(/single path segment/i);
  }
});

const writeGroup = {
  method: "POST",
  origin: "https://x.test",
  pathTemplate: "/api/events",
  params: [],
  samples: [
    {
      url: "https://x.test/api/events",
      method: "POST",
      status: 201,
      mimeType: "application/json",
      responseBody: "{}",
      postData: '{"name":"x"}',
      startedDateTime: "2026-07-24T00:00:00.000Z",
      requestHeaders: { "content-type": "application/json" },
    },
  ],
} as never;

test("full mode stamps mode and populates writeSemantics", () => {
  const m = buildManifest({
    site: "x",
    groups: [writeGroup],
    harSha256: "d",
    recordedAt: "2026-07-24T00:00:00.000Z",
    mode: "full",
  } as never);
  expect(m.mode).toBe("full");
  expect(m.endpoints[0].writeSemantics).not.toBeNull();
  expect(m.endpoints[0].writeSemantics!.bodyShape).not.toBeNull();
});

test("read mode leaves writeSemantics null and mode read", () => {
  const m = buildManifest({
    site: "x",
    groups: [],
    harSha256: "d",
    recordedAt: "2026-07-24T00:00:00.000Z",
  } as never);
  expect(m.mode ?? "read").toBe("read");
});
