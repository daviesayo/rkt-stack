import { expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  profileDir,
  recordingDir,
  rktRoot,
  sanitizeSite,
  secretsFile,
} from "../src/lib/paths";

test("rktRoot is absolute and under the home directory", () => {
  expect(rktRoot()).toBe(`${homedir()}/.rkt-clients`);
});

test("paths are rooted, never cwd-relative", () => {
  for (const p of [
    profileDir("alayacare"),
    recordingDir("alayacare", "20260720T120000Z"),
    secretsFile("alayacare"),
  ]) {
    expect(p.startsWith(`${homedir()}/.rkt-clients/`)).toBe(true);
  }
});

test("recordingDir nests site and timestamp", () => {
  expect(recordingDir("alayacare", "20260720T120000Z")).toBe(
    `${homedir()}/.rkt-clients/recordings/alayacare/20260720T120000Z`,
  );
});

test("sanitizeSite strips path traversal and unsafe characters", () => {
  expect(sanitizeSite("../../etc/passwd")).toBe("etc-passwd");
  expect(sanitizeSite("Alaya Care.com")).toBe("alaya-care-com");
  expect(sanitizeSite("a/b")).toBe("a-b");
});

test("sanitizeSite rejects input that reduces to nothing", () => {
  expect(() => sanitizeSite("../..")).toThrow(/invalid site/i);
});
