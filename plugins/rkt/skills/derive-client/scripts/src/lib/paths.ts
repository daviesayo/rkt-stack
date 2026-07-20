import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Root for all runtime artifacts.
 *
 * RKT_CLIENTS_ROOT exists so tests can redirect the whole filesystem surface
 * to a temp directory. It is honored ONLY under NODE_ENV=test, which Bun sets
 * during `bun test`. Production must never be able to move this root: it is
 * both the confinement boundary enforced by assertUnderRktRoot and the
 * location of 0600 credential files.
 */
export function rktRoot(): string {
  if (process.env.NODE_ENV === "test") {
    const override = process.env.RKT_CLIENTS_ROOT;
    if (override && override.length > 0) return resolve(override);
  }
  return `${homedir()}/.rkt-clients`;
}

/**
 * Serialized browser session for a site.
 *
 * Kept separately from the profile directory because the cookies that prove an
 * SSO session are frequently session-scoped (no Max-Age), and a browser
 * discards those on close. storageState() serializes them to disk, which is
 * the only way a later process can reuse the session.
 */
export function storageStateFile(site: string): string {
  return `${secretsDir()}/${sanitizeSite(site)}.storage-state.json`;
}

export function secretsDir(): string {
  return `${rktRoot()}/secrets`;
}

/** Resolve `path` absolutely and fail unless it is under `rktRoot()`. */
export function assertUnderRktRoot(path: string): string {
  const abs = resolve(path);
  const root = rktRoot();
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw new Error(`path must be under ${root}: ${path}`);
  }
  return abs;
}

export function sanitizeSite(site: string): string {
  const cleaned = site
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    throw new Error(`invalid site identifier: ${JSON.stringify(site)}`);
  }
  return cleaned;
}

export function profileDir(site: string): string {
  return `${rktRoot()}/profiles/${sanitizeSite(site)}`;
}

export function lockFile(site: string): string {
  return `${profileDir(site)}/.rkt-lock`;
}

export function recordingDir(site: string, timestamp: string): string {
  return `${rktRoot()}/recordings/${sanitizeSite(site)}/${timestamp}`;
}

export function secretsFile(site: string): string {
  return `${rktRoot()}/secrets/${sanitizeSite(site)}.json`;
}
