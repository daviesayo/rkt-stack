import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveManifest } from "../src/derive";
import { recordingDir, secretsFile } from "../src/lib/paths";
import { writeSecret } from "../src/lib/secrets";

const SECRET = "SUPERSECRETVALUE";
let testRoot: string;
const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "rkt-leak-"));
  process.env.RKT_CLIENTS_ROOT = testRoot;
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  await rm(testRoot, { recursive: true, force: true });
});

async function stage(): Promise<string> {
  const dir = recordingDir("leaktest", "fixed");
  await mkdir(dir, { recursive: true });
  const dest = `${dir}/session.har`;
  await copyFile(`${import.meta.dir}/fixtures/authed.har`, dest);
  return dest;
}

test("the serialized manifest contains no part of the credential", async () => {
  const { manifest, secrets } = await deriveManifest(await stage(), "leaktest");
  expect(Object.values(secrets)).toContain(SECRET);

  const serialized = JSON.stringify(manifest);
  expect(serialized).not.toContain(SECRET);
  // Also catch a truncated leak.
  expect(serialized).not.toContain(SECRET.slice(0, 10));
});

test("the manifest records where the credential lives, not what it is", async () => {
  const { manifest } = await deriveManifest(await stage(), "leaktest");
  expect(manifest.auth?.location).toBe("cookie:sessionid");
  expect(JSON.stringify(manifest.auth)).not.toContain(SECRET);
});

test("the secret lands only in the secrets file", async () => {
  const { secrets } = await deriveManifest(await stage(), "leaktest");
  await writeSecret("leaktest", Object.values(secrets)[0]!);
  const stored = await readFile(secretsFile("leaktest"), "utf8");
  expect(stored).toContain(SECRET);
});
