import { profileDir } from "./paths";

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
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchPersistentContext(userDataDir: string, options?: Record<string, unknown>): Promise<ReauthContext>;
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
  if (!chromium) return null;

  let context: ReauthContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profileDir(site), {
      channel: "chrome",
      headless: true,
      serviceWorkers: "block",
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // The token exchange happens after load, so wait for the network to settle
    // rather than assuming the credential exists the moment the DOM is ready.
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

    const cookies = await context.cookies();
    const values: Record<string, string> = {};
    for (const c of cookies) {
      const key = `cookie:${c.name}`;
      if (wanted.length === 0 || wanted.includes(key)) values[key] = c.value;
    }

    // A profile whose SSO session has lapsed lands on a login page and yields
    // none of the cookies the manifest expects. Report that rather than
    // returning a half-populated session that will 401 confusingly.
    const wantedCookies = wanted.filter((w) => w.startsWith("cookie:"));
    const got = wantedCookies.filter((w) => values[w]);
    if (wantedCookies.length > 0 && got.length === 0) return null;

    return { values };
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => {});
  }
}
