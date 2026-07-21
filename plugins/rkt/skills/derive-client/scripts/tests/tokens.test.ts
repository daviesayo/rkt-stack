import { expect, test } from "bun:test";
import { isToken, resolveToken } from "../src/lib/tokens";

const NOW = new Date("2026-07-21T12:00:00Z");
const ctx = { resolveMe: async () => "924" };

test("isToken is true only for a leading @", () => {
  expect(isToken("@today")).toBe(true);
  expect(isToken("hello")).toBe(false);
  expect(isToken("a@b")).toBe(false);
});

test("a literal passes through unchanged", async () => {
  expect(await resolveToken("2026-W30", ctx, NOW)).toBe("2026-W30");
});

test("@@ escapes to a single leading @", async () => {
  expect(await resolveToken("@@handle", ctx, NOW)).toBe("@handle");
});

test("@me resolves via the context", async () => {
  expect(await resolveToken("@me", ctx, NOW)).toBe("924");
});

test("@today renders the date in UTC", async () => {
  expect(await resolveToken("@today", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-07-21");
});

test("@today+14d adds fourteen days", async () => {
  expect(await resolveToken("@today+14d", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-08-04");
});

test("a bare number means days", async () => {
  expect(await resolveToken("@today+14", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-08-04");
});

test("units w/m/y are supported", async () => {
  expect(await resolveToken("@today-1w", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-07-14");
  expect(await resolveToken("@today+1m", { ...ctx, timezone: "UTC" }, NOW)).toBe("2026-08-21");
  expect(await resolveToken("@today+1y", { ...ctx, timezone: "UTC" }, NOW)).toBe("2027-07-21");
});

test("an unknown token is a hard error naming it", async () => {
  await expect(resolveToken("@tomorrow", ctx, NOW)).rejects.toThrow(/@tomorrow/);
  await expect(resolveToken("@today+14x", ctx, NOW)).rejects.toThrow(/@today\+14x/);
});

test("@me with no identity surfaces the resolver's error", async () => {
  const noId = { resolveMe: async () => { throw new Error("no identity configured"); } };
  await expect(resolveToken("@me", noId, NOW)).rejects.toThrow(/identity/i);
});
