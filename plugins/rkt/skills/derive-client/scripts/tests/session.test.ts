import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, access, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

test("refresh window is unknown when there is no refresh-token expiry", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: null, storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Refresh window\s+unknown/.test(l))).toBe(true);
});

test("refresh window shows a countdown from the refresh token's own expiry", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: "2026-07-21T13:00:00Z", storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Refresh window\s+1h left/.test(l))).toBe(true);
});

test("refresh window says expired once the refresh token is past", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: "2026-07-21T11:00:00Z", storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Refresh window\s+expired/.test(l))).toBe(true);
});

test("refresh window says does not expire for an offline (exp:0) token", () => {
  const lines = formatAuthStatus(
    { identity: null, accessExpiry: null, refreshWindow: "1970-01-01T00:00:00.000Z", storageStateMtime: null },
    NOW,
  );
  expect(lines.some((l) => /Refresh window\s+does not expire/.test(l))).toBe(true);
});

test("deriveExpiries separates the access-credential expiry from the refresh token's", async () => {
  const { deriveExpiries } = await import("../src/lib/session");
  const meta = {
    values: {},
    storedAt: null,
    expiry: { "cookie:tok": "2026-07-21T12:05:00Z", "@refresh_token": "2026-07-21T13:00:00Z" },
  };
  expect(deriveExpiries(meta)).toEqual({
    accessExpiry: "2026-07-21T12:05:00Z",
    refreshExpiry: "2026-07-21T13:00:00Z",
  });
});

test("deriveExpiries never treats the refresh token as the access expiry", async () => {
  const { deriveExpiries } = await import("../src/lib/session");
  const meta = {
    values: {},
    storedAt: null,
    expiry: { "@refresh_token": "2026-07-21T13:00:00Z", "cookie:sid": null },
  };
  expect(deriveExpiries(meta)).toEqual({ accessExpiry: null, refreshExpiry: "2026-07-21T13:00:00Z" });
});

