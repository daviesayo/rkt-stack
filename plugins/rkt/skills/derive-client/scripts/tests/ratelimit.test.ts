import { expect, test } from "bun:test";
import { createLimiter } from "../src/lib/ratelimit";

test("runs tasks and returns their values", async () => {
  const limit = createLimiter({ minDelayMs: 0, maxDelayMs: 0 });
  expect(await limit(async () => 42)).toBe(42);
});

test("serializes concurrent calls: never two at once", async () => {
  const limit = createLimiter({ minDelayMs: 0, maxDelayMs: 0 });
  let active = 0;
  let maxActive = 0;

  await Promise.all(
    Array.from({ length: 5 }, () =>
      limit(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    ),
  );

  expect(maxActive).toBe(1);
});

test("spaces successive calls by roughly the minimum delay", async () => {
  const limit = createLimiter({ minDelayMs: 40, maxDelayMs: 45 });
  const start = Date.now();
  await limit(async () => null);
  await limit(async () => null);
  await limit(async () => null);
  // Three calls means two inter-call gaps. Allow 5ms of timer slop so this is
  // not flaky when setTimeout fires a hair early.
  expect(Date.now() - start).toBeGreaterThanOrEqual(75);
});

test("preserves call order", async () => {
  const limit = createLimiter({ minDelayMs: 0, maxDelayMs: 0 });
  const seen: number[] = [];
  await Promise.all([1, 2, 3].map((n) => limit(async () => { seen.push(n); })));
  expect(seen).toEqual([1, 2, 3]);
});

test("a rejected task does not wedge the queue", async () => {
  const limit = createLimiter({ minDelayMs: 0, maxDelayMs: 0 });
  await expect(limit(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(await limit(async () => "still works")).toBe("still works");
});
