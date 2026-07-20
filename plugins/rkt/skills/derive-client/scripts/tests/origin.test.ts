import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { isIdentityRequest, isThirdParty, pickPrimaryOrigin } from "../src/lib/origin";

function e(url: string, mimeType = "application/json", status = 200): HarEntry {
  return {
    method: "GET",
    url,
    status,
    requestHeaders: {},
    responseHeaders: {},
    mimeType,
    responseBody: "{}",
    postData: null,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

test("picks the origin with the most JSON responses", () => {
  const pick = pickPrimaryOrigin([
    e("https://app.test/api/a"),
    e("https://app.test/api/b"),
    e("https://other.test/api/c"),
  ]);
  expect(pick?.primary).toBe("app.test");
});

test("ignores an asset CDN even when it dominates by request count", () => {
  const entries = [
    ...Array.from({ length: 50 }, (_, i) => e(`https://assets.test/f${i}.js`, "application/javascript")),
    e("https://app.test/api/a"),
  ];
  expect(pickPrimaryOrigin(entries)?.primary).toBe("app.test");
});

test("never picks a known third-party widget origin", () => {
  const pick = pickPrimaryOrigin([
    e("https://api-abc.sendbird.com/v3/users"),
    e("https://api-abc.sendbird.com/v3/channels"),
    e("https://app.test/api/a"),
  ]);
  expect(pick?.primary).toBe("app.test");
  expect(pick?.rejected.some((r) => r.origin.endsWith("sendbird.com"))).toBe(true);
});

test("never picks the identity provider", () => {
  const pick = pickPrimaryOrigin([
    e("https://identity1.aus1.example.com/realms/x/protocol/openid-connect/token"),
    e("https://identity1.aus1.example.com/realms/x/userinfo"),
    e("https://app.test/api/a"),
  ]);
  expect(pick?.primary).toBe("app.test");
});

test("reports why each losing origin was dropped", () => {
  const pick = pickPrimaryOrigin([
    e("https://app.test/api/a"),
    e("https://bam.nr-data.net/events"),
    e("https://data.pendo.io/data/track"),
  ]);
  const reasons = Object.fromEntries((pick?.rejected ?? []).map((r) => [r.origin, r.reason]));
  expect(reasons["bam.nr-data.net"]).toMatch(/third-party/i);
  expect(reasons["data.pendo.io"]).toMatch(/third-party/i);
});

test("falls back to the busiest origin when nothing returned JSON", () => {
  // HTML-only sites still need an origin: their data is scraped, not fetched.
  expect(pickPrimaryOrigin([e("https://app.test/page", "text/html")])?.primary).toBe("app.test");
});

test("returns null for an empty recording", () => {
  expect(pickPrimaryOrigin([])).toBeNull();
});

test("falls back to the best available origin when every host looks third-party", () => {
  const pick = pickPrimaryOrigin([e("https://api-abc.sendbird.com/v3/users")]);
  expect(pick?.primary).toBe("api-abc.sendbird.com");
});

test("classifies identity requests by path even on an unremarkable host", () => {
  expect(isIdentityRequest("https://example.com/realms/x/protocol/openid-connect/token")).toBe(true);
  expect(isIdentityRequest("https://example.com/api/roster")).toBe(false);
});

test("third-party matching covers subdomains but not lookalikes", () => {
  expect(isThirdParty("bam.nr-data.net")).toBe(true);
  expect(isThirdParty("nr-data.net")).toBe(true);
  expect(isThirdParty("notnr-data.net.evil.com")).toBe(false);
});
