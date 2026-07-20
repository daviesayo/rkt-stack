import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { detectCredentials } from "../src/lib/auth";

function entry(requestHeaders: Record<string, string>, url = "https://x.test/api/a"): HarEntry {
  return {
    method: "GET",
    url,
    status: 200,
    requestHeaders,
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: "{}",
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

test("detects a bearer token in the authorization header", () => {
  const found = detectCredentials([entry({ authorization: "Bearer abc.def.ghi" })]);
  expect(found[0]).toMatchObject({
    kind: "bearer",
    location: "authorization",
    value: "Bearer abc.def.ghi",
  });
});

test("detects a session cookie by name", () => {
  const found = detectCredentials([
    entry({ cookie: "theme=dark; sessionid=s3cr3tvalue; lang=en" }),
    entry({ cookie: "theme=dark; sessionid=s3cr3tvalue; lang=en" }),
  ]);
  const session = found.find((c) => c.location === "cookie:sessionid");
  expect(session).toMatchObject({ kind: "cookie", value: "s3cr3tvalue" });
});

test("ignores cookies that look like preferences", () => {
  const found = detectCredentials([entry({ cookie: "theme=dark; lang=en" })]);
  expect(found).toHaveLength(0);
});

test("detects a CSRF header", () => {
  const found = detectCredentials([entry({ "x-csrf-token": "tok123456" })]);
  expect(found[0]).toMatchObject({ kind: "csrf", location: "x-csrf-token", value: "tok123456" });
});

test("never treats x-requested-with as a credential", () => {
  const found = detectCredentials([
    entry({ "x-requested-with": "XMLHttpRequest" }),
    entry({ "x-requested-with": "XMLHttpRequest" }),
  ]);
  expect(found).toHaveLength(0);
});

test("rejects known non-secret constants even in a credential-shaped header", () => {
  const found = detectCredentials([entry({ "x-csrf-token": "undefined" })]);
  expect(found).toHaveLength(0);
});

test("rejects values too short to be a credential", () => {
  const found = detectCredentials([entry({ cookie: "sessionid=1" })]);
  expect(found).toHaveLength(0);
});

test("coverage reflects how many requests carry the credential", () => {
  const found = detectCredentials([
    entry({ authorization: "Bearer aaaaaaaa" }),
    entry({ authorization: "Bearer aaaaaaaa" }),
    entry({}),
    entry({}),
  ]);
  expect(found[0].coverage).toBeCloseTo(0.5);
});

test("results are sorted by coverage descending", () => {
  const found = detectCredentials([
    entry({ authorization: "Bearer aaaaaaaa", "x-csrf-token": "tok123456" }),
    entry({ authorization: "Bearer aaaaaaaa" }),
    entry({ authorization: "Bearer aaaaaaaa" }),
  ]);
  expect(found[0].kind).toBe("bearer");
  expect(found[0].coverage).toBeGreaterThan(found[1].coverage);
});

test("returns nothing when no credential material is present", () => {
  expect(detectCredentials([entry({ accept: "application/json" })])).toHaveLength(0);
});
