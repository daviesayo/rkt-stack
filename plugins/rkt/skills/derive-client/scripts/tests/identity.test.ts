import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIdentity, whoamiLine } from "../src/lib/identity";

let root: string;
const ORIG_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIG_NODE_ENV = process.env.NODE_ENV;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rkt-id-"));
  process.env.RKT_CLIENTS_ROOT = root;
  process.env.NODE_ENV = "test";
});
afterEach(async () => {
  if (ORIG_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIG_ROOT;
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
  await rm(root, { recursive: true, force: true });
});

const spec = { endpoint: "get.me", idField: "id", display: ["first_name", "email"] };

test("resolves identity from the endpoint and caches it", async () => {
  let calls = 0;
  const fetchEndpoint = async () => { calls++; return { id: 924, first_name: "Ada", email: "ada@x.test" }; };
  const first = await resolveIdentity("s", spec, fetchEndpoint);
  expect(first.id).toBe("924");
  expect(first.display.first_name).toBe("Ada");
  const second = await resolveIdentity("s", spec, fetchEndpoint);
  expect(second.id).toBe("924");
  expect(calls).toBe(1); // served from cache the second time
});

test("whoamiLine formats the display fields", () => {
  expect(whoamiLine({ first_name: "Ada", email: "ada@x.test" }, ["first_name", "email"])).toBe("Ada (ada@x.test)");
});

test("throws a clear error when the id field is absent", async () => {
  const fetchEndpoint = async () => ({ first_name: "Ada" });
  await expect(resolveIdentity("s", spec, fetchEndpoint)).rejects.toThrow(/idField 'id'/i);
});

test("invalid cache shape is treated as a miss and re-fetched", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  const { secretsDir } = await import("../src/lib/paths");
  await mkdir(secretsDir(), { recursive: true });
  await writeFile(identityCacheFile("s"), JSON.stringify({}), "utf8");
  let calls = 0;
  const fetchEndpoint = async () => { calls++; return { id: 42, first_name: "Bob" }; };
  const result = await resolveIdentity("s", spec, fetchEndpoint);
  expect(result.id).toBe("42");
  expect(calls).toBe(1);
});

test("the cache file is written at 0600", async () => {
  const { stat } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  await resolveIdentity("s", spec, async () => ({ id: 1 }));
  const info = await stat(identityCacheFile("s"));
  expect(info.mode & 0o777).toBe(0o600);
});
