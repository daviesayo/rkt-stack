import { expect, test } from "bun:test";
import type { HarEntry } from "../src/lib/har";
import { filterEntries } from "../src/lib/filter";

function entry(over: Partial<HarEntry>): HarEntry {
  return {
    method: "GET",
    url: "https://example.test/api/thing",
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "application/json",
    responseBody: "{}",
    postData: null,
    startedDateTime: "2026-07-20T12:00:00.000Z",
    ...over,
  };
}

test("keeps JSON API responses", () => {
  const { kept } = filterEntries([entry({})]);
  expect(kept).toHaveLength(1);
});

test("keeps HTML documents, which may carry scrape-only data", () => {
  const { kept } = filterEntries([
    entry({ mimeType: "text/html", url: "https://example.test/page" }),
  ]);
  expect(kept).toHaveLength(1);
});

test("drops static assets by mime type", () => {
  const { kept, dropped } = filterEntries([
    entry({ mimeType: "application/javascript", url: "https://example.test/app.js" }),
    entry({ mimeType: "image/png", url: "https://example.test/logo.png" }),
    entry({ mimeType: "text/css", url: "https://example.test/app.css" }),
    entry({ mimeType: "font/woff2", url: "https://example.test/f.woff2" }),
  ]);
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(4);
  expect(dropped[0].reason).toMatch(/static asset/i);
});

test("drops known analytics hosts even when they return JSON", () => {
  const { kept, dropped } = filterEntries([
    entry({ url: "https://www.google-analytics.com/collect" }),
    entry({ url: "https://api.segment.io/v1/track" }),
    entry({ url: "https://us.i.posthog.com/e/" }),
  ]);
  expect(kept).toHaveLength(0);
  expect(dropped.every((d) => /analytics/i.test(d.reason))).toBe(true);
});

test("drops non-success responses, which teach nothing about shape", () => {
  const { kept, dropped } = filterEntries([entry({ status: 404, responseBody: "not found" })]);
  expect(kept).toHaveLength(0);
  expect(dropped[0].reason).toMatch(/status/i);
});

test("drops entries with no response body", () => {
  const { kept } = filterEntries([entry({ responseBody: null })]);
  expect(kept).toHaveLength(0);
});

test("read mode drops write methods", () => {
  const { kept, dropped } = filterEntries([
    entry({ method: "GET" }),
    entry({ method: "POST" }),
    entry({ method: "PUT" }),
    entry({ method: "PATCH" }),
    entry({ method: "DELETE" }),
  ]);
  expect(kept).toHaveLength(1);
  expect(kept[0].method).toBe("GET");
  expect(dropped).toHaveLength(4);
  expect(dropped[0].reason).toMatch(/write method/i);
});

test("read mode keeps HEAD", () => {
  const { kept } = filterEntries([entry({ method: "HEAD" })]);
  expect(kept).toHaveLength(1);
});

test("method matching is case-insensitive", () => {
  const { kept } = filterEntries([entry({ method: "get" })]);
  expect(kept).toHaveLength(1);
});

test("allowWrites keeps write methods for full mode", () => {
  const { kept } = filterEntries(
    [entry({ method: "GET" }), entry({ method: "DELETE" })],
    { allowWrites: true },
  );
  expect(kept).toHaveLength(2);
});

test("keeps a 204 write with no body and no content-type when writes are allowed", () => {
  const entries = [
    {
      url: "https://x.test/api/events/1",
      method: "DELETE",
      status: 204,
      mimeType: "",
      responseBody: "",
      postData: null,
      startedDateTime: "2026-07-24T00:00:00.000Z",
      requestHeaders: {},
    },
  ] as never;
  const { kept, dropped } = filterEntries(entries, { allowWrites: true });
  expect(kept).toHaveLength(1);
  expect(dropped).toHaveLength(0);
});

test("still drops a read with an empty body", () => {
  const entries = [
    {
      url: "https://x.test/api/thing",
      method: "GET",
      status: 200,
      mimeType: "application/json",
      responseBody: "",
      postData: null,
      startedDateTime: "2026-07-24T00:00:00.000Z",
      requestHeaders: {},
    },
  ] as never;
  expect(filterEntries(entries, { allowWrites: true }).kept).toHaveLength(0);
});
