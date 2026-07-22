# derive-client Install / Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user put a derived client's CLI on their PATH with one command (`install`) and remove that launcher without deleting the client (`uninstall`).

**Architecture:** The generated `cli.ts` gets a `#!/usr/bin/env bun` shebang so it can be executed via a symlink. Two argv-free core functions in the shared `session.ts` create and remove that symlink; `runLifecycle` exposes them as `install` / `uninstall` so both emitted CLI variants inherit them. `generate.ts` emits a thin `install.sh` bootstrap. The client on disk is the durable artifact; the launcher is a disposable shortcut.

**Tech Stack:** Bun 1.3.x, TypeScript strict, `bun test`, POSIX symlinks (darwin).

**Spec:** `docs/specs/2026-07-22-derive-client-install-uninstall-design.md`

**Working directory for all commands:** `plugins/rkt/skills/derive-client/scripts` (call it `$S`). Absolute: `/Users/rocket/Documents/Repositories/rkt-stack/plugins/rkt/skills/derive-client/scripts`.

**Branch:** `feat/derive-client-install-uninstall` (already created; the spec is committed on it as `8391a5d`).

## Global Constraints

- **Bun + TS strict.** Every task ends green on `bun test` and `bunx tsc --noEmit` run from `$S`.
- **Host safety, non-negotiable.** Never modify a shell profile. PATH help is *printed* only. There is no code path that writes to `~/.zshrc`, `~/.bashrc`, or any profile.
- **Confinement.** Launcher name must match `^[a-z0-9-]+$`. This blocks `/` and `..`, so the launcher is always a direct child of the bin directory.
- **No silent clobber.** A pre-existing non-matching target requires `--force`.
- **Uninstall preserves the client.** It only removes bin-directory symlinks whose realpath equals this client's `cli.ts`. It never touches the client directory or `~/.rkt-clients`.
- **No vendor names in generic code.** `install.sh` and all `src/` code stay site-agnostic (no "alayacare", no client-specific strings).
- **Bin directory:** `process.env.RKT_BIN_DIR || ${homedir()}/.local/bin`. NOT gated by `NODE_ENV` (it is a symlink location, not the credential boundary).
- **Conventional Commits**, each ending with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Docs in the same commit as the code they describe** (CHANGELOG in Task 4, SKILL.md in Task 5).
- **Darwin only.** Do not build Windows launcher support; note the limitation in SKILL.md.

---

### Task 1: Shebang on the emitted CLI

**Files:**
- Modify: `src/lib/codegen.ts` (the `emitCli` function, around lines 105-115)
- Test: `tests/codegen.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `emitCli(manifest, commands?)` output now begins with `#!/usr/bin/env bun\n`. `emitTypes` output is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/codegen.test.ts`. It reuses the file's existing `ep()` helper and `ClientManifest` import.

```ts
function manifestWith(endpoints: ManifestEndpoint[]): ClientManifest {
  return {
    schemaVersion: 2,
    site: "example",
    baseUrl: "https://x.test",
    recordedAt: "2026-07-20T12:00:00.000Z",
    harSha256: "deadbeef",
    userAgent: "Mozilla/5.0 Chrome/141.0.0.0",
    clientHints: {},
    auth: null,
    authBundle: null,
    refresh: null,
    endpoints,
  } as ClientManifest;
}

test("emitted CLI starts with a bun shebang so a symlink can execute it", () => {
  const src = emitCli(manifestWith([ep({})]));
  expect(src.startsWith("#!/usr/bin/env bun\n")).toBe(true);
});

test("the types file is not executable and carries no shebang", () => {
  const src = emitTypes(manifestWith([ep({})]));
  expect(src.startsWith("#!")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/codegen.test.ts`
