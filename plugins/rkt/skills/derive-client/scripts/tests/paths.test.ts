import { afterEach, beforeEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  assertUnderRktRoot,
  profileDir,
  recordingDir,
  rktRoot,
  sanitizeSite,
  secretsDir,
  secretsFile,
} from "../src/lib/paths";

const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.RKT_CLIENTS_ROOT;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV;
});

test("rktRoot is absolute and under the home directory", () => {
  expect(rktRoot()).toBe(`${homedir()}/.rkt-clients`);
});

test("paths are rooted, never cwd-relative", () => {
  for (const p of [
    profileDir("example-care"),
    recordingDir("example-care", "20260720T120000Z"),
    secretsFile("example-care"),
  ]) {
    expect(p.startsWith(`${homedir()}/.rkt-clients/`)).toBe(true);
  }
});

test("recordingDir nests site and timestamp", () => {
  expect(recordingDir("example-care", "20260720T120000Z")).toBe(
    `${homedir()}/.rkt-clients/recordings/example-care/20260720T120000Z`,
  );
});

test("sanitizeSite strips path traversal and unsafe characters", () => {
  expect(sanitizeSite("../../etc/passwd")).toBe("etc-passwd");
  expect(sanitizeSite("Example Care.com")).toBe("example-care-com");
  expect(sanitizeSite("a/b")).toBe("a-b");
});

test("sanitizeSite rejects input that reduces to nothing", () => {
  expect(() => sanitizeSite("../..")).toThrow(/invalid site/i);
});

test("assertUnderRktRoot accepts paths under rktRoot", () => {
  const inside = `${rktRoot()}/recordings/example/20260720T120000Z/session.har.zip`;
  expect(assertUnderRktRoot(inside)).toBe(inside);
});

test("assertUnderRktRoot rejects paths outside rktRoot", () => {
  expect(() => assertUnderRktRoot("/tmp/session.har.zip")).toThrow(/must be under/);
});

test("RKT_CLIENTS_ROOT overrides the root under NODE_ENV=test", () => {
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(rktRoot()).toBe("/tmp/rkt-test-root");
});

test("the override is IGNORED outside a test run", () => {
  process.env.NODE_ENV = "production";
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(rktRoot()).toMatch(/\/\.rkt-clients$/);
});

test("the override is ignored when NODE_ENV is unset", () => {
  delete process.env.NODE_ENV;
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(rktRoot()).toMatch(/\/\.rkt-clients$/);
});

test("an override is resolved to an absolute path", () => {
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root/../rkt-other";
  expect(rktRoot()).toBe("/tmp/rkt-other");
});

test("an empty override falls back to the home default", () => {
  process.env.RKT_CLIENTS_ROOT = "";
  expect(rktRoot()).toMatch(/\/\.rkt-clients$/);
});

test("derived paths follow the override", () => {
  process.env.RKT_CLIENTS_ROOT = "/tmp/rkt-test-root";
  expect(secretsDir()).toBe("/tmp/rkt-test-root/secrets");
  expect(secretsFile("example-care")).toBe("/tmp/rkt-test-root/secrets/example-care.json");
});
