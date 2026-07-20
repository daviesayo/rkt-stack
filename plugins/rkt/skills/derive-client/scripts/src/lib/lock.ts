import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { sanitizeSite } from "./paths";

export class LockHeldError extends Error {
  constructor(site: string, pid: number) {
    super(
      `A derive-client session for "${site}" is already running (pid ${pid}). ` +
        `Chrome allows only one instance per profile. Wait for it to finish, ` +
        `or stop that process and retry.`,
    );
    this.name = "LockHeldError";
  }
}

interface LockBody {
  pid: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(
  site: string,
  root: string = `${homedir()}/.rkt-clients`,
): Promise<() => Promise<void>> {
  const profile = `${root}/profiles/${sanitizeSite(site)}`;
  const lockPath = `${profile}/.rkt-lock`;
  await mkdir(profile, { recursive: true });

  try {
    const raw = await readFile(lockPath, "utf8");
    const held = JSON.parse(raw) as LockBody;
    if (isProcessAlive(held.pid)) {
      throw new LockHeldError(site, held.pid);
    }
    // Stale lock: the owning process died without releasing. Reclaim it.
  } catch (err) {
    if (err instanceof LockHeldError) throw err;
    // Missing or unparseable lock file: treat as unlocked.
  }

  const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(lockPath, JSON.stringify(body), { mode: 0o600 });

  return async () => {
    await rm(lockPath, { force: true });
  };
}
