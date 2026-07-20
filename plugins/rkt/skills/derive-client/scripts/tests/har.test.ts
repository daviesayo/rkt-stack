import { expect, test } from "bun:test";
import { readHar } from "../src/lib/har";

test("reads entries from a plain .har file", async () => {
  const entries = await readHar(`${import.meta.dir}/fixtures/sample.har`);
  expect(entries).toHaveLength(2);
});

test("normalizes headers to a lowercased map", async () => {
  const [first] = await readHar(`${import.meta.dir}/fixtures/sample.har`);
  expect(first.requestHeaders["user-agent"]).toBe("Mozilla/5.0 Chrome/141.0.0.0");
  expect(first.responseHeaders["content-type"]).toBe("application/json");
});

test("exposes method, url, status, mimeType and body", async () => {
  const [first] = await readHar(`${import.meta.dir}/fixtures/sample.har`);
  expect(first.method).toBe("GET");
  expect(first.url).toBe("https://example.test/api/v2/items/4821?week=2026-W30");
  expect(first.status).toBe(200);
  expect(first.mimeType).toBe("application/json");
  expect(first.responseBody).toBe('{"results":[{"id":1,"client":"A"}]}');
});

test("throws a clear error on a malformed HAR", async () => {
  await expect(readHar(`${import.meta.dir}/fixtures/does-not-exist.har`)).rejects.toThrow(
    /could not read HAR/i,
  );
});
