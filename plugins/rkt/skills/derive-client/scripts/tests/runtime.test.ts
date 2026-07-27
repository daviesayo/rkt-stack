import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Scheduler, SchedulerResponse } from "../src/lib/scheduler";
import { createCaller } from "../src/lib/runtime";
import { CliError } from "../src/lib/overflow";
import { REFRESH_TOKEN_KEY } from "../src/lib/secrets";

const PRIOR = process.env.RKT_ALLOW_WRITES;
beforeAll(() => {
  process.env.RKT_ALLOW_WRITES = "1";
});
afterAll(() => {
  if (PRIOR === undefined) delete process.env.RKT_ALLOW_WRITES;
  else process.env.RKT_ALLOW_WRITES = PRIOR;
});

const FULL_MANIFEST = {
  schemaVersion: 3,
  site: "x",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-24T00:00:00.000Z",
  harSha256: "d",
  userAgent: "UA",
  clientHints: {},
  auth: { kind: "cookie" as const, location: "cookie:s", mintedBy: null, expiry: null },
  authBundle: null,
  refresh: null,
  mode: "full" as const,
  endpoints: [
    {
      id: "post.api.events",
      method: "POST",
      pathTemplate: "/api/events",
      params: [],
      responseShape: { type: "unknown" as const },
      source: "xhr" as const,
      fragile: false,
      selectors: null,
      writeSemantics: {
        bodyShape: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const },
            count: { type: "number" as const },
            pinned: { type: "string" as const },
          },
          required: [],
        },
        bodyHints: {},
        contentType: "application/json",
      },
    },
    {
      id: "get.api.events",
      method: "GET",
      pathTemplate: "/api/events",
      params: [],
      responseShape: { type: "unknown" as const },
      source: "xhr" as const,
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

const RENEWABLE = {
  ...FULL_MANIFEST,
  refresh: {
    kind: "oidc" as const,
    tokenEndpoint: "https://idp.test/token",
    clientId: "c",
    accessTokenCookie: "s",
    expiresIn: 300,
    refreshExpiresIn: 3600,
  },
};

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

test("missing endpoint throws CliError with regenerate hint", async () => {
  const caller = createCaller(baseManifest(), fakeScheduler([], []), null);
  const err = await caller.call("no.such.endpoint", {}).catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).hint).toContain("regenerate");
});

test("fetchJson throws CliError exit 4 when 401 persists after renewal", async () => {
  const sched = fakeScheduler(
    [
      { status: 401, body: "no", headers: {} },
      { status: 401, body: "still no", headers: {} },
    ],
    [],
  );
  const caller = createCaller(
    baseManifest(),
    sched,
    { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" },
    {
      refreshViaOidc: async () => ({ accessToken: "new", refreshToken: "r2", expiresIn: null }),
      reauthViaProfile: async () => null,
      writeSecret: async () => {},
    },
  );
  const err = await caller.fetchJson("get.data").catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).exitCode).toBe(4);
  expect((err as CliError).hint).toContain("login");
});

test("fetchJson throws CliError when response is not JSON", async () => {
  const sched = fakeScheduler([{ status: 200, body: "not-json", headers: {} }], []);
  const caller = createCaller(baseManifest(), sched, null);
  const err = await caller.fetchJson("get.data").catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).hint).toMatch(/inspect the request|omit --commit/i);
});

test("a write is not re-issued after a 401 renewal", async () => {
  let sends = 0;
  const scheduler = {
    run: async () => {
      sends++;
      return { status: 401, body: "{}", headers: {} };
    },
  };
  const caller = createCaller(
    RENEWABLE as never,
    scheduler as never,
    { "cookie:s": "v", [REFRESH_TOKEN_KEY]: "rt" },
    {
      refreshViaOidc: (async () => ({ accessToken: "a2", refreshToken: "rt2" })) as never,
      reauthViaProfile: (async () => null) as never,
      writeSecret: (async () => {}) as never,
      log: () => {},
    },
  );
  await expect(caller.call("post.api.events", {}, { a: 1 })).rejects.toThrow(/may .*have applied/i);
  expect(sends).toBe(1);
});

test("a write's 401 never pays for renewal: it is refused before OIDC/browser re-auth run", async () => {
  let sends = 0;
  let refreshCalls = 0;
  let reauthCalls = 0;
  const scheduler = {
    run: async () => {
      sends++;
      return { status: 401, body: "{}", headers: {} };
    },
  };
  const caller = createCaller(
    RENEWABLE as never,
    scheduler as never,
    { "cookie:s": "v", [REFRESH_TOKEN_KEY]: "rt" },
    {
      refreshViaOidc: (async () => {
        refreshCalls++;
        return { accessToken: "a2", refreshToken: "rt2" };
      }) as never,
      reauthViaProfile: (async () => {
        reauthCalls++;
        return null;
      }) as never,
      writeSecret: (async () => {}) as never,
      log: () => {},
    },
  );
  await expect(caller.call("post.api.events", {}, { a: 1 })).rejects.toThrow(/may .*have applied/i);
  expect(sends).toBe(1);
  // The write is refused outright; it must never trigger the (expensive)
  // renewal tiers that only a retried request could make use of.
  expect(refreshCalls).toBe(0);
  expect(reauthCalls).toBe(0);
});