Expected: FAIL on "emitted CLI starts with a bun shebang" (output starts with `// GENERATED`, not the shebang).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/codegen.ts`, change `emitCli` to prepend the shebang in the shared wrapper, so both the task and endpoint variants inherit it:

```ts
export function emitCli(manifest: ClientManifest, commands?: CommandsFile): string {
  for (const endpoint of manifest.endpoints) {
    if (!READ_METHODS.has(endpoint.method.toUpperCase())) {
      throw new Error(
        `cannot generate ${endpoint.method} ${endpoint.pathTemplate}: read mode emits GET and HEAD only`,
      );
    }
  }
  const body = commands ? emitTaskCli(manifest, commands) : emitEndpointCli(manifest);
  return `#!/usr/bin/env bun\n${body}`;
}
```

Leave `emitTaskCli` and `emitEndpointCli` bodies unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/codegen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "$S" && git add src/lib/codegen.ts tests/codegen.test.ts
git commit -m "feat(derive-client): add bun shebang to generated CLI

So the cli.ts can be run through a PATH symlink.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `launcherBinDir` and `installLauncher`

**Files:**
- Modify: `src/lib/session.ts` (imports at top; add exports near the other exported functions, e.g. after `loginSite`)
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `launcherBinDir(): string`
  - `interface InstallResult { name: string; target: string; pathHint: string | null }`
  - `installLauncher(opts: { cliPath: string; defaultName: string; name?: string; force?: boolean; binDir?: string; pathEnv?: string }): Promise<InstallResult>`

- [ ] **Step 1: Write the failing test**

Add to `tests/session.test.ts`. These pass `binDir` and `cliPath` explicitly, so they need no env or argv. Put a small helper at the top of the new block:

```ts
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
```

Add `homedir` to the test's imports: `import { homedir } from "node:os";` (or reference via a dynamic import). The existing test file already imports `mkdtemp`, `writeFile`, `stat`, `join`, `tmpdir`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session.test.ts`
Expected: FAIL — `installLauncher` / `launcherBinDir` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/session.ts`, extend the `node:fs/promises` import (line 1) and add `node:os` / `node:path` imports:

```ts
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
```

Add these exports (place them after `loginSite`, before `runLifecycle`):

```ts
const LAUNCHER_NAME = /^[a-z0-9-]+$/;

/**
 * Where the CLI launcher symlink is created. RKT_BIN_DIR overrides for tests
 * and power users. Unlike rktRoot(), this is NOT gated by NODE_ENV: it holds a
 * symlink, not credential files, so it is safe to redirect in any environment.
 */
export function launcherBinDir(): string {
  const override = process.env.RKT_BIN_DIR;
  if (override && override.length > 0) return override;
  return `${homedir()}/.local/bin`;
}

export interface InstallResult {
  name: string;
  target: string;
  pathHint: string | null;
}

/**
 * Create a launcher symlink `<binDir>/<name> -> cliPath`, chmod the cli
 * executable, and report whether the bin dir needs adding to PATH. Refuses to
 * overwrite anything that is not already a link to this same cli, unless force.
 */
