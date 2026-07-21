import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAuthStatus, logoutSite, readIdentityLabel } from "../src/lib/session";

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

let root: string;
const ORIG_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIG_NODE_ENV = process.env.NODE_ENV;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rkt-logout-"));
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

test("logout removes the secrets, storage-state, and identity files that exist", async () => {
  const { identityCacheFile } = await import("../src/lib/session");
  const { secretsFile, storageStateFile } = await import("../src/lib/paths");
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(secretsFile("s"), "{}");
  await writeFile(storageStateFile("s"), "{}");
  await writeFile(identityCacheFile("s"), "{}");
  const { removed } = await logoutSite("s");
  expect(removed).toContain(secretsFile("s"));
  expect(removed).toContain(storageStateFile("s"));
  expect(removed).toContain(identityCacheFile("s"));
  await expect(access(secretsFile("s"))).rejects.toThrow();
  await expect(access(storageStateFile("s"))).rejects.toThrow();
  await expect(access(identityCacheFile("s"))).rejects.toThrow();
});

test("logout is a no-op when nothing is stored", async () => {
  const { removed } = await logoutSite("never");
  expect(removed).toEqual([]);
});

test("login clears the identity cache and delegates to the launcher", async () => {
  const { identityCacheFile, loginSite } = await import("../src/lib/session");
  const { secretsDir } = await import("../src/lib/paths");
  await mkdir(secretsDir(), { recursive: true });
  await writeFile(identityCacheFile("s"), "{}");

  let called = false;
  const ok = await loginSite("s", "https://app.test/", {
    launch: async ({ statePath }) => {
      called = true;
      await writeFile(statePath, "{}");
      return { values: {} };
    },
  });
  expect(ok).toBe(true);
  expect(called).toBe(true);
  await expect(access(identityCacheFile("s"))).rejects.toThrow();
});

test("login creates secrets dir at 0700 and storage state at 0600", async () => {
  const { loginSite } = await import("../src/lib/session");
  const { secretsDir, storageStateFile } = await import("../src/lib/paths");

  await loginSite("s", "https://app.test/", {
    launch: async ({ statePath }) => {
      await writeFile(statePath, "{}");
      return { values: {} };
    },
  });

  expect((await stat(secretsDir())).mode & 0o777).toBe(0o700);
  expect((await stat(storageStateFile("s"))).mode & 0o777).toBe(0o600);
});

test("login writes the harvested credential bundle so the very next command authenticates", async () => {
  const { loginSite } = await import("../src/lib/session");
  const { readSecrets } = await import("../src/lib/secrets");
  const ok = await loginSite("s", "https://app.test/", {
    wanted: [
      { location: "cookie:sid", kind: "cookie" },
      { location: "x-csrf-token", kind: "csrf" },
    ],
    launch: async ({ statePath }) => {
      await writeFile(statePath, "{}");
      return { values: { "cookie:sid": "abc", "x-csrf-token": "tok" } };
    },
  });
  expect(ok).toBe(true);
  expect(await readSecrets("s")).toEqual({ "cookie:sid": "abc", "x-csrf-token": "tok" });
});

test("login returns false and writes no secret when the launcher cannot complete", async () => {
  const { loginSite } = await import("../src/lib/session");
  const { readSecrets } = await import("../src/lib/secrets");
  const ok = await loginSite("s", "https://app.test/", { launch: async () => null });
  expect(ok).toBe(false);
  expect(await readSecrets("s")).toBeNull();
});

test("runLifecycle login hands the launcher the manifest's wanted creds and api host", async () => {
  const { runLifecycle } = await import("../src/lib/session");
  const manifest = {
    schemaVersion: 2, site: "s", baseUrl: "https://api.example.test", recordedAt: "", harSha256: "",
    userAgent: "", clientHints: {}, auth: null,
    authBundle: {
      credentials: [
        { location: "cookie:sid", kind: "cookie", mintedBy: null, expiry: null },
        { location: "x-csrf-token", kind: "csrf", mintedBy: null, expiry: null },
      ],
      earliestExpiry: null,
    },
    refresh: null, endpoints: [],
  };
  const mpath = join(root, "client.json");
  await writeFile(mpath, JSON.stringify(manifest));
  let seen: { wanted: Array<{ location: string }>; apiHost: string | null } | undefined;
  await runLifecycle("login", undefined, mpath, {
    launch: async (args) => {
      seen = args;
      await writeFile(args.statePath, "{}");
      return { values: {} };
    },
  });
  expect(seen?.apiHost).toBe("api.example.test");
  expect(seen?.wanted.map((w) => w.location).sort()).toEqual(["cookie:sid", "x-csrf-token"]);
});

test("readIdentityLabel returns the cached label, or null when absent", async () => {
  const { writeFile, mkdir, chmod } = await import("node:fs/promises");
  const { identityCacheFile } = await import("../src/lib/session");
  const { secretsDir } = await import("../src/lib/paths");
  expect(await readIdentityLabel("nobody")).toBeNull();
  await mkdir(secretsDir(), { recursive: true, mode: 0o700 });
  await chmod(secretsDir(), 0o700);
  await writeFile(identityCacheFile("someone"), JSON.stringify({ id: "1", display: {}, label: "Ada (ada@x.test)" }), { mode: 0o600 });
  expect(await readIdentityLabel("someone")).toBe("Ada (ada@x.test)");
});
