import { expect, test } from "bun:test";
import type { ClientManifest, ManifestEndpoint } from "../src/lib/manifest";
import { buildRequest, issue } from "../src/lib/transport";

const endpoint: ManifestEndpoint = {
  id: "get.api.items.id",
  method: "GET",
  pathTemplate: "/api/items/{id}",
  params: [
    { name: "id", in: "path", type: "number" },
    { name: "week", in: "query", type: "string" },
  ],
  responseShape: { type: "unknown" },
  source: "xhr",
  fragile: false,
  selectors: null,
  writeSemantics: null,
};

function manifest(
  auth: ClientManifest["auth"],
  baseUrl = "https://x.test",
): ClientManifest {
  return {
    schemaVersion: 1,
    site: "example",
    baseUrl,
    recordedAt: "2026-07-20T12:00:00.000Z",
    harSha256: "abc",
    userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
    clientHints: { "sec-ch-ua": '"Chromium";v="141"' },
    auth,
    authBundle: null,
    refresh: null,
    endpoints: [endpoint],
  };
}

test("substitutes path params and appends query params", () => {
  const built = buildRequest(manifest(null), endpoint, { id: "4821", week: "2026-W30" }, null);
  expect(built.url).toBe("https://x.test/api/items/4821?week=2026-W30");
  expect(built.method).toBe("GET");
});

test("pins the recorded user agent and client hints", () => {
  const built = buildRequest(manifest(null), endpoint, { id: "1" }, null);
  expect(built.headers["user-agent"]).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(built.headers["sec-ch-ua"]).toBe('"Chromium";v="141"');
});

test("applies a bearer credential to the authorization header", () => {
  const built = buildRequest(
    manifest({ kind: "bearer", location: "authorization", mintedBy: null, expiry: null }),
    endpoint,
    { id: "1" },
    "Bearer abc.def",
  );
  expect(built.headers["authorization"]).toBe("Bearer abc.def");
});

test("applies a cookie credential as a cookie header", () => {
  const built = buildRequest(
    manifest({ kind: "cookie", location: "cookie:sessionid", mintedBy: null, expiry: null }),
    endpoint,
    { id: "1" },
    "s3cr3tvalue",
  );
  expect(built.headers["cookie"]).toBe("sessionid=s3cr3tvalue");
});

test("applies a csrf credential to its recorded header", () => {
  const built = buildRequest(
    manifest({ kind: "csrf", location: "x-csrf-token", mintedBy: null, expiry: null }),
    endpoint,
    { id: "1" },
    "tok123456",
  );
  expect(built.headers["x-csrf-token"]).toBe("tok123456");
});

test("omits query params the caller did not supply", () => {
  const built = buildRequest(manifest(null), endpoint, { id: "4821" }, null);
  expect(built.url).toBe("https://x.test/api/items/4821");
});

test("throws a named error when a required path param is missing", () => {
  expect(() => buildRequest(manifest(null), endpoint, { week: "2026-W30" }, null)).toThrow(
    /missing required path param: id/i,
  );
});

test("url-encodes param values", () => {
  const built = buildRequest(manifest(null), endpoint, { id: "a b/c", week: "x&y" }, null);
  expect(built.url).toBe("https://x.test/api/items/a%20b%2Fc?week=x%26y");
});

test("refuses to build a request for a non-read method", () => {
  const writeEndpoint: ManifestEndpoint = { ...endpoint, method: "DELETE" };
  expect(() => buildRequest(manifest(null), writeEndpoint, { id: "1" }, null)).toThrow(
    /GET and HEAD only/i,
  );
});

test("refuses http baseUrl when credentials are attached", () => {
  expect(() =>
    buildRequest(
      manifest(
        { kind: "bearer", location: "authorization", mintedBy: null, expiry: null },
        "http://api.example.test",
      ),
      endpoint,
      { id: "1" },
      "Bearer s3cr3tvalue",
    ),
  ).toThrow(/refusing to send credentials over http/i);
});

test("allows http loopback when credentials are attached", () => {
  const built = buildRequest(
    manifest(
      { kind: "bearer", location: "authorization", mintedBy: null, expiry: null },
      "http://localhost:3000",
    ),
    endpoint,
    { id: "1" },
    "Bearer s3cr3tvalue",
  );
  expect(built.url).toBe("http://localhost:3000/api/items/1");
});

test("issue refuses non-GET/HEAD before calling fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    throw new Error("fetch should not be called");
  }) as unknown as typeof fetch;

  try {
    const built = {
      url: "https://x.test/api/items/1",
      method: "POST",
      headers: { accept: "application/json" },
    };
    await expect(issue(built, (fn) => fn())).rejects.toThrow(/GET and HEAD only/i);
    expect(fetchCalled).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
