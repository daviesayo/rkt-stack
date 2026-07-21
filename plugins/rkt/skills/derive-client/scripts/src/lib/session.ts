import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { validateManifest } from "./manifest-schema";
import { readSecretMeta, writeSecret } from "./secrets";
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

/** The formatted "Name (email)" label whoami wrote, or null before whoami has run. */
export async function readIdentityLabel(site: string): Promise<string | null> {
  try {
    const raw = await readFile(identityCacheFile(site), "utf8");
    const c = JSON.parse(raw) as { label?: string };
    return typeof c.label === "string" ? c.label : null;
  } catch {
    return null;
  }
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

/** A credential the manifest says the API needs, in the same keying secrets use. */
export interface WantedCredential {
  location: string;
  kind: string;
}

export interface LauncherArgs {
  site: string;
  entryUrl: string;
  statePath: string;
  /** Credentials to harvest: cookie:<name> from cookies, header names from live requests. */
  wanted: WantedCredential[];
  /** Only requests to this host are trusted to carry header credentials. */
  apiHost: string | null;
}

/** location -> value, ready for writeSecret. */
export interface LoginResult {
  values: Record<string, string>;
}

export interface Launcher {
  (args: LauncherArgs): Promise<LoginResult | null>;
}

/**
 * Open headed Chrome on the recorded profile, wait for the user to sign in,
 * save storageState AND the harvested credential bundle, so the very next
 * command authenticates without a re-record. login is self-sufficient: it does
 * not merely refresh the browser session, it writes the secret bundle a
 * generated client reads. The launcher is injectable so unit tests never open a
 * browser; the real launcher is exercised by the live smoke test.
 */
export async function loginSite(
  site: string,
  entryUrl: string,
  opts: { launch?: Launcher; wanted?: WantedCredential[]; apiHost?: string | null } = {},
): Promise<boolean> {
  const launch = opts.launch ?? defaultLauncher;
  // Clear identity cache first: signing in as a different user must not leave
  // a stale @me pointing at the previous person.
  await rm(identityCacheFile(site), { force: true }).catch(() => {});
  const statePath = storageStateFile(site);
  const dir = secretsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const result = await launch({
    site,
    entryUrl,
    statePath,
    wanted: opts.wanted ?? [],
    apiHost: opts.apiHost ?? null,
  });
  if (!result) return false;
  await chmod(statePath, 0o600).catch(() => {});
  // Write the bundle only when something was harvested. An empty bundle would
  // overwrite a good stored session with nothing whenever harvesting misses.
  if (Object.keys(result.values).length > 0) await writeSecret(site, result.values);
  return true;
}

const defaultLauncher: Launcher = async ({ site, entryUrl, statePath, wanted, apiHost }) => {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    return null;
  }
  const ctx = await pw.chromium.launchPersistentContext(profileDir(site), {
    channel: "chrome",
    headless: false,
  });
  try {
    // Header credentials (csrf/bearer) are not cookies and are not in
    // storageState; the browser only reveals them on a live request. Observe
    // requests to the API host and capture the header values the manifest names.
    const headerCreds = wanted.filter((w) => !w.location.startsWith("cookie:"));
    const byLowerName = new Map(headerCreds.map((w) => [w.location.toLowerCase(), w.location]));
    const observedHeaders: Record<string, string> = {};
    const pending: Promise<void>[] = [];
    if (byLowerName.size > 0) {
      ctx.on("request", (req) => {
        let host: string;
        try {
          host = new URL(req.url()).host;
        } catch {
          return;
        }
        if (apiHost && host !== apiHost) return;
        pending.push(
          req
            .allHeaders()
            .then((headers) => {
              for (const [lower, location] of byLowerName) {
                if (headers[lower]) observedHeaders[location] = headers[lower];
              }
            })
            .catch(() => {}),
        );
      });
    }

    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    // Wait until the user has left the identity provider (signed in), capped.
    await page
      .waitForURL((u) => !/identity|login|auth|realms/i.test(u.host + u.pathname), { timeout: 300_000 })
      .catch(() => {});

    // The access-token cookie is minted by the app's token exchange AFTER it
    // loads, so a single snapshot races the mint (it captures only the identity
    // provider's SSO cookies). Poll until every wanted cookie is present, or a
    // deadline, exactly as the browser re-auth path does. The request listener
    // keeps capturing header creds while the app fires its API calls.
    const wantedCookieLocations = wanted
      .filter((w) => w.location.startsWith("cookie:"))
      .map((w) => w.location);
    const deadline = Date.now() + 45_000;
    let cookieValues: Record<string, string> = {};
    for (;;) {
      const cookies = await ctx.cookies();
      cookieValues = {};
      for (const c of cookies) {
        const location = `cookie:${c.name}`;
        if (wantedCookieLocations.includes(location)) cookieValues[location] = c.value;
      }
      const have = wantedCookieLocations.filter((l) => cookieValues[l]).length;
      if (wantedCookieLocations.length === 0 || have === wantedCookieLocations.length) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await Promise.allSettled(pending);
    await ctx.storageState({ path: statePath });

    return { values: { ...observedHeaders, ...cookieValues } };
  } finally {
    await ctx.close().catch(() => {});
  }
};

function firstJwtExpiry(expiry: Record<string, string | null>): string | null {
  for (const v of Object.values(expiry)) if (v) return v;
  return null;
}

/**
 * Handle the lifecycle commands (login, logout, auth status) shared by every
 * generated client. Returns true when it handled the command, false to let the
 * caller fall through to endpoint/task dispatch. `manifestPath` is a plain
 * filesystem path (the caller resolves it), so no URL decoding is needed here.
 */
export async function runLifecycle(
  command: string,
  sub: string | undefined,
  manifestPath: string,
  opts: { launch?: Launcher } = {},
): Promise<boolean> {
  if (command !== "login" && command !== "logout" && !(command === "auth" && sub === "status")) {
    return false;
  }
  const raw = await import("node:fs/promises").then((fs) => fs.readFile(manifestPath, "utf8"));
  const manifest = validateManifest(JSON.parse(raw));

  if (command === "login") {
    const creds = manifest.authBundle?.credentials ?? (manifest.auth ? [manifest.auth] : []);
    const wanted: WantedCredential[] = creds.map((c) => ({ location: c.location, kind: c.kind }));
    let apiHost: string | null = null;
    try {
      apiHost = new URL(manifest.baseUrl).host;
    } catch {
      /* leave null: no host filter, harvest headers from any request */
    }
    const ok = await loginSite(manifest.site, `${manifest.baseUrl}/`, {
      launch: opts.launch,
      wanted,
      apiHost,
    });
    console.error(ok ? "signed in; session saved" : "login could not complete");
    return true;
  }
  if (command === "logout") {
    const { removed } = await logoutSite(manifest.site);
    console.error(removed.length ? `removed ${removed.length} session file(s)` : "nothing to remove");
    return true;
  }
  // command === "auth" && sub === "status"
  const meta = await readSecretMeta(manifest.site);
  const accessExpiry = meta ? firstJwtExpiry(meta.expiry) : null;
  let mtime: number | null = null;
  try {
    mtime = (await stat(storageStateFile(manifest.site))).mtimeMs;
  } catch {
    /* no saved session */
  }
  const label = await readIdentityLabel(manifest.site);
  const lines = formatAuthStatus(
    { identity: label ? { name: label } : null, accessExpiry, refreshWindow: null, storageStateMtime: mtime },
    Date.now(),
  );
  console.log(lines.join("\n"));
  return true;
}
