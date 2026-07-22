# derive-client: install / uninstall the generated CLI

**Date:** 2026-07-22
**Status:** Design, approved to plan
**Ships in:** rkt plugin v0.8.0 (accumulates under `## [Unreleased]` alongside the client-naming prompt)
**Builds on:** derive-client command surface (v0.7.0, PR #12, tagged)

## Goal

Let a user put a derived client's CLI on their PATH with one command, so they run `alayacare employees` instead of `bun ~/Documents/Repositories/rkt-clients/alayacare/cli.ts employees`. Provide a matching in-CLI `uninstall` that removes the launcher without deleting the derived client, and make reinstalling obvious.

## Motivation

The luma-cli reference artifact ships an `install.sh` that symlinks its `cli.ts` onto `~/.local/bin`. That is the one capability where luma leads our generated clients; in every other dimension (generic derivation, typed responses, tiered auth renewal, task-command surface, drift detection) our clients are ahead. This feature closes that gap so our client strictly dominates.

Recording the design decision so implementers do not relitigate it: the derived client is the durable artifact; the launcher is a disposable shortcut to it. Every behavior below follows from that split.

## Scope

**In:**
- `#!/usr/bin/env bun` shebang + executable bit on the generated `cli.ts`.
- A per-client `install.sh` emitted into the site directory.
- Two new lifecycle commands, `install` and `uninstall`, wired through the shared `runLifecycle` so both the task-command CLI and the fallback endpoint CLI get them.
- SKILL.md and CHANGELOG updates in the same change.

**Out (not now):**
- Windows launcher support. The dev environment is darwin; `~/.local/bin` + symlink is POSIX. Note the limitation in SKILL.md, do not build for it.
- Package-manager distribution (Homebrew, npm bin). A local symlink is the whole ask.
- Auto-adding the bin directory to the shell profile. Forbidden by host-safety (see Safety invariants).

## Design decisions (resolved during brainstorming)

1. **Command name:** defaults to the client slug (`manifest.site`); `install --name <short>` overrides it. Reinstall stays scriptable; the short name is an explicit opt-in.
2. **Collision:** if the target path already exists and is not already a symlink to *this* client's `cli.ts`, refuse and print the `--force` hint. `--force` replaces it. An existing symlink that already points here is idempotent success.
3. **Surface:** emit `install.sh` (bootstrap) *and* in-CLI `install`/`uninstall` commands. `install.sh` delegates to `cli.ts install` so the symlink/PATH logic has one home.
4. **Symlink vs shim:** use a symlink (matches luma). The plan MUST prove end-to-end that imports and `client.json` resolve when the CLI is run through the symlink from outside the client directory. If that fails, fall back to an absolute-path shim. See Path-resolution risk.
5. **Blind review:** skipped for this spec by user decision. Straight to writing-plans after user review.

## Architecture

Three source files change; the rest is docs.

### `scripts/src/lib/codegen.ts` (shebang)
Prepend `#!/usr/bin/env bun\n` to the string returned by both `emitTaskCli` and `emitEndpointCli`, ahead of `GENERATED_HEADER`. `emitTypes` is untouched (the types file is not executable). The shebang lets the OS run the symlink target directly via bun.

### `scripts/src/generate.ts` (emit install.sh, chmod cli.ts)
- After writing `cli.ts`, `chmod 0o755` it so a fresh generate produces an executable entrypoint even before `install.sh` runs.
- Write `install.sh` into the site directory with mode `0o755`. Contents:

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Dependencies live at the rkt-clients root; node_modules is shared across clients.
( cd "$DIR/.." && bun install )
chmod +x "$DIR/cli.ts"
exec bun "$DIR/cli.ts" install "$@"
```

`install.sh` is content-fixed, so writing it every run is idempotent, consistent with the existing scaffold files. It carries no site name in its body, so it stays generic.

### `scripts/src/lib/session.ts` (the logic)
Add two exported, argv-free core functions plus `runLifecycle` wiring.

```
export function launcherBinDir(): string
// process.env.RKT_BIN_DIR || `${homedir()}/.local/bin`
// NOT gated by NODE_ENV. Unlike rktRoot(), this is a symlink location, not the
// credential-confinement boundary, so tests must be able to redirect it in any
// environment. No 0600 files live here.

export interface InstallResult { name: string; target: string; pathHint: string | null }
export async function installLauncher(opts: {
  cliPath: string;        // absolute path to the client's cli.ts
  defaultName: string;    // manifest.site
  name?: string;          // --name override
  force?: boolean;        // --force
  binDir?: string;        // defaults to launcherBinDir()
  pathEnv?: string;       // defaults to process.env.PATH, for testability
}): Promise<InstallResult>

export interface UninstallResult { removed: string[]; reinstall: string }
export async function uninstallLauncher(opts: {
  cliPath: string;
  binDir?: string;
}): Promise<UninstallResult>
```

`runLifecycle(command, sub, manifestPath, opts?)` gains two branches, before the existing login/logout/auth/whoami handling is fine either way since the command strings are disjoint:

- `command === "install"`: load the manifest for `site`; `cliPath = join(dirname(manifestPath), "cli.ts")`; read `--name` and `--force` from `process.argv`; call `installLauncher`; print result to stderr; return `true`.
- `command === "uninstall"`: `cliPath` as above; call `uninstallLauncher`; print removed names (or a "not installed" note) and the reinstall command to stderr; return `true`.

`runLifecycle` needs two local helpers mirroring the emitted CLI: `flagValue(name)` and `hasFlag(name)` over `process.argv`. Keep them private to session.ts.

## Command contracts

### `<cli> install [--name <name>] [--force]`
1. Resolve `name` = `--name` value or `defaultName`. Validate against `^[a-z0-9-]+$`; reject otherwise with a clear message. The regex also blocks `/` and `..`, so `target` cannot escape `binDir`.
2. `target = join(binDir, name)`.
3. `mkdir -p binDir`.
4. Inspect `target`:
   - Does not exist -> proceed.
   - Is a symlink whose realpath === `cliPath` -> idempotent; re-ensure and report success (not an error).
   - Anything else (real file, or symlink elsewhere) -> throw unless `force`; message names the `--force` flag. With `force`, unlink then proceed.
5. `chmod 0o755 cliPath`.
6. Create the symlink `target -> cliPath` (unlink-then-symlink to be atomic-ish and overwrite-safe).
7. PATH hint: if `binDir` is not a `:`-delimited entry of `pathEnv`, set `pathHint = 'export PATH="' + binDir + ':$PATH"'`. The caller prints it. Never write it anywhere.
8. Return `{ name, target, pathHint }`.

stderr on success:
```
installed 'alayacare' -> /Users/.../.local/bin/alayacare
run: alayacare <command>
```
plus, when `pathHint` is set:
```
add this line to your shell profile to use it:
export PATH="/Users/.../.local/bin:$PATH"
```

### `<cli> uninstall`
1. If `binDir` does not exist -> `removed: []`.
2. List `binDir`; for each entry that is a symlink, resolve its realpath; if it equals `cliPath`, unlink it and record the entry name. Broken or unreadable symlinks are skipped, never fatal.
3. `reinstall = 'bun ' + cliPath + ' install'`.
4. Return `{ removed, reinstall }`.

Uninstall never reads or writes anything under the client directory or `~/.rkt-clients`. It only removes matching links from `binDir`.

stderr:
```
removed: alayacare
the derived client is untouched. reinstall with:
bun /Users/.../rkt-clients/alayacare/cli.ts install
```
or, when nothing matched:
```
not installed (no launcher on your PATH points at this client).
reinstall with:
bun /Users/.../rkt-clients/alayacare/cli.ts install
```

Scanning for links that point at `cliPath` (rather than recomputing the name) makes uninstall stateless and correct even when the user installed under a custom `--name`, or installed more than one alias. It removes exactly the launchers for this client and nothing else.

## Path-resolution risk (the one thing to verify empirically)

The emitted `cli.ts` imports `../lib/session` and reads `./client.json` relative to `import.meta.url`. Run through `binDir/<name>` -> `cli.ts`, those relative paths resolve correctly only if the runtime reports the real file location rather than the symlink path. Bun, like Node without `--preserve-symlinks`, realpaths modules by default, so `import.meta.url` should be the real `cli.ts`. This is a runtime behavior, not a documented contract we should trust from memory.

**Requirement on the plan:** a smoke step MUST generate a real client, run `install`, then execute `<name> auth status` from a working directory outside the client (e.g. `/tmp`) and confirm the lib imports and `client.json` resolve. If that fails, replace the symlink with an absolute-path shim written to `target`:
```bash
#!/usr/bin/env bash
exec bun "/abs/path/to/site/cli.ts" "$@"
```
The shim carries the absolute path, so import resolution is independent of how the launcher was invoked. `uninstallLauncher` would then match by reading the shim's referenced path instead of a symlink realpath; if the shim fallback is needed, the plan updates the uninstall matcher accordingly. Default path is the symlink; the shim is the contingency.

## Safety invariants

These are load-bearing; the plan's tests assert each one.

- **Never modify the shell profile.** PATH help is printed only. (Global host-safety rule.)
- **Confinement.** `name` matches `^[a-z0-9-]+$`, so the launcher is always a direct child of `binDir`. No traversal, no absolute names.
- **No silent clobber.** A pre-existing non-matching `target` requires `--force`. A real binary on the PATH is never overwritten by accident.
- **Uninstall is client-preserving.** It touches only `binDir` links that resolve to this `cliPath`. The derived client, its `commands.json`, and all credentials under `~/.rkt-clients` are out of reach of this command.
- **No new credential surface.** `binDir` holds a symlink, not secrets. It is deliberately outside the `rktRoot()` 0600 boundary and is not gated by `NODE_ENV`.

## Error handling and edge cases

- Invalid `--name` -> throw with the allowed pattern; exit non-zero via the emitted CLI's existing top-level catch.
- `target` is a directory -> treated as a non-matching existing entry; refuse unless `--force`; with `force`, refuse anyway if it is a directory (unlinking a directory is wrong) and tell the user to clear it. Directories are not a normal case; fail loudly.
- `binDir` on a read-only location -> the `mkdir`/`symlink` error propagates with its OS message; acceptable.
- Multiple aliases installed -> uninstall removes all; install of a second alias is independent.
- Concurrent installs of different clients to the same `binDir` -> no shared state; each writes its own name.

## Testing strategy

Unit tests extend `scripts/tests/session.test.ts`, using a temp `binDir` via `RKT_BIN_DIR` and a temp client directory containing a stub `cli.ts` and a minimal `client.json`.

Required cases:
- install creates `binDir/<site>` as a symlink to `cliPath`, mode includes `0o755` on `cliPath`.
- install `--name` overrides the default.
- install rejects a name failing `^[a-z0-9-]+$`.
- install refuses when `target` exists and points elsewhere; the message mentions `--force`.
- install with `--force` replaces a non-matching `target`.
- install is idempotent when `target` already points at `cliPath` (no throw).
- install returns a non-null `pathHint` when `binDir` is absent from `pathEnv`, and `null` when present. The pathHint string is never written to any file (assert no profile write path is invoked; the function has no such path).
- uninstall removes only links resolving to `cliPath`, leaving an unrelated link and a real file in `binDir` intact.
- uninstall leaves the client directory intact (stub `cli.ts` and `client.json` still exist afterward).
- uninstall returns `removed: []` and a reinstall string when nothing matches.
- `runLifecycle('install', ...)` and `runLifecycle('uninstall', ...)` each return `true` (handled).

Codegen tests (`scripts/tests/` codegen suite):
- Emitted `cli.ts` (both task and endpoint variants) starts with `#!/usr/bin/env bun`.
- `emitTypes` output does not.

Generator test:
- `generateClient` writes `install.sh` into the site dir with an executable mode, and the written `cli.ts` is executable.

Smoke (manual, in the plan, not a unit test): the Path-resolution verification above, run against a real generated client.

Full gate before done: `bun test`, `bunx tsc --noEmit` in `scripts/`, generate into a temp dir and `tsc --noEmit` the output (the existing closure probe), `claude plugin validate plugins/rkt`.

## Docs

- **SKILL.md:** add a short "Install the CLI" step after generation: run `bash <clientdir>/install.sh`, or `bun <clientdir>/cli.ts install [--name x]`; mention `<name> uninstall` and that it leaves the client in place; note the darwin/`~/.local/bin` assumption.
- **CHANGELOG.md:** one `## [Unreleased]` entry describing native install/uninstall. Do not bump manifests here; 0.8.0 is stamped at release time per AGENTS.md Release Flow.

## Versioning

New user-visible capability -> minor bump. 0.7.0 is already tagged, so this and the merged naming prompt ride into 0.8.0 as a single release when both are usable end to end.

## Requirement -> component map (self-review)

| Requirement | Where |
|---|---|
| One-command install onto PATH | `installLauncher` + `install.sh` |
| Default name = slug, `--name` override | `installLauncher` name resolution |
| Refuse collisions unless `--force` | `installLauncher` step 4 |
| `install.sh` bootstrap like luma | `generate.ts` emit + shebang/chmod |
| In-CLI `install` and `uninstall` | `runLifecycle` branches, both emitters via delegation |
| `uninstall` removes launcher, not client | `uninstallLauncher` scan-by-realpath |
| Reinstall is obvious | `uninstall` prints `bun <cliPath> install` |
| Never touch shell profile | PATH hint printed only; asserted in tests |
| No path traversal / silent clobber | name regex + collision refusal; asserted |
| Symlink resolution proven | plan smoke step + shim fallback |
| Docs in the same change | SKILL.md + CHANGELOG |
| Ships as 0.8.0 | release-time stamp per AGENTS.md |
