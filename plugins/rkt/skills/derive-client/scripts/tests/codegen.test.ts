import { expect, test } from "bun:test";
import { emitType } from "../src/lib/codegen";

test("emits an interface for a flat object", () => {
  const src = emitType(
    {
      type: "object",
      properties: { id: { type: "number" }, name: { type: "string" } },
      required: ["id", "name"],
    },
    "Roster",
  );
  expect(src).toBe(
    "export type Roster = {\n  id: number;\n  name: string;\n};\n",
  );
});

test("marks non-required properties optional", () => {
  const src = emitType(
    {
      type: "object",
      properties: { id: { type: "number" }, note: { type: "string" } },
      required: ["id"],
    },
    "Shift",
  );
  expect(src).toContain("id: number;");
  expect(src).toContain("note?: string;");
});

test("emits arrays of objects", () => {
  const src = emitType(
    {
      type: "object",
      properties: {
        shifts: {
          type: "array",
          items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
        },
      },
      required: ["shifts"],
    },
    "RosterList",
  );
  expect(src).toContain("shifts: Array<{");
  expect(src).toContain("id: number;");
});

test("emits unknown for an unknown shape", () => {
  expect(emitType({ type: "unknown" }, "Opaque")).toBe("export type Opaque = unknown;\n");
});

test("emits an empty-array element type as unknown", () => {
  const src = emitType(
    { type: "object", properties: { rows: { type: "array", items: { type: "unknown" } } }, required: ["rows"] },
    "Rows",
  );
  expect(src).toContain("rows: Array<unknown>;");
});

test("emits null-typed fields as null", () => {
  const src = emitType(
    { type: "object", properties: { endedAt: { type: "null" } }, required: ["endedAt"] },
    "Visit",
  );
  expect(src).toContain("endedAt: null;");
});

test("quotes property names that are not valid identifiers", () => {
  const src = emitType(
    { type: "object", properties: { "content-type": { type: "string" } }, required: ["content-type"] },
    "Headers",
  );
  expect(src).toContain('"content-type": string;');
});

test("a top-level array emits an array type", () => {
  const src = emitType(
    { type: "array", items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
    "Items",
  );
  expect(src.startsWith("export type Items = Array<{")).toBe(true);
});
