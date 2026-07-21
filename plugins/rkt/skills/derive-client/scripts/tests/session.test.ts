import { expect, test } from "bun:test";
import { formatAuthStatus } from "../src/lib/session";

const NOW = Date.parse("2026-07-21T12:00:00Z");

test("shows a live access-token countdown", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: "2026-07-21T12:03:42Z", refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Access token\s+expires in 3m 42s/.test(l))).toBe(true);
});

test("says expired when the token is in the past", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: "2026-07-21T11:59:00Z", refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Access token\s+expired/.test(l))).toBe(true);
});

test("prints unknown for a missing access expiry", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Access token\s+unknown/.test(l))).toBe(true);
});

test("refresh window is always unknown in Plan A", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Refresh window\s+unknown/.test(l))).toBe(true);
});

test("identity line prompts whoami when identity is null", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines[0]).toMatch(/unknown \(run whoami\)/i);
});

test("shows how long ago the browser session was saved", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: NOW - 2 * 3600_000 },
    NOW,
  );
  expect(lines.some((l) => /Browser session saved 2h ago/.test(l))).toBe(true);
});
