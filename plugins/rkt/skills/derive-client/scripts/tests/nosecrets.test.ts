import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateClient } from "../src/generate";
import { writeSecret } from "../src/lib/secrets";

const SECRET = "SUPERSECRETVALUE";
let workRoot: string;
const ORIGINAL_ROOT = process.env.RKT_CLIENTS_ROOT;

const MANIFEST = {
  schemaVersion: 2,
  site: "nosecrets",
  baseUrl: "https://x.test",
  recordedAt: "2026-07-20T12:00:00.000Z",
  harSha256: "deadbeef",
  userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
  clientHints: {},
  auth: { kind: "cookie", location: "cookie:sessionid", mintedBy: null, expiry: null },
  authBundle: null,
  refresh: null,
  endpoints: [
    {
      id: "get.api.roster.id",
      method: "GET",
      pathTemplate: "/api/roster/{id}",
      params: [{ name: "id", in: "path", type: "number" }],
      responseShape: { type: "unknown" },
      source: "xhr",
      fragile: false,
      selectors: null,
      writeSemantics: null,
    },
  ],
};

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "rkt-nosecret-"));
  process.env.RKT_CLIENTS_ROOT = join(workRoot, "root");
  // A real stored credential must exist, so the test proves generation does
  // not reach for it rather than passing because none was available.
  await writeSecret("nosecrets", SECRET);
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIGINAL_ROOT;
  await rm(workRoot, { recursive: true, force: true });
});

test("no generated file contains the stored credential", async () => {
  const dir = join(workRoot, "recording");
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "client.json");
  await writeFile(manifestPath, JSON.stringify(MANIFEST));

  const { written } = await generateClient(manifestPath, join(workRoot, "clients"));
  expect(written.length).toBeGreaterThan(0);

  for (const path of written) {
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain(SECRET);
    expect(contents).not.toContain(SECRET.slice(0, 10));
  }
});

test("the generated repo gitignores everything that could hold a credential", async () => {
  // Generate here rather than relying on the previous test's side effect, so
  // this passes under -t filtering and any test ordering.
  const dir = join(workRoot, "recording-gi");
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "client.json");
  await writeFile(manifestPath, JSON.stringify(MANIFEST));
  const out = join(workRoot, "clients-gi");
  await generateClient(manifestPath, out);

  const gitignore = await readFile(join(out, ".gitignore"), "utf8");
  expect(gitignore).toContain("secrets/");
  expect(gitignore).toContain("recordings/");
  // HAR files carry full session cookies wherever they land.
  expect(gitignore).toContain("*.har");
  // storageState is a serialized browser session — credential material.
  expect(gitignore).toContain("*.storage-state.json");
});
