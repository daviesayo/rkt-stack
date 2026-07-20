import { homedir } from "node:os";

export function rktRoot(): string {
  return `${homedir()}/.rkt-clients`;
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
