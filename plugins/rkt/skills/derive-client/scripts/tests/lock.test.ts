import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockHeldError } from "../src/lib/lock";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

test("acquire then release allows a second acquire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-lock-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const release = await acquireLock("testsite", dir);
  await release();

  const release2 = await acquireLock("testsite", dir);
  await release2();
  expect(true).toBe(true);
});

test("second acquire while held throws LockHeldError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-lock-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const release = await acquireLock("testsite", dir);
  cleanups.push(release);

  await expect(acquireLock("testsite", dir)).rejects.toThrow(LockHeldError);
});

test("a stale lock from a dead process is reclaimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rkt-lock-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  const profile = join(dir, "profiles", "testsite");
  await mkdir(profile, { recursive: true });
  // PID 2^22 + 1 is above the Linux/macOS pid_max ceiling, so it cannot be live.
  await writeFile(
    join(profile, ".rkt-lock"),
    JSON.stringify({ pid: 4194305, startedAt: new Date().toISOString() }),
  );

  const release = await acquireLock("testsite", dir);
  cleanups.push(release);
  expect(true).toBe(true);
});
