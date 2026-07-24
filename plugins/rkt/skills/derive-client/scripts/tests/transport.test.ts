import { expect, test } from "bun:test";
import type { ClientManifest, ManifestEndpoint } from "../src/lib/manifest";
import { createScheduler } from "../src/lib/scheduler";
import { buildRequest, issue, writesEnabled } from "../src/lib/transport";

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
    schemaVersion: 2,
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

test("issue calls the scheduler and returns status and body", async () => {
  const scheduler = createScheduler({
    minDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch,
  });
  const built = { url: "https://x.test/api", method: "GET", headers: {} };
  const { status, body } = await issue(built, scheduler);
  expect(status).toBe(200);
  expect(body).toBe('{"ok":true}');
});

test("issue still refuses a non-read method when writes are disabled", async () => {
  const scheduler = createScheduler({ minDelayMs: 0, maxDelayMs: 0 });
  await expect(
    issue({ url: "https://x.test/api", method: "DELETE", headers: {} }, scheduler, { env: {} as never }),
  ).rejects.toThrow(/writes are disabled/i);
});

test("supplies recorded values for params the API requires", () => {
  // A param present on every recorded sample is mandatory. Dropping it because
  // the caller did not repeat it yields a 400 that reads like a client bug.
  const ep: ManifestEndpoint = {
    ...endpoint,
    pathTemplate: "/api/v2/settings",
    params: [
      { name: "keys", in: "query", type: "string", required: true, example: "modals_v2" },
      { name: "page", in: "query", type: "number", required: false, example: "1" },
    ],
  };
  const built = buildRequest(manifest(null), ep, {}, null);
  expect(built.url).toBe("https://x.test/api/v2/settings?keys=modals_v2");
});

test("an explicit param overrides the recorded example", () => {
  const ep: ManifestEndpoint = {
    ...endpoint,
    pathTemplate: "/api/v2/settings",
    params: [{ name: "keys", in: "query", type: "string", required: true, example: "modals_v2" }],
  };
  const built = buildRequest(manifest(null), ep, { keys: "other" }, null);
  expect(built.url).toBe("https://x.test/api/v2/settings?keys=other");
});

const BASE_MANIFEST = manifest({ kind: "cookie", location: "cookie:s", mintedBy: null, expiry: null }, "https://x.test");
const FULL = { ...BASE_MANIFEST, mode: "full" as const };

const WRITE_EP = {
  id: "post.api.events",
  method: "POST",
  pathTemplate: "/api/events",
  params: [],
  responseShape: { type: "unknown" as const },
  source: "xhr" as const,
  fragile: false,
  selectors: null,
  writeSemantics: { bodyShape: null, bodyHints: {}, contentType: "application/json" },
};

test("writesEnabled is fail-closed", () => {
  expect(writesEnabled({} as never)).toBe(false);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "" } as never)).toBe(false);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "0" } as never)).toBe(false);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "false" } as never)).toBe(false);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "1" } as never)).toBe(true);
  expect(writesEnabled({ RKT_ALLOW_WRITES: "true" } as never)).toBe(true);
});

test("buildRequest serialises a body and sets content-type for a write", () => {
  const built = buildRequest(FULL, WRITE_EP as never, {}, null, { name: "x" });
  expect(built.method).toBe("POST");
  expect(built.body).toBe('{"name":"x"}');
  expect(built.headers["content-type"]).toBe("application/json");
});

test("buildRequest still refuses a write on a read-mode manifest", () => {
  expect(() => buildRequest(BASE_MANIFEST, WRITE_EP as never, {}, null, {})).toThrow(/read mode/i);
});

test("issue refuses a write when RKT_ALLOW_WRITES is not enabled", async () => {
  const built = buildRequest(FULL, WRITE_EP as never, {}, null, {});
  const scheduler = { run: async () => ({ status: 200, body: "{}", headers: {} }) };
  await expect(issue(built, scheduler, { env: {} as never })).rejects.toThrow(/RKT_ALLOW_WRITES/);
});

test("issue sends the body when writes are enabled", async () => {
  const built = buildRequest(FULL, WRITE_EP as never, {}, null, { a: 1 });
  let seen: unknown;
  const scheduler = {
    run: async (req: unknown) => {
      seen = req;
      return { status: 201, body: "{}", headers: {} };
    },
  };
  await issue(built, scheduler, { env: { RKT_ALLOW_WRITES: "1" } as never });
  expect((seen as { body: string }).body).toBe('{"a":1}');
});