export async function installLauncher(opts: {
  cliPath: string;
  defaultName: string;
  name?: string;
  force?: boolean;
  binDir?: string;
  pathEnv?: string;
}): Promise<InstallResult> {
  const name = opts.name ?? opts.defaultName;
  if (!LAUNCHER_NAME.test(name)) {
    throw new Error(
      `invalid launcher name ${JSON.stringify(name)}: use only lowercase letters, digits, and hyphens`,
    );
  }
  const binDir = opts.binDir ?? launcherBinDir();
  const target = join(binDir, name);
  await mkdir(binDir, { recursive: true });

  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (existing) {
    if (existing.isDirectory()) {
      throw new Error(`${target} is a directory; remove it and retry`);
    }
    let pointsHere = false;
    if (existing.isSymbolicLink()) {
      try {
        pointsHere = (await realpath(target)) === (await realpath(opts.cliPath));
      } catch {
        pointsHere = false; // broken link
      }
    }
    if (!pointsHere && !opts.force) {
      throw new Error(
        `${target} already exists and does not point at this client; pass --force to replace it`,
      );
    }
    await unlink(target);
  }

  await chmod(opts.cliPath, 0o755);
  await symlink(opts.cliPath, target);

  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const onPath = pathEnv.split(":").includes(binDir);
  const pathHint = onPath ? null : `export PATH="${binDir}:$PATH"`;

  return { name, target, pathHint };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd "$S" && git add src/lib/session.ts tests/session.test.ts
git commit -m "feat(derive-client): installLauncher creates a PATH symlink

Refuses to clobber non-matching targets without --force; prints a PATH
hint, never edits the shell profile.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `uninstallLauncher`

**Files:**
- Modify: `src/lib/session.ts` (add `readdir` to the fs import; add the export next to `installLauncher`)
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `launcherBinDir` (Task 2).
- Produces:
  - `interface UninstallResult { removed: string[]; reinstall: string }`
  - `uninstallLauncher(opts: { cliPath: string; binDir?: string }): Promise<UninstallResult>`

- [ ] **Step 1: Write the failing test**

Add to `tests/session.test.ts` (reuses `stubClient` from Task 2):

```ts
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
  await expect(access(join(binDir, "other-client"))).resolves.toBeUndefined();
  await expect(access(join(binDir, "realbin"))).resolves.toBeUndefined();
  await expect(access(join(binDir, "example"))).rejects.toThrow();
});

test("uninstall leaves the derived client on disk", async () => {
  const { installLauncher, uninstallLauncher } = await import("../src/lib/session");
  const { dir, cliPath } = await stubClient();
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  await installLauncher({ cliPath, defaultName: "example", binDir });
  await uninstallLauncher({ cliPath, binDir });
  await expect(access(cliPath)).resolves.toBeUndefined();
  await expect(access(dir)).resolves.toBeUndefined();
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
```

`access` is already imported at the top of `tests/session.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session.test.ts`
Expected: FAIL — `uninstallLauncher` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/session.ts`, add `readdir` to the fs import:

```ts
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, unlink } from "node:fs/promises";
```

Add the export next to `installLauncher`:

```ts
export interface UninstallResult {
  removed: string[];
  reinstall: string;
}

/**
 * Remove every launcher in binDir that resolves to this client's cli.ts, and
 * nothing else. Stateless (scans by realpath), so it correctly removes custom
 * --name aliases and multiple installs. Never touches the client directory.
 */
export async function uninstallLauncher(opts: {
  cliPath: string;
  binDir?: string;
}): Promise<UninstallResult> {
  const binDir = opts.binDir ?? launcherBinDir();
  const reinstall = `bun ${opts.cliPath} install`;

  let entries: string[];
  try {
    entries = await readdir(binDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: [], reinstall };
    throw err;
  }

  let cliReal: string;
  try {
    cliReal = await realpath(opts.cliPath);
  } catch {
    cliReal = opts.cliPath;
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const p = join(binDir, entry);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(p);
    } catch {
      continue;
    }
    if (!info.isSymbolicLink()) continue;
    let real: string;
    try {
      real = await realpath(p);
    } catch {
      continue; // broken link points nowhere; not ours to judge
    }
    if (real === cliReal) {
      await unlink(p);
      removed.push(entry);
    }
  }
  removed.sort();
  return { removed, reinstall };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd "$S" && git add src/lib/session.ts tests/session.test.ts
git commit -m "feat(derive-client): uninstallLauncher removes launchers, keeps client

Scans the bin dir by realpath so it removes every alias for this client
and nothing else; leaves the derived client on disk.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire `install` / `uninstall` into `runLifecycle` + CHANGELOG

**Files:**
- Modify: `src/lib/session.ts` (`runLifecycle`, lines 287-339; add two small argv helpers)
- Modify: `../../../CHANGELOG.md` → i.e. `plugins/rkt/CHANGELOG.md`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `installLauncher`, `uninstallLauncher` (Tasks 2-3); `dirname`, `join` (imported in Task 2).
- Produces: `runLifecycle(command, sub, manifestPath, opts?)` returns `true` for `command === "install"` and `command === "uninstall"`, performing the action.

- [ ] **Step 1: Write the failing test**

