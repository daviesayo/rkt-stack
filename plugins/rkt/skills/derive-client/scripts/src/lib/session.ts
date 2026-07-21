import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { profileDir, secretsFile, storageStateFile, secretsDir, sanitizeSite } from "./paths";

export interface AuthStatusInput {
  identity: { name: string } | null;
  accessExpiry: string | null;
  refreshWindow: null;
  storageStateMtime: number | null;
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  // Drop a trailing "0m" so exactly-N-hour durations read "2h", matching the
  // spec's sample output, not "2h 0m".
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

export function formatAuthStatus(input: AuthStatusInput, now: number): string[] {
  const lines: string[] = [];

  lines.push(
    input.identity ? `Signed in as ${input.identity.name}` : "Signed in as unknown (run whoami)",
  );

  if (!input.accessExpiry) {
    lines.push("Access token     unknown");
  } else {
    const delta = Date.parse(input.accessExpiry) - now;
    lines.push(delta <= 0 ? "Access token     expired" : `Access token     expires in ${humanDuration(delta)}`);
  }

  lines.push("Refresh window   unknown");

  lines.push(
    input.storageStateMtime == null
      ? "Browser session  none saved"
      : `Browser session saved ${humanDuration(now - input.storageStateMtime)} ago`,
  );

  return lines;
}

export function identityCacheFile(site: string): string {
  return `${secretsDir()}/${sanitizeSite(site)}.identity.json`;
}

export async function logoutSite(site: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const path of [secretsFile(site), storageStateFile(site), identityCacheFile(site)]) {
    try {
      await stat(path);
      await rm(path, { force: true });
      removed.push(path);
    } catch {
      /* not present */
    }
  }
  return removed.length ? { removed } : { removed: [] };
}

export interface Launcher {
  (site: string, entryUrl: string, statePath: string): Promise<boolean>;
}

/**
 * Open headed Chrome on the recorded profile, wait for the user to sign in,
 * save storageState. The launcher is injectable so unit tests never open a
 * browser; the real launcher is exercised by the live smoke test.
 */
export async function loginSite(
  site: string,
  entryUrl: string,
  opts: { launch?: Launcher } = {},
): Promise<boolean> {
  const launch = opts.launch ?? defaultLauncher;
  // Clear identity cache first: signing in as a different user must not leave
  // a stale @me pointing at the previous person.
  await rm(identityCacheFile(site), { force: true }).catch(() => {});
  const statePath = storageStateFile(site);
  const dir = secretsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const ok = await launch(site, entryUrl, statePath);
  if (ok) await chmod(statePath, 0o600);
  return ok;
}

const defaultLauncher: Launcher = async (site, entryUrl, statePath) => {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    return false;
  }
  const ctx = await pw.chromium.launchPersistentContext(profileDir(site), {
    channel: "chrome",
    headless: false,
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    // Wait until the user has left the identity provider (signed in), capped.
    await page
      .waitForURL((u) => !/identity|login|auth|realms/i.test(u.host + u.pathname), { timeout: 300_000 })
      .catch(() => {});
    await ctx.storageState({ path: statePath });
    return true;
  } finally {
    await ctx.close().catch(() => {});
  }
};
