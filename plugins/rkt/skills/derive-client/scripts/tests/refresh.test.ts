import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import type { ClientManifest } from "../src/lib/manifest";
import { detectRefresh } from "../src/lib/refresh-detect";
import { applyCredentials } from "../src/lib/transport";

function post(url: string, responseBody: string, postData: string | null): HarEntry {
  return {
    method: "POST",
    url,
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "application/json",
    responseBody,
    postData,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

const TOKEN_URL = "https://idp.test/realms/x/protocol/openid-connect/token";
const GRANT = "grant_type=authorization_code&code=abc&client_id=web-frontend&code_verifier=v";
const TOKEN_BODY = JSON.stringify({
  access_token: "at-value",
  refresh_token: "rt-value",
  expires_in: 300,
  refresh_expires_in: 3600,
  token_type: "Bearer",
});

test("detects an OIDC token endpoint and the client id needed to repeat it", () => {
  const d = detectRefresh([post(TOKEN_URL, TOKEN_BODY, GRANT)], "https://app.test/", null);
  expect(d.spec).toMatchObject({ kind: "oidc", tokenEndpoint: TOKEN_URL, clientId: "web-frontend" });
  expect(d.refreshToken).toBe("rt-value");
});

test("records the observed token lifetimes", () => {
  const d = detectRefresh([post(TOKEN_URL, TOKEN_BODY, GRANT)], "https://app.test/", null);
  expect(d.spec).toMatchObject({ expiresIn: 300, refreshExpiresIn: 3600 });
});

test("warns when the refresh window is shorter than a day", () => {
  const d = detectRefresh([post(TOKEN_URL, TOKEN_BODY, GRANT)], "https://app.test/", null);
  expect(d.notes.join(" ")).toMatch(/refresh token lives 3600s/i);
});

test("falls back to browser re-auth when no token exchange was recorded", () => {
  const d = detectRefresh([], "https://app.test/", null);
  expect(d.spec).toEqual({ kind: "browser", entryUrl: "https://app.test/" });
  expect(d.refreshToken).toBeNull();
});

test("falls back to browser re-auth when the grant returned no refresh token", () => {
  const body = JSON.stringify({ access_token: "at", expires_in: 300 });
  const d = detectRefresh([post(TOKEN_URL, body, GRANT)], "https://app.test/", null);
  expect(d.spec?.kind).toBe("browser");
  expect(d.notes.join(" ")).toMatch(/no refresh token/i);
});

test("falls back to browser re-auth when client_id cannot be recovered", () => {
  const d = detectRefresh([post(TOKEN_URL, TOKEN_BODY, "grant_type=authorization_code&code=abc")], "https://app.test/", null);
  expect(d.spec?.kind).toBe("browser");
  expect(d.notes.join(" ")).toMatch(/no client_id/i);
});

test("remembers which cookie the refreshed access token must be written back to", () => {
  const d = detectRefresh([post(TOKEN_URL, TOKEN_BODY, GRANT)], "https://app.test/", "X-Access-Token");
  expect(d.spec).toMatchObject({ accessTokenCookie: "X-Access-Token" });
});

// --- bundle application ---

const manifest = (): ClientManifest => ({
  schemaVersion: 2,
  site: "example",
  baseUrl: "https://app.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "abc",
  userAgent: "UA",
  clientHints: {},
  auth: null,
  authBundle: {
    credentials: [
      { kind: "cookie", location: "cookie:SESSIONID", mintedBy: null, expiry: null },
      { kind: "cookie", location: "cookie:X-Access-Token", mintedBy: null, expiry: null },
      { kind: "csrf", location: "x-csrf-token", mintedBy: null, expiry: null },
    ],
    earliestExpiry: null,
  },
  refresh: null,
  endpoints: [],
});

test("merges multiple cookies into one Cookie header and sets other credentials as headers", () => {
  const headers: Record<string, string> = {};
  applyCredentials(manifest(), headers, {
    "cookie:SESSIONID": "sess1",
    "cookie:X-Access-Token": "tok1",
    "x-csrf-token": "csrf1",
  });
  expect(headers["cookie"]).toBe("SESSIONID=sess1; X-Access-Token=tok1");
  expect(headers["x-csrf-token"]).toBe("csrf1");
});

test("skips credentials with no stored value rather than sending empty ones", () => {
  const headers: Record<string, string> = {};
  applyCredentials(manifest(), headers, { "cookie:SESSIONID": "sess1" });
  expect(headers["cookie"]).toBe("SESSIONID=sess1");
  expect(headers["x-csrf-token"]).toBeUndefined();
});

test("applies nothing when there is no secret at all", () => {
  const headers: Record<string, string> = {};
  applyCredentials(manifest(), headers, null);
  expect(Object.keys(headers)).toHaveLength(0);
});

// --- browser re-auth tier ---

test("browser re-auth reports failure rather than a half-populated session", async () => {
  const { reauthViaProfile } = await import("../src/lib/reauth");
  // No profile exists for this site, so the launch cannot yield the wanted
  // cookies. A null result is the signal that a human must re-record.
  const result = await reauthViaProfile(
    "definitely-not-a-recorded-site",
    "https://app.test/",
    ["cookie:SESSION"],
    3000,
  );
  expect(result).toBeNull();
}, 90000);

test("a failed re-auth does not overwrite a stored session", async () => {
  const { mkdtemp, writeFile, readFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const prev = process.env.RKT_CLIENTS_ROOT;
  const root = await mkdtemp(join(tmpdir(), "rkt-reauth-"));
  process.env.RKT_CLIENTS_ROOT = root;
  try {
    const { storageStateFile } = await import("../src/lib/paths");
    const { reauthViaProfile } = await import("../src/lib/reauth");
    const path = storageStateFile("failsite");
    await mkdir(join(root, "secrets"), { recursive: true });
    const good = JSON.stringify({ cookies: [{ name: "KEEP_ME", value: "v" }], origins: [] });
    await writeFile(path, good);

    // Re-auth cannot succeed: no such site was ever recorded.
    const result = await reauthViaProfile("failsite", "https://app.invalid/", ["cookie:SESSION"], 2000);
    expect(result).toBeNull();
    // The stored session must survive the failure.
    expect(await readFile(path, "utf8")).toBe(good);
  } finally {
    if (prev === undefined) delete process.env.RKT_CLIENTS_ROOT;
    else process.env.RKT_CLIENTS_ROOT = prev;
  }
}, 90000);
