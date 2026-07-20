import { expect, test } from "bun:test";
import { formatDryRunPreview, parseParams } from "../src/call";
import { redact } from "../src/lib/secrets";

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

test("dry-run preview masks secrets that JSON would escape", () => {
  const secret = 'sid=va"lue\\tail';
  const preview = formatDryRunPreview(
    {
      method: "GET",
      url: "https://x.test/api/me",
      headers: { cookie: secret, accept: "application/json" },
    },
    secret,
  );
  expect(preview).not.toContain(secret);
  expect(preview).toContain("[REDACTED]");
});

test("success response body redacts echoed credentials", () => {
  const secret = "s3cr3tvalue";
  const body = JSON.stringify({ token: secret });
  expect(redact(body, secret)).not.toContain(secret);
  expect(redact(body, secret)).toContain("[REDACTED]");
});