Add to `tests/session.test.ts`. These use the existing `beforeEach` temp `root` and set `RKT_BIN_DIR` to a temp dir. Reuse the full manifest shape already used by the other `runLifecycle` tests in this file.

```ts
function fullManifest(site: string) {
  return {
    schemaVersion: 2, site, baseUrl: "https://api.example.test", recordedAt: "", harSha256: "",
    userAgent: "", clientHints: {}, auth: null, authBundle: null, refresh: null, endpoints: [],
  };
}

test("runLifecycle install creates the launcher and reports handled", async () => {
  const { runLifecycle } = await import("../src/lib/session");
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  const prev = process.env.RKT_BIN_DIR;
  process.env.RKT_BIN_DIR = binDir;
  try {
    const clientDir = join(root, "example");
    await mkdir(clientDir, { recursive: true });
    await writeFile(join(clientDir, "cli.ts"), "// stub\n");
    const mpath = join(clientDir, "client.json");
    await writeFile(mpath, JSON.stringify(fullManifest("example")));

    const handled = await runLifecycle("install", undefined, mpath);
    expect(handled).toBe(true);
    expect(await readlink(join(binDir, "example"))).toBe(join(clientDir, "cli.ts"));
  } finally {
    if (prev === undefined) delete process.env.RKT_BIN_DIR;
    else process.env.RKT_BIN_DIR = prev;
  }
});

test("runLifecycle uninstall removes the launcher and reports handled", async () => {
  const { runLifecycle } = await import("../src/lib/session");
  const binDir = await mkdtemp(join(tmpdir(), "rkt-bin-"));
  const prev = process.env.RKT_BIN_DIR;
  process.env.RKT_BIN_DIR = binDir;
  try {
    const clientDir = join(root, "example");
    await mkdir(clientDir, { recursive: true });
    await writeFile(join(clientDir, "cli.ts"), "// stub\n");
    const mpath = join(clientDir, "client.json");
    await writeFile(mpath, JSON.stringify(fullManifest("example")));

    await runLifecycle("install", undefined, mpath);
    const handled = await runLifecycle("uninstall", undefined, mpath);
    expect(handled).toBe(true);
    await expect(access(join(binDir, "example"))).rejects.toThrow();
  } finally {
    if (prev === undefined) delete process.env.RKT_BIN_DIR;
    else process.env.RKT_BIN_DIR = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session.test.ts`
Expected: FAIL — `runLifecycle("install", ...)` returns `false` (current guard rejects unknown commands).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/session.ts`, add two argv helpers above `runLifecycle`:

```ts
function launcherFlagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function launcherHasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
```

Then insert these two branches at the very top of `runLifecycle`, before the existing guard on line 293. Uninstall is handled before any manifest read so a partially broken client can still have its launcher removed; install reads the manifest only for the default name.

```ts
  if (command === "install") {
    const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    const cliPath = join(dirname(manifestPath), "cli.ts");
    const res = await installLauncher({
      cliPath,
      defaultName: manifest.site,
      name: launcherFlagValue("name"),
      force: launcherHasFlag("force"),
    });
    console.error(`installed '${res.name}' -> ${res.target}`);
    console.error(`run: ${res.name} <command>`);
    if (res.pathHint) {
      console.error("add this line to your shell profile to use it:");
      console.error(res.pathHint);
    }
    return true;
  }
  if (command === "uninstall") {
    const cliPath = join(dirname(manifestPath), "cli.ts");
    const { removed, reinstall } = await uninstallLauncher({ cliPath });
    if (removed.length > 0) console.error(`removed: ${removed.join(", ")}`);
    else console.error("not installed (no launcher on your PATH points at this client).");
    console.error("the derived client is untouched. reinstall with:");
    console.error(reinstall);
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` — expected: no errors.

- [ ] **Step 5: Update CHANGELOG**

In `plugins/rkt/CHANGELOG.md`, under the existing `## [Unreleased]` heading, add:

```markdown
- **derive-client: native install/uninstall.** Generated clients now carry a
  `#!/usr/bin/env bun` shebang and an `install.sh`. `bun <client>/cli.ts install
  [--name x]` symlinks the CLI onto `~/.local/bin` (or `$RKT_BIN_DIR`) so you can
  run it by name; `<client> uninstall` removes the launcher while leaving the
  derived client and its credentials in place. PATH help is printed, never
  written to your shell profile.
```

- [ ] **Step 6: Commit**

```bash
cd "$S" && git add src/lib/session.ts tests/session.test.ts ../../../CHANGELOG.md
git commit -m "feat(derive-client): expose install/uninstall via runLifecycle

Both emitted CLI variants inherit the commands through the shared runtime.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Note: `../../../CHANGELOG.md` from `$S` resolves to `plugins/rkt/CHANGELOG.md`. Confirm with `git status --short` before committing that only that CHANGELOG is staged.

---

### Task 5: Emit `install.sh`, chmod the generated cli, and document it

**Files:**
- Modify: `src/generate.ts` (add `chmod` import; add `INSTALL_SH`; write + chmod in `generateClient`)
- Modify: `plugins/rkt/skills/derive-client/SKILL.md` (add an install step)
- Test: `tests/generate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the shebang from Task 1 is already in the emitted `cli.ts`).
- Produces: `generateClient` writes `<siteDir>/install.sh` (mode `0o755`) and leaves `<siteDir>/cli.ts` executable.

