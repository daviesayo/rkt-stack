import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { detectCredentials, detectExpiry, traceMintPoint } from "../src/lib/auth";

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

function respEntry(
  url: string,
  responseHeaders: Record<string, string>,
  responseBody: string | null = null,
): HarEntry {
  return {
    method: "POST",
    url,
    status: 200,
    requestHeaders: {},
    responseHeaders,
    mimeType: "application/json",
    responseBody,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

test("traces a cookie to the response that set it", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sessionid",
    coverage: 1,
    value: "s3cr3tvalue",
  };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/login", { "set-cookie": "sessionid=s3cr3tvalue; Path=/; HttpOnly" }),
    entry({ cookie: "sessionid=s3cr3tvalue" }),
  ]);
  expect(mint).toBe("https://x.test/login");
});

test("traces a bearer token to the response body that returned it", () => {
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: "Bearer abc.def.ghi",
  };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/oauth/token", {}, '{"access_token":"abc.def.ghi","token_type":"Bearer"}'),
    entry({ authorization: "Bearer abc.def.ghi" }),
  ]);
  expect(mint).toBe("https://x.test/oauth/token");
});

test("returns null when the credential predates the recording", () => {
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: "Bearer abc.def.ghi",
  };
  expect(traceMintPoint(candidate, [entry({ authorization: "Bearer abc.def.ghi" })])).toBeNull();
});

test("matches a set-cookie with attributes and surrounding cookies", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sid",
    coverage: 1,
    value: "xyzxyzxyz",
  };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/auth", { "set-cookie": "other=1, sid=xyzxyzxyz; Secure; SameSite=Lax" }),
  ]);
  expect(mint).toBe("https://x.test/auth");
});

test("does not body-match a secret shorter than the safety floor", () => {
  const candidate = { kind: "cookie" as const, location: "cookie:sid", coverage: 1, value: "abc" };
  const mint = traceMintPoint(candidate, [
    respEntry("https://x.test/unrelated", {}, "the alphabet starts abc and continues"),
  ]);
  expect(mint).toBeNull();
});

/** Build an unsigned JWT with the given payload. The signature is irrelevant here. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

test("reads the exp claim from a JWT bearer token", () => {
  const exp = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: `Bearer ${jwt({ exp })}`,
  };
  expect(detectExpiry(candidate, [])).toBe("2026-08-01T00:00:00.000Z");
});

test("reads Expires from the matching set-cookie", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sid",
    coverage: 1,
    value: "xyzxyzxyz",
  };
  const mint = respEntry("https://x.test/auth", {
    "set-cookie": "sid=xyzxyzxyz; Expires=Sat, 01 Aug 2026 00:00:00 GMT; Path=/",
  });
  expect(detectExpiry(candidate, [mint])).toBe("2026-08-01T00:00:00.000Z");
});

test("computes expiry from Max-Age relative to the response time", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sid",
    coverage: 1,
    value: "xyzxyzxyz",
  };
  const mint: HarEntry = {
    ...respEntry("https://x.test/auth", { "set-cookie": "sid=xyzxyzxyz; Max-Age=3600" }),
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
  expect(detectExpiry(candidate, [mint])).toBe("2026-07-20T13:00:00.000Z");
});

test("returns null for an opaque token with no expiry signal", () => {
  const candidate = {
    kind: "cookie" as const,
    location: "cookie:sid",
    coverage: 1,
    value: "opaquevalue",
  };
  expect(detectExpiry(candidate, [])).toBeNull();
});

test("returns null rather than throwing on a malformed JWT", () => {
  const candidate = {
    kind: "bearer" as const,
    location: "authorization",
    coverage: 1,
    value: "Bearer not.a.realjwt",
  };
  expect(detectExpiry(candidate, [])).toBeNull();
});
