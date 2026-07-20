import { expect, test } from "bun:test";
import { inferShape } from "../src/lib/synthesize";

test("infers a flat object with scalar types", () => {
  expect(inferShape(['{"id":1,"name":"A","active":true}'])).toEqual({
    type: "object",
    properties: {
      id: { type: "number" },
      name: { type: "string" },
      active: { type: "boolean" },
    },
    required: ["id", "name", "active"],
  });
});

test("infers arrays from their first element", () => {
  expect(inferShape(['{"shifts":[{"id":1}]}'])).toEqual({
    type: "object",
    properties: {
      shifts: {
        type: "array",
        items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      },
    },
    required: ["shifts"],
  });
});

test("a field missing from one sample becomes optional", () => {
  const shape = inferShape(['{"id":1,"note":"x"}', '{"id":2}']);
  expect(shape).toEqual({
    type: "object",
    properties: { id: { type: "number" }, note: { type: "string" } },
    required: ["id"],
  });
});

test("an empty array yields unknown items rather than guessing", () => {
  expect(inferShape(['{"rows":[]}'])).toEqual({
    type: "object",
    properties: { rows: { type: "array", items: { type: "unknown" } } },
    required: ["rows"],
  });
});

test("a top-level array is supported", () => {
  expect(inferShape(['[{"id":1}]'])).toEqual({
    type: "array",
    items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  });
});

test("non-JSON bodies yield unknown instead of throwing", () => {
  expect(inferShape(["<html></html>"])).toEqual({ type: "unknown" });
});

test("null values are typed as null, not dropped", () => {
  expect(inferShape(['{"endedAt":null}'])).toEqual({
    type: "object",
    properties: { endedAt: { type: "null" } },
    required: ["endedAt"],
  });
});