- [ ] **Step 1: Write the failing test**

Add to `tests/generate.test.ts` (it already generates into a temp `workRoot`; reuse its `generateClient` call or add a focused one). Use the file's existing `MANIFEST` and `manifestPath` setup pattern:

```ts
test("emits an executable install.sh and an executable cli.ts", async () => {
  const out = await mkdtemp(join(tmpdir(), "rkt-gen-"));
  const mPath = join(out, "client.json");
  await writeFile(mPath, JSON.stringify(MANIFEST));
  const { siteDir } = await generateClient(mPath, out);

  const installSh = join(siteDir, "install.sh");
  const cliTs = join(siteDir, "cli.ts");
  const shMode = (await stat(installSh)).mode & 0o111;
  const cliMode = (await stat(cliTs)).mode & 0o111;
  expect(shMode).not.toBe(0);
  expect(cliMode).not.toBe(0);

  const shBody = await readFile(installSh, "utf8");
  expect(shBody).toContain("bun install");
  expect(shBody).toContain('exec bun "$DIR/cli.ts" install');
  expect(shBody).not.toContain(MANIFEST.site); // stays site-agnostic
});
```

Add `stat` to the test's `node:fs/promises` import if not present, and `mkdtemp` (already imported). `MANIFEST` and `writeFile` already exist in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/generate.test.ts`
Expected: FAIL — `install.sh` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/generate.ts`:

Add `chmod` to the fs import (line 6):

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
```

Add the `install.sh` template near the other scaffold constants (after `README`):

```ts
const INSTALL_SH = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
# Dependencies live at the rkt-clients root; node_modules is shared across clients.
( cd "$DIR/.." && bun install )
chmod +x "$DIR/cli.ts"
exec bun "$DIR/cli.ts" install "$@"
`;
```

At the end of `generateClient`, after `await write(join(siteDir, "cli.ts"), emitCli(manifest, commands), written);`, add:

```ts
  await write(join(siteDir, "install.sh"), INSTALL_SH, written);
  await chmod(join(siteDir, "install.sh"), 0o755);
  await chmod(join(siteDir, "cli.ts"), 0o755);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/generate.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` — expected: no errors.

- [ ] **Step 5: Update SKILL.md**

In `plugins/rkt/skills/derive-client/SKILL.md`, add a step after the client is generated (right after the generation step, before or alongside the "run it" guidance). Keep it generic:

```markdown
### Install the CLI (optional, macOS/Linux)

To run the client by name instead of `bun <client>/cli.ts ...`:

    bash ~/Documents/Repositories/rkt-clients/<site>/install.sh

