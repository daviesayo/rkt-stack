import { expect, test } from "bun:test";
import { parseParams } from "../src/call";

test("parses repeated --param pairs", () => {
  expect(parseParams(["--param", "id=4821", "--param", "week=2026-W30"])).toEqual({
    id: "4821",
    week: "2026-W30",
  });
});

test("keeps equals signs inside the value", () => {
  expect(parseParams(["--param", "q=a=b"])).toEqual({ q: "a=b" });
});

test("returns an empty object when no params are given", () => {
  expect(parseParams(["--endpoint", "x"])).toEqual({});
});

test("throws on a param without an equals sign", () => {
  expect(() => parseParams(["--param", "broken"])).toThrow(/expected k=v/i);
});
