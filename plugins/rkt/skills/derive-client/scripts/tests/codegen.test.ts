import { expect, test } from "bun:test";
import { commandNames, emitType, typeName } from "../src/lib/codegen";
import type { ManifestEndpoint } from "../src/lib/manifest";

function ep(over: Partial<ManifestEndpoint>): ManifestEndpoint {
  return {
    id: "get.api.roster.id",
    method: "GET",
    pathTemplate: "/api/roster/{id}",
    params: [],
    responseShape: { type: "unknown" },
    source: "xhr",
    fragile: false,
    selectors: null,
    writeSemantics: null,
    ...over,
  };
}

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

test("names a GET command from its path, dropping param segments", () => {
  const names = commandNames([ep({})]);
  expect(names.get("get.api.roster.id")).toBe("api-roster");
});

test("includes the method for non-GET endpoints", () => {
  const names = commandNames([
    ep({ id: "head.api.roster.id", method: "HEAD" }),
  ]);
  expect(names.get("head.api.roster.id")).toBe("head-api-roster");
});

test("disambiguates colliding names deterministically", () => {
  const names = commandNames([
    ep({ id: "get.api.roster.id", pathTemplate: "/api/roster/{id}" }),
    ep({ id: "get.api.roster.week", pathTemplate: "/api/roster/{week}" }),
  ]);
  expect(names.get("get.api.roster.id")).toBe("api-roster");
  expect(names.get("get.api.roster.week")).toBe("api-roster-2");
});

test("a path of only params falls back to the method", () => {
  const names = commandNames([ep({ id: "get.id", pathTemplate: "/{id}" })]);
  expect(names.get("get.id")).toBe("get");
});

test("typeName converts a command to PascalCase with a Response suffix", () => {
  expect(typeName("api-roster")).toBe("ApiRosterResponse");
  expect(typeName("api-roster-2")).toBe("ApiRoster2Response");
});