This symlinks the CLI onto `~/.local/bin` (override with `RKT_BIN_DIR`) and
chmods it executable. Pass a shorter name with:

    bun ~/Documents/Repositories/rkt-clients/<site>/cli.ts install --name <name>

If `~/.local/bin` is not on your PATH, the command prints the `export PATH=...`
line to add to your shell profile. It never edits the profile for you.

Remove the launcher later with `<name> uninstall`. That removes only the
PATH shortcut; the derived client and its saved credentials stay on disk, and
the command prints how to reinstall.
```

- [ ] **Step 6: Commit**

```bash
cd "$S" && git add src/generate.ts tests/generate.test.ts ../SKILL.md
git commit -m "feat(derive-client): emit install.sh and mark cli executable

install.sh bootstraps shared deps then delegates to 'cli.ts install'.
Document install/uninstall in SKILL.md.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Note: `../SKILL.md` from `$S` resolves to `plugins/rkt/skills/derive-client/SKILL.md`. Verify with `git status --short`.

---

### Task 6: End-to-end smoke verification + full gate (symlink-resolution proof)

This task writes no new production code unless the symlink proof fails. It verifies the one runtime behavior the spec flagged: that a symlinked launcher resolves `../lib/*` imports and `./client.json` correctly.

**Files:**
- Read/verify only, unless the shim fallback is needed (then `src/lib/session.ts`).

- [ ] **Step 1: Generate a real client into a temp dir**

```bash
cd "$S"
TMP=$(mktemp -d)
bun src/generate.ts --manifest tests/fixtures/*/client.json --out "$TMP" 2>/dev/null \
  || bun src/generate.ts --manifest "$(ls tests/fixtures/**/client.json 2>/dev/null | head -1)" --out "$TMP"
ls "$TMP"
```

If no fixture `client.json` exists, derive a throwaway manifest from any test's `MANIFEST` object by writing it to `$TMP/client.json` and running `bun src/generate.ts --manifest "$TMP/client.json" --out "$TMP"`. The site dir name equals the manifest `site`.

- [ ] **Step 2: Install into a temp bin dir**

```bash
BIN=$(mktemp -d)
SITE=$(ls "$TMP" | grep -vE '^(lib|node_modules|package.json|tsconfig.json|README.md|.gitignore)$' | head -1)
( cd "$TMP" && bun install >/dev/null 2>&1 || true )
RKT_BIN_DIR="$BIN" bun "$TMP/$SITE/cli.ts" install
ls -l "$BIN"
```

Expected: `$BIN/$SITE` is a symlink to `$TMP/$SITE/cli.ts`, and stderr shows the `install ->` line plus a PATH hint (since `$BIN` is not on PATH).

- [ ] **Step 3: THE PROOF — run the launcher from OUTSIDE the client dir**

```bash
cd /tmp
"$BIN/$SITE" auth status; echo "exit=$?"
```

Expected: it prints the auth-status lines (identity/access/refresh/session). It must NOT error with `Cannot find module '../lib/session'` or a missing `client.json`. Exit 0.

- [ ] **Step 4: Decision**

- **If Step 3 succeeded:** the symlink resolves correctly. No code change. Proceed to Step 6.
- **If Step 3 failed with a module/`client.json` resolution error:** implement the shim fallback (Step 5).

- [ ] **Step 5 (only if Step 3 failed): shim fallback**

In `installLauncher` (`src/lib/session.ts`), replace the `await symlink(opts.cliPath, target);` line with an absolute-path shim written to `target`:

```ts
  const shim = `#!/usr/bin/env bash\nexec bun ${JSON.stringify(opts.cliPath)} "$@"\n`;
  await writeFile(target, shim, { mode: 0o755 });
