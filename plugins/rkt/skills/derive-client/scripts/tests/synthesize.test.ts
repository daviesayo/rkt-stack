import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { groupEndpoints, templatePath } from "../src/lib/synthesize";

function entry(url: string, method = "GET"): HarEntry {
  return {
    method,
    url,
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: "{}",
    postData: null,
    startedDateTime: "2026-07-20T12:00:00.000Z",
  };
}

test("templatePath replaces a numeric segment that varies", () => {
  expect(templatePath(["/api/items/4821", "/api/items/9002"])).toBe("/api/items/{id}");
});

test("templatePath keeps a segment that never varies", () => {
  expect(templatePath(["/api/items/list", "/api/items/list"])).toBe("/api/items/list");
});

test("templatePath replaces a varying UUID segment", () => {
  expect(
    templatePath([
      "/api/shift/1597d3a7-ed69-4f80-9c2c-2f5627ba24c2",
      "/api/shift/2a0b9c11-0000-4f80-9c2c-2f5627ba24c2",
    ]),
  ).toBe("/api/shift/{id}");
});

test("templatePath does not template a single observation", () => {
  expect(templatePath(["/api/items/4821"])).toBe("/api/items/4821");
});

test("templatePath numbers multiple varying segments distinctly", () => {
  expect(templatePath(["/api/client/12/visit/34", "/api/client/56/visit/78"])).toBe(
    "/api/client/{id}/visit/{id2}",
  );
});

test("groupEndpoints groups by method plus template and collects samples", () => {
  const groups = groupEndpoints([
    entry("https://example.test/api/items/4821?week=2026-W30"),
    entry("https://example.test/api/items/9002?week=2026-W31"),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].pathTemplate).toBe("/api/items/{id}");
  expect(groups[0].origin).toBe("https://example.test");
  expect(groups[0].samples).toHaveLength(2);
});

test("groupEndpoints separates different methods on the same path", () => {
  const groups = groupEndpoints([
    entry("https://example.test/api/note/1", "GET"),
    entry("https://example.test/api/note/2", "POST"),
  ]);
  expect(groups).toHaveLength(2);
});

test("groupEndpoints infers path and query params with types", () => {
  const [group] = groupEndpoints([
    entry("https://example.test/api/items/4821?week=2026-W30&limit=50"),
    entry("https://example.test/api/items/9002?week=2026-W31&limit=25"),
  ]);
  const byName = Object.fromEntries(group.params.map((p) => [p.name, p]));
  expect(byName.id).toMatchObject({ name: "id", in: "path", type: "number", required: true });
  expect(byName.week).toMatchObject({ name: "week", in: "query", type: "string", required: true });
  expect(byName.limit).toMatchObject({ name: "limit", in: "query", type: "number", required: true });
  // Recorded values ride along so a caller can invoke the endpoint as-is.
  expect(byName.id.example).toBe("4821");
  expect(byName.week.example).toBe("2026-W30");
});