test("a read IS still re-issued after a 401 renewal", async () => {
  let sends = 0;
  const scheduler = {
    run: async () => {
      sends++;
      return { status: sends === 1 ? 401 : 200, body: "{}", headers: {} };
    },
  };
  const caller = createCaller(
    RENEWABLE as never,
    scheduler as never,
    { "cookie:s": "v", [REFRESH_TOKEN_KEY]: "rt" },
    {
      refreshViaOidc: (async () => ({ accessToken: "a2", refreshToken: "rt2" })) as never,
      reauthViaProfile: (async () => null) as never,
      writeSecret: (async () => {}) as never,
      log: () => {},
    },
  );
  const res = await caller.call("get.api.events", {});
  expect(res.status).toBe(200);
  expect(sends).toBe(2);
});

function auth401Scheduler(seen: string[], okAuth = "Bearer new"): Scheduler {
  return {
    run: async (req) => {
      const auth = req.headers["authorization"] ?? "";
      seen.push(auth);
      if (auth === "Bearer old") {
        return { status: 401, body: "no", headers: {} };
      }
      if (auth === okAuth) {
        return { status: 200, body: "ok", headers: {} };
      }
      return { status: 500, body: "unexpected auth", headers: {} };
    },
  };
}

test("concurrent 401s on separate callers single-flight renew: one refresh, one write, both succeed", async () => {
  const seen: string[] = [];
  const sched = auth401Scheduler(seen);
  let refreshCalls = 0;
  let writeCalls = 0;
  let bundle: Record<string, string> = {
    authorization: "Bearer old",
    [REFRESH_TOKEN_KEY]: "r1",
  };
  const sharedDeps = {
    refreshViaOidc: async () => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return { accessToken: "new", refreshToken: "r2", expiresIn: null };
    },
    writeSecret: async (_site: string, values: string | Record<string, string>) => {
      writeCalls++;
      bundle = typeof values === "string" ? { default: values } : { ...values };
    },
    readSecrets: async () => ({ ...bundle }),
  };
  const initial = { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" };
  const callerA = createCaller(baseManifest(), sched, { ...initial }, sharedDeps);
  const callerB = createCaller(baseManifest(), sched, { ...initial }, sharedDeps);
  const results = await Promise.all([
    callerA.call("get.data", {}),
    callerB.call("get.data", {}),
  ]);
  expect(results.every((r) => r.status === 200)).toBe(true);
  expect(refreshCalls).toBe(1);
  expect(writeCalls).toBe(1);
  expect(seen.filter((a) => a === "Bearer new").length).toBe(2);
});

test("a follower re-reads the persisted bundle after awaiting renewal, not its stale snapshot", async () => {
  const seen: string[] = [];
  const sched = auth401Scheduler(seen, "Bearer persisted");
  let disk: Record<string, string> = {
    authorization: "Bearer old",
    [REFRESH_TOKEN_KEY]: "r1",
  };
  const sharedDeps = {
    refreshViaOidc: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { accessToken: "new", refreshToken: "r2", expiresIn: null };
    },
    writeSecret: async (_site: string, values: string | Record<string, string>) => {
      disk = {
        ...(typeof values === "string" ? { default: values } : values),
        authorization: "Bearer persisted",
      };
    },
    readSecrets: async () => ({ ...disk }),
  };
  const callerA = createCaller(
    baseManifest(),
    sched,
    { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" },
    sharedDeps,
  );
  const callerB = createCaller(
    baseManifest(),
    sched,
    { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" },
    sharedDeps,
  );
  await Promise.all([callerA.call("get.data", {}), callerB.call("get.data", {})]);
  expect(seen.filter((a) => a === "Bearer persisted").length).toBe(2);
  expect(seen).not.toContain("Bearer new");
});

test("a rejected renewal does not wedge the per-site flight", async () => {
  const seen: string[] = [];
  const sched = auth401Scheduler(seen);
  let refreshCalls = 0;
  const sharedDeps = {
    refreshViaOidc: async () => {
      refreshCalls++;
      if (refreshCalls === 1) throw new Error("simulated refresh failure");
      return { accessToken: "new", refreshToken: "r2", expiresIn: null };
    },
    writeSecret: async () => {},
    reauthViaProfile: async () => null,
  };
  const initial = { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" };
  const caller = (n: number) =>
    createCaller(baseManifest(), sched, { ...initial }, sharedDeps);
  const err = await caller(1).call("get.data", {}).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("simulated refresh failure");
  const res = await caller(2).call("get.data", {});
  expect(res.status).toBe(200);
  expect(refreshCalls).toBe(2);
});

test("the one-shot CLI path still performs a single renewal on 401", async () => {
  const seen: string[] = [];
  const sched = fakeScheduler(
    [
      { status: 401, body: "no", headers: {} },
      { status: 200, body: "ok", headers: {} },
    ],
    seen,
  );
  let refreshCalls = 0;
  const caller = createCaller(
    baseManifest(),
    sched,
    { authorization: "Bearer old", [REFRESH_TOKEN_KEY]: "r1" },
    {
      refreshViaOidc: async () => {
        refreshCalls++;
        return { accessToken: "new", refreshToken: "r2", expiresIn: null };
      },
      writeSecret: async () => {},
    },
  );
  const res = await caller.call("get.data", {});
  expect(res.status).toBe(200);
  expect(refreshCalls).toBe(1);
  expect(seen).toEqual(["Bearer old", "Bearer new"]);
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
