import { expect, test } from "bun:test";
import { analyzeAuthBundle } from "../src/lib/auth";
import type { HarEntry } from "../src/lib/har";

function req(headers: Record<string, string>, url = "https://app.test/api/a"): HarEntry {
  return {
    method: "GET",
    url,
    status: 200,
    requestHeaders: headers,
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: "{}",
    postData: null,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

/** The shape observed on the real AlayaCare recording. */
const ALAYACARE = Array.from({ length: 10 }, () =>
  req({
    cookie:
      "__cf_bm=x; PHPSESSID=abcdefghijkl; X-AlayaCare-Access-Token-Cookie=eyJhbGciOiJSUzI1NiJ9; _lang=en",
    "x-csrf-token": "csrftokenvalue123",
  }),
);

test("captures every credential the API actually requires, not just the top one", () => {
  const { bundle } = analyzeAuthBundle(ALAYACARE, ALAYACARE);
  const locations = (bundle?.credentials ?? []).map((c) => c.location).sort();
  expect(locations).toContain("cookie:PHPSESSID");
  expect(locations).toContain("cookie:X-AlayaCare-Access-Token-Cookie");
  expect(locations).toContain("x-csrf-token");
  expect(bundle?.credentials.length).toBeGreaterThanOrEqual(3);
});

test("returns the secret values keyed by location, separate from the spec", () => {
  const { bundle, values } = analyzeAuthBundle(ALAYACARE, ALAYACARE);
  expect(values["x-csrf-token"]).toBe("csrftokenvalue123");
  expect(values["cookie:PHPSESSID"]).toBe("abcdefghijkl");
  // The spec must not carry values.
  expect(JSON.stringify(bundle)).not.toContain("csrftokenvalue123");
  expect(JSON.stringify(bundle)).not.toContain("abcdefghijkl");
});

test("coverage is measured against API requests, not the whole recording", () => {
  // 10 authenticated API calls plus 90 unrelated asset/telemetry entries.
  const noise = Array.from({ length: 90 }, (_, i) =>
    req({}, `https://assets.test/f${i}.js`),
  );
  const { bundle } = analyzeAuthBundle(ALAYACARE, [...ALAYACARE, ...noise]);
  // Measured against all 100 entries the cookie would be 10% and get dropped.
  expect(bundle?.credentials.length).toBeGreaterThanOrEqual(3);
});

test("includes a CSRF header even though it rides only some requests", () => {
  // CSRF tokens are present on a minority of calls by design. Omitting one the
  // API requires costs a 401; including one it ignores costs a header.
  const entries = [
    ...Array.from({ length: 6 }, () => req({ cookie: "PHPSESSID=abcdefghijkl" })),
    ...Array.from({ length: 4 }, () =>
      req({ cookie: "PHPSESSID=abcdefghijkl", "x-csrf-token": "csrfvalue1234" }),
    ),
  ];
  const { bundle } = analyzeAuthBundle(entries, entries);
  expect(bundle?.credentials.map((c) => c.location)).toContain("x-csrf-token");
});

test("still excludes a truly incidental one-off value", () => {
  const entries = [
    ...Array.from({ length: 99 }, () => req({ cookie: "PHPSESSID=abcdefghijkl" })),
    req({ cookie: "PHPSESSID=abcdefghijkl", "x-csrf-token": "oneoffvalue123" }),
  ];
  const { bundle, rejected } = analyzeAuthBundle(entries, entries);
  expect(bundle?.credentials.map((c) => c.location)).not.toContain("x-csrf-token");
  expect(rejected.some((r) => r.location === "x-csrf-token")).toBe(true);
});

test("keeps the strongest candidate when everything is below threshold", () => {
  const entries = [
    ...Array.from({ length: 8 }, () => req({})),
    req({ cookie: "PHPSESSID=abcdefghijkl" }),
    req({ cookie: "PHPSESSID=abcdefghijkl" }),
  ];
  const { bundle } = analyzeAuthBundle(entries, entries);
  expect(bundle?.credentials).toHaveLength(1);
  expect(bundle?.credentials[0].location).toBe("cookie:PHPSESSID");
});

test("returns no bundle when there is no credential material at all", () => {
  const entries = [req({ accept: "application/json" })];
  const { bundle, values } = analyzeAuthBundle(entries, entries);
  expect(bundle).toBeNull();
  expect(Object.keys(values)).toHaveLength(0);
});

test("reports the earliest expiry across the bundle", () => {
  const { bundle } = analyzeAuthBundle(ALAYACARE, ALAYACARE);
  // No Set-Cookie in these fixtures, so no expiry is discoverable.
  expect(bundle?.earliestExpiry).toBeNull();
});