test("deriveExpiries is all-null when nothing is stored", async () => {
  const { deriveExpiries } = await import("../src/lib/session");
  expect(deriveExpiries(null)).toEqual({ accessExpiry: null, refreshExpiry: null });
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

test("login stores a harvested refresh token under the reserved key", async () => {
  const { loginSite } = await import("../src/lib/session");
  const { readSecrets, REFRESH_TOKEN_KEY } = await import("../src/lib/secrets");
  await loginSite("s", "https://app.test/", {
    launch: async ({ statePath }) => {
      await writeFile(statePath, "{}");
      return { values: { "cookie:sid": "abc", [REFRESH_TOKEN_KEY]: "rt-value" } };
    },
  });
  expect((await readSecrets("s"))?.[REFRESH_TOKEN_KEY]).toBe("rt-value");
});

test("runLifecycle login hands the launcher the OIDC token endpoint to harvest the refresh token", async () => {
  const { runLifecycle } = await import("../src/lib/session");
  const manifest = {
    schemaVersion: 2, site: "s", baseUrl: "https://api.example.test", recordedAt: "", harSha256: "",
    userAgent: "", clientHints: {}, auth: null,
    authBundle: {
      credentials: [{ location: "cookie:sid", kind: "cookie", mintedBy: null, expiry: null }],
      earliestExpiry: null,
    },
    refresh: {
      kind: "oidc", tokenEndpoint: "https://idp/realms/x/protocol/openid-connect/token",
      clientId: "public", accessTokenCookie: null, expiresIn: 300, refreshExpiresIn: 3600,
    },
    endpoints: [],
  };
  const mpath = join(root, "client.json");
  await writeFile(mpath, JSON.stringify(manifest));
  let seen: { tokenEndpoint: string | null } | undefined;
  await runLifecycle("login", undefined, mpath, {
    launch: async (args) => {
      seen = args;
      await writeFile(args.statePath, "{}");
      return { values: {} };
    },
  });
  expect(seen?.tokenEndpoint).toBe("https://idp/realms/x/protocol/openid-connect/token");
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

import { symlink as symlinkFs, readlink } from "node:fs/promises";

async function stubClient(): Promise<{ dir: string; cliPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rkt-client-"));
  const cliPath = join(dir, "cli.ts");
  await writeFile(cliPath, "// stub cli\n");
  return { dir, cliPath };
}

test("install symlinks the launcher and makes the cli executable", async () => {
  const { installLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));

  const res = await installLauncher({ cliPath, defaultName: "example", binDir, pathEnv: binDir });

  expect(res.name).toBe("example");
  expect(res.target).toBe(join(binDir, "example"));
  expect(await readlink(res.target)).toBe(cliPath);
  expect((await stat(cliPath)).mode & 0o111).not.toBe(0); // executable bit set
  expect(res.pathHint).toBeNull(); // binDir is on pathEnv
});

test("install --name overrides the default launcher name", async () => {
  const { installLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  const res = await installLauncher({ cliPath, defaultName: "kirinari-example", name: "ex", binDir });
  expect(res.name).toBe("ex");
  expect(await readlink(join(binDir, "ex"))).toBe(cliPath);
});

test("install rejects a name outside the allowed charset", async () => {
  const { installLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  await expect(
    installLauncher({ cliPath, defaultName: "bad/name", binDir }),
  ).rejects.toThrow(/lowercase letters, digits, and hyphens/);
});

test("install refuses to clobber an unrelated target without --force", async () => {
  const { installLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  await writeFile(join(binDir, "example"), "#!/bin/sh\necho real binary\n");
  await expect(
    installLauncher({ cliPath, defaultName: "example", binDir }),
  ).rejects.toThrow(/--force/);
});

test("install --force replaces an unrelated target", async () => {
  const { installLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  await writeFile(join(binDir, "example"), "#!/bin/sh\necho real binary\n");
  const res = await installLauncher({ cliPath, defaultName: "example", force: true, binDir });
  expect(await readlink(res.target)).toBe(cliPath);
});

test("install is idempotent when the target already points at this cli", async () => {
  const { installLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  await symlinkFs(cliPath, join(binDir, "example"));
  const res = await installLauncher({ cliPath, defaultName: "example", binDir }); // no --force
  expect(await readlink(res.target)).toBe(cliPath);
});

test("install returns a PATH hint only when the bin dir is off PATH", async () => {
  const { installLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  const off = await installLauncher({ cliPath, defaultName: "example", binDir, pathEnv: "/usr/bin" });
  expect(off.pathHint).toBe(`export PATH="${binDir}:$PATH"`);
});

test("launcherBinDir honors RKT_BIN_DIR then falls back to ~/.local/bin", async () => {
  const { launcherBinDir } = await import("../src/lib/session");
  const prev = process.env.RKT_BIN_DIR;
  process.env.RKT_BIN_DIR = "/tmp/custom-bin";
  expect(launcherBinDir()).toBe("/tmp/custom-bin");
  delete process.env.RKT_BIN_DIR;
  expect(launcherBinDir()).toBe(`${homedir()}/.local/bin`);
  if (prev === undefined) delete process.env.RKT_BIN_DIR;
  else process.env.RKT_BIN_DIR = prev;
});

test("uninstall removes only links pointing at this cli, leaving others intact", async () => {
  const { installLauncher, uninstallLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const other = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));

  await installLauncher({ cliPath, defaultName: "example", binDir });
  await installLauncher({ cliPath, defaultName: "example", name: "ex-alias", binDir });
  await symlinkFs(other.cliPath, join(binDir, "other-client")); // unrelated link
  await writeFile(join(binDir, "realbin"), "#!/bin/sh\n"); // unrelated real file

  const { removed, reinstall } = await uninstallLauncher({ cliPath, binDir });

  expect(removed).toEqual(["ex-alias", "example"]); // sorted
  expect(reinstall).toBe(`bun ${cliPath} install`);
  await expect(access(join(binDir, "other-client"))).resolves.toBeNull(); // Bun's fs.access resolves null, not undefined
  await expect(access(join(binDir, "realbin"))).resolves.toBeNull();
  await expect(access(join(binDir, "example"))).rejects.toThrow();
});

test("uninstall leaves the derived client on disk", async () => {
  const { installLauncher, uninstallLauncher } = await import("../src/lib/session");
  const { dir, cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  await installLauncher({ cliPath, defaultName: "example", binDir });
  await uninstallLauncher({ cliPath, binDir });
  await expect(access(cliPath)).resolves.toBeNull(); // Bun's fs.access resolves null, not undefined
  await expect(access(dir)).resolves.toBeNull();
});

test("uninstall is a no-op with a reinstall hint when nothing matches", async () => {
  const { uninstallLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  const { removed, reinstall } = await uninstallLauncher({ cliPath, binDir });
  expect(removed).toEqual([]);
  expect(reinstall).toBe(`bun ${cliPath} install`);
});

test("uninstall returns empty when the bin dir does not exist", async () => {
  const { uninstallLauncher } = await import("../src/lib/session");
  const { cliPath } = await stubClient();
  const { removed } = await uninstallLauncher({ cliPath, binDir: join(tmpdir(), "rkt-does-not-exist-xyz") });
  expect(removed).toEqual([]);
});
