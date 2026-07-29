import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIdentity, whoamiLine } from "../src/lib/identity";
import { installIdentityWriteMock, restoreIdentityWriteMock } from "./identity-write-mock";

let root: string;
const ORIG_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIG_NODE_ENV = process.env.NODE_ENV;

beforeEach(async () => {
  restoreIdentityWriteMock();
  root = await mkdtemp(join(tmpdir(), "rkt-id-"));
  process.env.RKT_CLIENTS_ROOT = root;
  process.env.NODE_ENV = "test";
});
afterEach(async () => {
  restoreIdentityWriteMock();
  if (ORIG_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIG_ROOT;
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
  await rm(root, { recursive: true, force: true });
});

const spec = { endpoint: "get.me", idField: "id", display: ["first_name", "email"] };

test("resolves identity from the endpoint and caches it", async () => {
  let calls = 0;
  const fetchEndpoint = async () => { calls++; return { id: 924, first_name: "Ada", email: "ada@x.test" }; };
  const first = await resolveIdentity("s", spec, fetchEndpoint);
  expect(first.id).toBe("924");
  expect(first.display.first_name).toBe("Ada");
  const second = await resolveIdentity("s", spec, fetchEndpoint);
  expect(second.id).toBe("924");
  expect(calls).toBe(1); // served from cache the second time
});

test("whoamiLine formats the display fields", () => {
  expect(whoamiLine({ first_name: "Ada", email: "ada@x.test" }, ["first_name", "email"])).toBe("Ada (ada@x.test)");
});

test("throws a clear error when the id field is absent", async () => {
  const fetchEndpoint = async () => ({ first_name: "Ada" });
  await expect(resolveIdentity("s", spec, fetchEndpoint)).rejects.toThrow(/idField 'id'/i);
});

test("invalid cache shape is treated as a miss and re-fetched", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  const { secretsDir } = await import("../src/lib/paths");
  await mkdir(secretsDir(), { recursive: true });
  await writeFile(identityCacheFile("s"), JSON.stringify({}), "utf8");
  let calls = 0;
  const fetchEndpoint = async () => { calls++; return { id: 42, first_name: "Bob" }; };
  const result = await resolveIdentity("s", spec, fetchEndpoint);
  expect(result.id).toBe("42");
  expect(calls).toBe(1);
});

test("the cache file is written at 0600", async () => {
  const { stat } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  await resolveIdentity("s", spec, async () => ({ id: 1 }));
  const info = await stat(identityCacheFile("s"));
  expect(info.mode & 0o777).toBe(0o600);
});

test("stale cache without label is refetched and rewritten with label", async () => {
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  const { secretsDir } = await import("../src/lib/paths");
  await mkdir(secretsDir(), { recursive: true });
  await writeFile(
    identityCacheFile("s"),
    JSON.stringify({ id: "924", display: { first_name: "Ada", email: "ada@x.test" } }),
    "utf8",
  );
  let calls = 0;
  const fetchEndpoint = async () => {
    calls++;
    return { id: 924, first_name: "Ada", email: "ada@x.test" };
  };
  const result = await resolveIdentity("s", spec, fetchEndpoint);
  expect(result.label).toBe("Ada (ada@x.test)");
  expect(calls).toBe(1);
  const cached = JSON.parse(await readFile(identityCacheFile("s"), "utf8"));
  expect(cached.label).toBe("Ada (ada@x.test)");
});

test("stores a formatted label in the cache", async () => {
  const { readFile } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  const s = { endpoint: "get.me", idField: "id", display: ["first_name", "email"] };
  await resolveIdentity("s", s, async () => ({ id: 1, first_name: "Ada", email: "ada@x.test" }));
  const cached = JSON.parse(await readFile(identityCacheFile("s"), "utf8"));
  expect(cached.label).toBe("Ada (ada@x.test)");
});

test("resolveIdentity passes spec.params to the fetch and reads nested idField", async () => {
  let seenParams: unknown;
  const s = { endpoint: "get.user.profile", params: { username: "usr-me" }, idField: "user.api_id", display: ["user.name"] };
  const fetchEndpoint = async (_id: string, params?: Record<string, string>) => {
    seenParams = params;
    return { user: { api_id: "usr-me", name: "Ada" } };
  };
  const r = await resolveIdentity("s", s, fetchEndpoint);
  expect(seenParams).toEqual({ username: "usr-me" });
  expect(r.id).toBe("usr-me");
  expect(r.display["user.name"]).toBe("Ada");
});

test("concurrent resolveIdentity calls never run two cache writes at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  installIdentityWriteMock({
    delayMs: 50,
    onWriteEnter: () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
    },
    onWriteExit: () => {
      inFlight--;
    },
  });
  const fetchEndpoint = async () => ({ id: 924, first_name: "Ada", email: "ada@x.test" });
  const p1 = resolveIdentity("s", spec, fetchEndpoint);
  const p2 = resolveIdentity("s", spec, fetchEndpoint);
  await Promise.allSettled([p1, p2]);
  expect(maxInFlight).toBe(1);
});

test("identity cache write critical sections do not overlap under contention", async () => {
  const events: string[] = [];
  let writeIndex = 0;
  installIdentityWriteMock({
    delayMs: 50,
    onWriteEnter: () => {
      const label = String.fromCharCode(65 + writeIndex++);
      events.push(`enter ${label}`);
      return label;
    },
    onWriteExit: (label) => {
      events.push(`exit ${label}`);
    },
  });
  const fetchEndpoint = async () => ({ id: 924, first_name: "Ada", email: "ada@x.test" });
  const p1 = resolveIdentity("s", spec, fetchEndpoint);
  const p2 = resolveIdentity("s", spec, fetchEndpoint);
  await Promise.allSettled([p1, p2]);
  expect(events).toEqual(["enter A", "exit A", "enter B", "exit B"]);
});

test("a rejected identity cache write does not wedge the serializer chain", async () => {
  const tracker = installIdentityWriteMock({ failOnCall: 2 });
  const fetchEndpoint = async () => ({ id: 924, first_name: "Ada", email: "ada@x.test" });
  const outcomes: Array<"ok" | "err"> = [];
  const p1 = resolveIdentity("s", spec, fetchEndpoint).then(
    () => outcomes.push("ok"),
    () => outcomes.push("err"),
  );
  const p2 = resolveIdentity("s", spec, fetchEndpoint).then(
    () => outcomes.push("ok"),
    () => outcomes.push("err"),
  );
  const p3 = resolveIdentity("s", spec, fetchEndpoint).then(
    () => outcomes.push("ok"),
    () => outcomes.push("err"),
  );
  await Promise.all([p1, p2, p3]);
  expect(tracker.writeCallCount).toBe(3);
  expect(outcomes.filter((o) => o === "ok").length).toBe(2);
  expect(outcomes.filter((o) => o === "err").length).toBe(1);
});
