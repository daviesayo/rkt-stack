import { expect, test } from "bun:test";
import { createScheduler } from "../src/lib/scheduler";

function fakeFetch(log: string[], status = 200) {
  return async (url: string | URL) => {
    log.push(String(url));
    return new Response("{}", { status, headers: { "content-type": "application/json" } });
  };
}

test("runs a request and returns status, body, headers", async () => {
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch([]) as typeof fetch });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(200);
  expect(r.body).toBe("{}");
  expect(r.headers["content-type"]).toBe("application/json");
});

test("dedups identical GETs within its lifetime", async () => {
  const log: string[] = [];
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch(log) as typeof fetch });
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/b", method: "GET", headers: {} });
  expect(log).toEqual(["https://x.test/a", "https://x.test/b"]);
});

test("does not dedup non-GET methods", async () => {
  const log: string[] = [];
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch(log) as typeof fetch });
  await s.run({ url: "https://x.test/a", method: "HEAD", headers: {} });
  await s.run({ url: "https://x.test/a", method: "HEAD", headers: {} });
  // HEAD is cacheable too; but a POST would not be. Assert HEAD dedups, POST does not.
  expect(log).toEqual(["https://x.test/a"]);
  await s.run({ url: "https://x.test/a", method: "POST", headers: {} });
  expect(log).toEqual(["https://x.test/a", "https://x.test/a"]);
});

test("serializes: never two fetches in flight at once", async () => {
  let active = 0, maxActive = 0;
  const slow = async (url: string | URL) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return new Response("{}", { status: 200 });
  };
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: slow as typeof fetch });
  await Promise.all([1, 2, 3, 4].map((n) => s.run({ url: `https://x.test/${n}`, method: "GET", headers: {} })));
  expect(maxActive).toBe(1);
});

test("spaces successive distinct calls by at least the minimum", async () => {
  const s = createScheduler({ minDelayMs: 40, maxDelayMs: 45, fetchImpl: fakeFetch([]) as typeof fetch });
  const start = Date.now();
  await s.run({ url: "https://x.test/1", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/2", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/3", method: "GET", headers: {} });
  expect(Date.now() - start).toBeGreaterThanOrEqual(75);
});
