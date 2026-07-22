import { expect, test } from "bun:test";
import type { Scheduler, SchedulerResponse } from "../src/lib/scheduler";
import { createCaller } from "../src/lib/runtime";
import { REFRESH_TOKEN_KEY } from "../src/lib/secrets";

const baseManifest = () => ({
  schemaVersion: 2,
  site: "example",
  baseUrl: "https://x.test",
  recordedAt: "",
  harSha256: "",
  userAgent: "UA",
  clientHints: {},
  auth: { kind: "bearer" as const, location: "authorization", mintedBy: null, expiry: null },
  authBundle: {
    credentials: [{ kind: "bearer" as const, location: "authorization", mintedBy: null, expiry: null }],
    earliestExpiry: null,
  },
  refresh: {
    kind: "oidc" as const,
    tokenEndpoint: "https://idp/token",
    clientId: "public",
    accessTokenCookie: null,
    expiresIn: 300,
    refreshExpiresIn: 3600,
  },
  endpoints: [
    {
      id: "get.data",
      method: "GET",
      pathTemplate: "/data",
      params: [],
      responseShape: { type: "unknown" as const },
      source: "xhr" as const,
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
});

// A scheduler that returns queued responses in order and records the auth header seen.
function fakeScheduler(statuses: SchedulerResponse[], seen: string[]): Scheduler {
  let i = 0;
  return {
    run: async (req) => {
      seen.push(req.headers["authorization"] ?? "");
      return statuses[Math.min(i++, statuses.length - 1)];
    },
  };
}

test("passes a 2xx straight through", async () => {
  const seen: string[] = [];
  const sched = fakeScheduler([{ status: 200, body: "{}", headers: {} }], seen);
  const caller = createCaller(baseManifest(), sched, { authorization: "Bearer old" });
  const res = await caller.call("get.data", {});
  expect(res.status).toBe(200);
  expect(seen).toEqual(["Bearer old"]);
});

test("on 401 refreshes via OIDC and retries with the new token", async () => {
  const seen: string[] = [];
  const sched = fakeScheduler(
    [
      { status: 401, body: "no", headers: {} },
      { status: 200, body: "ok", headers: {} },
    ],
    seen,
  );
  const writes: Record<string, string>[] = [];
  const caller = createCaller(
    baseManifest(),
    sched,
    { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" },
    {
      // expiresIn is required on RefreshedTokens (refresh.ts); omitting it fails strict tsc.
      refreshViaOidc: async () => ({ accessToken: "new", refreshToken: "r2", expiresIn: null }),
      writeSecret: async (_site, values) => {
        writes.push(values as Record<string, string>);
      },
    },
  );
  const res = await caller.call("get.data", {});
  expect(res.status).toBe(200);
  expect(seen).toEqual(["Bearer old", "Bearer new"]); // retried with the refreshed token
  expect(writes[0][REFRESH_TOKEN_KEY]).toBe("r2"); // rotated refresh token persisted
  expect(caller.secret?.authorization).toBe("Bearer new");
});

test("falls back to browser re-auth when OIDC refuses", async () => {
  const seen: string[] = [];
  const sched = fakeScheduler(
    [
      { status: 401, body: "no", headers: {} },
      { status: 200, body: "ok", headers: {} },
    ],
    seen,
  );
  const caller = createCaller(
    baseManifest(),
    sched,
    { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" },
    {
      refreshViaOidc: async () => null,
      reauthViaProfile: async () => ({ values: { authorization: "Bearer browser" } }),
      writeSecret: async () => {},
    },
  );
  const res = await caller.call("get.data", {});
  expect(res.status).toBe(200);
  expect(seen[1]).toBe("Bearer browser");
});

test("fetchJson throws a clear error on a non-2xx", async () => {
  const sched = fakeScheduler([{ status: 500, body: "boom", headers: {} }], []);
  const caller = createCaller(baseManifest(), sched, null, { writeSecret: async () => {} });
  await expect(caller.fetchJson("get.data")).rejects.toThrow(/HTTP 500/);
});

test("fetchJson forwards params into the request URL", async () => {
  const seen: string[] = [];
  const sched: Scheduler = {
    run: async (req) => { seen.push(req.url); return { status: 200, body: "{}", headers: {} }; },
  };
  const m = baseManifest();
  m.endpoints = [
    {
      id: "get.user.profile", method: "GET", pathTemplate: "/user/profile",
      params: [{ name: "username", in: "query", type: "string", required: true }],
      responseShape: { type: "unknown" as const }, source: "xhr" as const,
      fragile: false, selectors: null, writeSemantics: null,
    },
  ] as typeof m.endpoints;
  const caller = createCaller(m, sched, { authorization: "Bearer x" });
  await caller.fetchJson("get.user.profile", { username: "usr-me" });
  expect(seen[0]).toContain("username=usr-me");
});
