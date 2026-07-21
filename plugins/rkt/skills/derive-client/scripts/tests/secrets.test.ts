import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSecret,
  readSecretMeta,
  readSecrets,
  redact,
  maskHeaders,
  writeSecret,
} from "../src/lib/secrets";

let testRoot: string;
const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "rkt-secrets-"));
  process.env.RKT_CLIENTS_ROOT = testRoot;
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  await rm(testRoot, { recursive: true, force: true });
});

test("round-trips a secret", async () => {
  await writeSecret("example", "Bearer abc.def");
  expect(await readSecret("example")).toBe("Bearer abc.def");
});

test("the secrets file is mode 0600", async () => {
  await writeSecret("example", "s3cr3tvalue");
  const info = await stat(`${testRoot}/secrets/example.json`);
  expect(info.mode & 0o777).toBe(0o600);
});

test("the secrets directory is mode 0700", async () => {
  await writeSecret("example", "s3cr3tvalue");
  const info = await stat(`${testRoot}/secrets`);
  expect(info.mode & 0o777).toBe(0o700);
});

test("reading an unknown site returns null rather than throwing", async () => {
  expect(await readSecret("never-written")).toBeNull();
});

test("overwriting a world-readable file never leaves it world-readable", async () => {
  // Simulate a pre-existing loose-permission file: the case a plain
  // writeFile({mode}) silently fails to tighten.
  const path = `${testRoot}/secrets/loose.json`;
  await writeSecret("loose", "firstvalue");
  await chmod(path, 0o644);

  await writeSecret("loose", "secondvalue");
  const info = await stat(path);
  expect(info.mode & 0o777).toBe(0o600);
  expect(await readSecret("loose")).toBe("secondvalue");
});

test("no temp file is left behind after a write", async () => {
  await writeSecret("example", "s3cr3tvalue");
  const files = await readdir(`${testRoot}/secrets`);
  expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
});

test("redact replaces every occurrence of the secret", () => {
  expect(redact("token=s3cr3t and again s3cr3t", "s3cr3t")).toBe(
    "token=[REDACTED] and again [REDACTED]",
  );
});

test("redact is a no-op when there is no secret", () => {
  expect(redact("nothing sensitive", null)).toBe("nothing sensitive");
});

test("redact also masks the bare token inside a scheme-prefixed value", () => {
  expect(redact("Authorization: Bearer abc.def", "Bearer abc.def")).toBe(
    "Authorization: [REDACTED]",
  );
  expect(redact("raw abc.def leaked", "Bearer abc.def")).toBe("raw [REDACTED] leaked");
});

test("maskHeaders redacts cookie values before JSON escaping can hide them", () => {
  const secret = 'va"lue\\tail';
  const masked = maskHeaders({ cookie: `sessionid=${secret}` }, secret);
  expect(masked.cookie).toBe("sessionid=[REDACTED]");
  const serialized = JSON.stringify(masked, null, 2);
  expect(serialized).not.toContain(secret);
  expect(serialized).toContain("[REDACTED]");
});

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

test("readSecretMeta decodes a JWT value's expiry", async () => {
  const exp = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
  await writeSecret("metatest", { "cookie:token": jwt({ exp }) });
  const meta = await readSecretMeta("metatest");
  expect(meta?.expiry["cookie:token"]).toBe("2026-08-01T00:00:00.000Z");
});

test("readSecretMeta reports null expiry for a non-JWT value", async () => {
  await writeSecret("metatest2", { "cookie:sid": "opaquevalue" });
  const meta = await readSecretMeta("metatest2");
  expect(meta?.expiry["cookie:sid"]).toBeNull();
});

test("readSecretMeta exposes storedAt", async () => {
  await writeSecret("metatest3", { "cookie:sid": "opaquevalue" });
  const meta = await readSecretMeta("metatest3");
  expect(typeof meta?.storedAt).toBe("string");
});

test("readSecrets still returns just the values for existing callers", async () => {
  await writeSecret("metatest4", { "cookie:sid": "opaquevalue" });
  expect(await readSecrets("metatest4")).toEqual({ "cookie:sid": "opaquevalue" });
});
