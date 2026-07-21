import { expect, test } from "bun:test";
import { getPath, renderJson, renderTable, sortRows } from "../src/lib/render";

const rows = [
  { date: "2026-07-21", client: { name: "Acme" }, address: "1 High St" },
  { date: "2026-07-22", client: { name: "Beta" }, address: "2 Low Rd" },
];

test("getPath reads dotted paths into nested objects", () => {
  expect(getPath(rows[0], "client.name")).toBe("Acme");
  expect(getPath(rows[0], "date")).toBe("2026-07-21");
  expect(getPath(rows[0], "client.missing")).toBeUndefined();
});

test("renderTable shows declared columns including joined paths", () => {
  const out = renderTable(rows, ["date", "client.name"], { redact: [], raw: false });
  expect(out).toContain("Acme");
  expect(out).toContain("2026-07-21");
});

test("renderTable redacts a declared field by default", () => {
  const out = renderTable(rows, ["date", "address"], { redact: ["address"], raw: false });
  expect(out).not.toContain("1 High St");
  expect(out).toContain("[REDACTED]");
});

test("renderTable with raw shows the redacted field", () => {
  const out = renderTable(rows, ["date", "address"], { redact: ["address"], raw: true });
  expect(out).toContain("1 High St");
});

test("renderJson redacts by default, in the serialized structure", () => {
  const out = renderJson(rows, { redact: ["address"], raw: false });
  expect(out).not.toContain("1 High St");
  expect(out).toContain("[REDACTED]");
  // still valid JSON
  expect(() => JSON.parse(out)).not.toThrow();
});

test("renderJson with raw does not redact", () => {
  const out = renderJson(rows, { redact: ["address"], raw: true });
  expect(out).toContain("1 High St");
});

test("renderJson redacts a nested joined path", () => {
  const out = renderJson([{ client: { name: "Acme", ssn: "123" } }], { redact: ["client.ssn"], raw: false });
  expect(out).not.toContain("123");
  expect(out).toContain("Acme");
});

test("sortRows orders numbers numerically", () => {
  const out = sortRows([{ n: 10 }, { n: 2 }, { n: 1 }], "n");
  expect(out.map((r) => r.n)).toEqual([1, 2, 10]);
});

test("sortRows orders strings by locale and sorts missing values last", () => {
  const out = sortRows([{ s: "b" }, {}, { s: "a" }], "s");
  expect(out.map((r) => r.s)).toEqual(["a", "b", undefined]);
});

test("sortRows reads a dotted path and does not mutate the input", () => {
  const input = [{ c: { name: "z" } }, { c: { name: "a" } }];
  const out = sortRows(input, "c.name");
  expect(out.map((r) => (r.c as { name: string }).name)).toEqual(["a", "z"]);
  expect((input[0].c as { name: string }).name).toBe("z"); // input untouched
});
