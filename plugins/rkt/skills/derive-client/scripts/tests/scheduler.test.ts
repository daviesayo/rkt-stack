import { expect, test } from "bun:test";
import { createScheduler } from "../src/lib/scheduler";

function fakeFetch(log: string[], status = 200) {
  return async (url: string | URL) => {
    log.push(String(url));
    return new Response("{}", { status, headers: { "content-type": "application/json" } });
  };
}

test("runs a request and returns status, body, headers", async () => {
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch([]) as unknown as typeof fetch });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(200);
  expect(r.body).toBe("{}");
  expect(r.headers["content-type"]).toBe("application/json");
});

test("dedups identical GETs within its lifetime", async () => {
  const log: string[] = [];
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch(log) as unknown as typeof fetch });
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/b", method: "GET", headers: {} });
  expect(log).toEqual(["https://x.test/a", "https://x.test/b"]);
});

test("does not dedup non-GET methods", async () => {
  const log: string[] = [];
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: fakeFetch(log) as unknown as typeof fetch });
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
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, fetchImpl: slow as unknown as typeof fetch });
  await Promise.all([1, 2, 3, 4].map((n) => s.run({ url: `https://x.test/${n}`, method: "GET", headers: {} })));
  expect(maxActive).toBe(1);
});

test("spaces successive distinct calls by at least the minimum", async () => {
  const s = createScheduler({ minDelayMs: 40, maxDelayMs: 45, fetchImpl: fakeFetch([]) as unknown as typeof fetch });
  const start = Date.now();
  await s.run({ url: "https://x.test/1", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/2", method: "GET", headers: {} });
  await s.run({ url: "https://x.test/3", method: "GET", headers: {} });
  expect(Date.now() - start).toBeGreaterThanOrEqual(75);
});

test("retries a 503 with exponential backoff, then succeeds", async () => {
  let calls = 0;
  const flaky = async () =>
    ++calls < 3 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 });
  const slept: number[] = [];
  const s = createScheduler({
    minDelayMs: 0, maxDelayMs: 0, maxRetries: 3,
    fetchImpl: flaky as unknown as typeof fetch,
    sleepImpl: async (ms) => { slept.push(ms); },
  });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(200);
  expect(calls).toBe(3);
  // Two retries: 500ms then 1000ms. Asserted, so the name is not a lie.
  expect(slept).toEqual([500, 1000]);
});

test("honors a numeric Retry-After header over the exponential schedule", async () => {
  let calls = 0;
  const flaky = async () =>
    ++calls < 2
      ? new Response("slow", { status: 429, headers: { "retry-after": "3" } })
      : new Response("{}", { status: 200 });
  const slept: number[] = [];
  const s = createScheduler({
    minDelayMs: 0, maxDelayMs: 0,
    fetchImpl: flaky as unknown as typeof fetch,
    sleepImpl: async (ms) => { slept.push(ms); },
  });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(200);
  expect(calls).toBe(2);
  expect(slept).toEqual([3000]); // Retry-After seconds, not the 500ms default
});

test("gives up after maxRetries and returns the last error response", async () => {
  const always503 = async () => new Response("busy", { status: 503 });
  const s = createScheduler({
    minDelayMs: 0, maxDelayMs: 0, maxRetries: 2,
    fetchImpl: always503 as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
  const r = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(r.status).toBe(503);
});

test("caches a response that succeeded after retries", async () => {
  let calls = 0;
  const flaky = async () =>
    ++calls < 2 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 });
  const s = createScheduler({
    minDelayMs: 0, maxDelayMs: 0, fetchImpl: flaky as unknown as typeof fetch, sleepImpl: async () => {},
  });
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} }); // 503 then 200 => calls 2
  await s.run({ url: "https://x.test/a", method: "GET", headers: {} }); // served from cache
  expect(calls).toBe(2); // no third fetch
});

test("does not cache a failed response", async () => {
  let calls = 0;
  const recovering = async () => {
    calls++;
    return calls === 1 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 });
  };
  const s = createScheduler({ minDelayMs: 0, maxDelayMs: 0, maxRetries: 0, fetchImpl: recovering as unknown as typeof fetch });
  const first = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(first.status).toBe(503);
  const second = await s.run({ url: "https://x.test/a", method: "GET", headers: {} });
  expect(second.status).toBe(200); // not served from cache
});

test("does not retry a write on 503", async () => {
  let calls = 0;
  const scheduler = createScheduler({
    fetchImpl: (async () => {
      calls++;
      return new Response("", { status: 503 });
    }) as never,
    sleepImpl: async () => {},
  });
  await scheduler.run({ url: "https://x.test/a", method: "POST", headers: {}, body: "{}" });
  expect(calls).toBe(1);
});

test("still retries a read on 503", async () => {
  let calls = 0;
  const scheduler = createScheduler({
    maxRetries: 2,
    fetchImpl: (async () => {
      calls++;
      return new Response("", { status: 503 });
    }) as never,
    sleepImpl: async () => {},
  });
  await scheduler.run({ url: "https://x.test/b", method: "GET", headers: {} });
  expect(calls).toBe(3);
});
