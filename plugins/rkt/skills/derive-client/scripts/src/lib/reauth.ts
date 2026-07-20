import { access } from "node:fs/promises";
import { profileDir, storageStateFile } from "./paths";

/** Distinguishes "cannot try" from "tried and the session is dead". */
export class ReauthUnavailableError extends Error {
  constructor() {
    super(
      "browser re-auth needs playwright, which is not installed here. " +
        "Run 'bun install' in this client's directory to enable it.",
    );
    this.name = "ReauthUnavailableError";
  }
}

export interface HarvestedSession {
  /** location -> value, in the same keying the secrets file uses. */
  values: Record<string, string>;
}

interface ReauthPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForLoadState(state: string, options?: Record<string, unknown>): Promise<unknown>;
}

interface ReauthContext {
  pages(): ReauthPage[];
  newPage(): Promise<ReauthPage>;
  cookies(): Promise<Array<{ name: string; value: string }>>;
  storageState(options?: { path?: string }): Promise<unknown>;
  close(): Promise<void>;
}

interface ReauthBrowser {
  newContext(options?: Record<string, unknown>): Promise<ReauthContext>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchPersistentContext(userDataDir: string, options?: Record<string, unknown>): Promise<ReauthContext>;
  launch(options?: Record<string, unknown>): Promise<ReauthBrowser>;
}

async function loadChromium(): Promise<PlaywrightChromium | null> {
  try {
    // Non-literal module spec keeps tsc from requiring playwright in generated clients.
    const moduleSpec = "playwright";
    const mod = (await import(moduleSpec)) as { chromium: PlaywrightChromium };
    return mod.chromium;
  } catch {
    return null;
  }
}

/**
 * Re-authenticate by replaying the recorded browser profile.
 *
 * This is the tier that makes unattended use possible. An access token lives
 * minutes and its refresh token hours, but the identity provider's own SSO
 * cookie in the saved profile lives far longer, and loading the app with that
 * profile makes the page mint a fresh access token by itself. No credentials
 * are handled here: whatever the profile was signed into, it stays signed into.
 *
 * Returns null when the profile can no longer authenticate, which is the
 * signal that a human must run the recorder again.
 */
export async function reauthViaProfile(
  site: string,
  entryUrl: string,
  wanted: string[],
  timeoutMs = 45_000,
): Promise<HarvestedSession | null> {
  const chromium = await loadChromium();
  // Missing tooling is not an expired session. Reporting them the same way
  // sends the user off to re-authenticate a session that is perfectly valid.
  if (!chromium) throw new ReauthUnavailableError();

  let context: ReauthContext | null = null;
  let browser: ReauthBrowser | null = null;
  try {
    // Prefer the saved storage state: it carries session-scoped cookies that a
    // profile directory drops on close, which is usually the difference
    // between a live SSO session and a redirect to the login page.
    const statePath = storageStateFile(site);
    const haveState = await access(statePath).then(() => true).catch(() => false);

    if (haveState) {
      browser = await chromium.launch({ channel: "chrome", headless: true });
      context = await browser.newContext({ storageState: statePath, serviceWorkers: "block" });
    } else {
      context = await chromium.launchPersistentContext(profileDir(site), {
        channel: "chrome",
        headless: true,
        serviceWorkers: "block",
      });
    }

    const ctx = context;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // The token exchange happens after load, so wait for the network to settle
    // rather than assuming the credential exists the moment the DOM is ready.
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

    // Signing in is a redirect dance: the identity provider authenticates,
    // hands back a code, and only then does the app exchange it for its own
    // session cookies. Page-load events fire before that finishes, so harvest
    // by polling for the cookies the manifest actually needs rather than
    // trusting a single wait.
    const wantedCookieNames = wanted.filter((w) => w.startsWith("cookie:"));
    const deadline = Date.now() + timeoutMs;
    let values: Record<string, string> = {};

    for (;;) {
      const cookies = await ctx.cookies();
      values = {};
      for (const c of cookies) {
        const key = `cookie:${c.name}`;
        if (wanted.length === 0 || wanted.includes(key)) values[key] = c.value;
      }
      const have = wantedCookieNames.filter((w) => values[w]).length;
      if (wantedCookieNames.length === 0 || have === wantedCookieNames.length) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // A session that has lapsed lands on a login page and yields none of the
    // cookies the manifest expects. Report that rather than returning a
    // half-populated session that will 401 confusingly.
    const got = wantedCookieNames.filter((w) => values[w]);
    if (wantedCookieNames.length > 0 && got.length === 0) return null;

    // Save ONLY after confirming the session authenticated. Saving before this
    // check overwrites a good stored session with a logged-out one whenever
    // re-auth fails, so a single transient failure would destroy the saved
    // session permanently and no later attempt could recover.
    await ctx.storageState({ path: storageStateFile(site) }).catch(() => {});

    return { values };
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