```

(Add `writeFile` to the fs import.) Then update `uninstallLauncher` to match shims as well as symlinks: for a non-symlink regular file in binDir, read it and remove it if it contains `exec bun "<cliReal or cliPath>"`. Add a unit test in `tests/session.test.ts` mirroring the "removes only links pointing at this cli" test but for shim files, and a test that a shim-installed launcher's `target` contains the absolute `cliPath`. Re-run Steps 1-3 to confirm the proof now passes. Commit:

```bash
cd "$S" && git add src/lib/session.ts tests/session.test.ts
git commit -m "fix(derive-client): use absolute-path shim launcher

Symlinked launcher did not resolve ../lib imports; a shim with the absolute
cli.ts path is invocation-independent.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Uninstall proof**

```bash
RKT_BIN_DIR="$BIN" bun "$TMP/$SITE/cli.ts" uninstall
ls -l "$BIN"          # launcher gone
ls "$TMP/$SITE/cli.ts"  # client cli.ts still present
```

Expected: `$BIN/$SITE` removed; `$TMP/$SITE/cli.ts` still exists; stderr shows the reinstall command.

- [ ] **Step 7: Full gate**

```bash
cd "$S"
ulimit -n 4096
bun test
bunx tsc --noEmit
# closure probe: generated output type-checks on its own
GEN=$(mktemp -d); bun src/generate.ts --manifest "$TMP/$SITE/client.json" --out "$GEN"
( cd "$GEN" && bun install >/dev/null 2>&1 && bunx tsc --noEmit )
cd /Users/rocket/Documents/Repositories/rkt-stack && claude plugin validate plugins/rkt
```

Expected: `bun test` all pass; both `tsc --noEmit` clean; `claude plugin validate` reports valid.

- [ ] **Step 8: Cleanup + report**

```bash
rm -rf "$TMP" "$BIN" "$GEN"
```

Report: which launcher form shipped (symlink vs shim), the gate results, and the exact user-facing commands (`bash <client>/install.sh`, `<name> uninstall`).

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| Shebang on emitted cli, not on types | Task 1 |
| `install.sh` bootstrap emitted, site-agnostic | Task 5 |
| `installLauncher` name default + `--name` override | Task 2 |
| Collision refuse-unless-`--force`, idempotent-if-points-here | Task 2 |
| PATH hint printed, never written | Task 2 (+ asserted) |
| `launcherBinDir` env + `~/.local/bin`, not NODE_ENV-gated | Task 2 |
| `uninstallLauncher` scans by realpath, removes only this client's links | Task 3 |
| Uninstall preserves the client on disk | Task 3 (asserted) |
| Reinstall command printed | Task 3 / Task 4 |
| `install`/`uninstall` wired into both CLIs via `runLifecycle` | Task 4 |
| chmod generated cli executable | Task 5 |
| Symlink-resolution proof + shim fallback | Task 6 |
| SKILL.md + CHANGELOG in same change | Tasks 4, 5 |
| darwin-only note | Task 5 (SKILL.md) |
| Ships as 0.8.0 (release-time stamp) | out of plan scope; AGENTS.md Release Flow at the end |

No gaps.

**2. Placeholder scan:** No TBD/TODO. Every code step shows full code. Task 6 is verification with explicit commands and a conditional (Step 5) whose code is fully written.

**3. Type consistency:** `installLauncher` / `InstallResult` / `uninstallLauncher` / `UninstallResult` / `launcherBinDir` are named identically in their defining task (2, 3), their consumer (Task 4 `runLifecycle`), and the tests. Import lines are shown cumulatively (Task 2 adds `lstat/realpath/symlink/unlink` + os/path; Task 3 adds `readdir`). `launcherFlagValue` / `launcherHasFlag` are prefixed to avoid colliding with any `flagValue`/`hasFlag` already in scope.

## Release (after all tasks green, per AGENTS.md Release Flow)

Not a task — needs explicit approval. When both this feature and the merged naming prompt are usable end to end: rename `## [Unreleased]` to `## [0.8.0] - <date>`, bump `plugins/rkt/.claude-plugin/plugin.json` and `plugins/rkt/.codex-plugin/plugin.json` to `0.8.0` in lockstep, commit, tag `v0.8.0`, and push branch + tag only after approval.
