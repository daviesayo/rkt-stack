/**
 * Invoke a single derived read endpoint.
 *
 * Usage:
 *   bun src/call.ts --manifest <path> --endpoint <id> [--param k=v ...] [--dry-run]
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifest } from "./lib/manifest";
import { assertUnderRktRoot } from "./lib/paths";
import { createLimiter } from "./lib/ratelimit";
import { maskHeaders, readSecrets, redactAll, REFRESH_TOKEN_KEY, writeSecret } from "./lib/secrets";
import { refreshViaOidc } from "./lib/refresh";
import { reauthViaProfile } from "./lib/reauth";
import { buildRequest, issue, type BuiltRequest } from "./lib/transport";

export function parseParams(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--param") continue;
    const pair = argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq === -1) throw new Error(`bad --param ${JSON.stringify(pair)}: expected k=v`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function formatDryRunPreview(
  built: BuiltRequest,
  secret: Record<string, string> | string | null,
): string {
  const preview = {
    method: built.method,
    url: built.url,
    headers: maskHeaders(built.headers, secret),
  };
  return JSON.stringify(preview, null, 2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const manifestPath = arg("manifest");
  const endpointId = arg("endpoint");
  if (!manifestPath || !endpointId) {
    console.error(
      "usage: bun src/call.ts --manifest <path> --endpoint <id> [--param k=v ...] [--dry-run]",
    );
    process.exit(1);
  }

  const abs = assertUnderRktRoot(resolve(manifestPath));
  const manifest = validateManifest(JSON.parse(await readFile(abs, "utf8")));

  const endpoint = manifest.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) {
    console.error(`unknown endpoint: ${endpointId}`);
    console.error("available:");
    for (const e of manifest.endpoints) console.error(`  ${e.id}  ${e.method} ${e.pathTemplate}`);
    process.exit(1);
  }

  if (endpoint.source === "scrape") {
    console.error(
      `endpoint ${endpoint.id} is HTML-scraped; scrape endpoints arrive in a later release`,
    );
    process.exit(1);
  }

  const secret = await readSecrets(manifest.site);
  if (manifest.auth && !secret) {
    console.error(
      `no stored credential for "${manifest.site}". Re-run derive on a recording ` +
        `that includes authenticated requests.`,
    );
    process.exit(1);
  }

  if (manifest.auth?.expiry && Date.parse(manifest.auth.expiry) < Date.now()) {
    console.error(
      `warning: stored credential expired at ${manifest.auth.expiry}; ` +
        `expect a 401. Re-record to refresh it.`,
    );
  }

  // Throws for any non-GET/HEAD endpoint.
  const params = parseParams(process.argv);
  let built = buildRequest(manifest, endpoint, params, secret);

  if (process.argv.includes("--dry-run")) {
    console.log(formatDryRunPreview(built, secret));
    return;
  }

  const limiter = createLimiter();
  let { status, body } = await issue(built, limiter);

  // A 401 on a derived client almost always means "stale", not "wrong".
  // Renew and retry once before reporting failure. Tiers run cheapest first:
  // an OIDC refresh is a single POST, while browser re-auth costs a headless
  // Chrome launch but survives a refresh token that has also expired.
  if (status === 401 && secret) {
    let renewedValues: Record<string, string> | null = null;

    if (manifest.refresh?.kind === "oidc" && secret[REFRESH_TOKEN_KEY]) {
      console.error("credential rejected (401); refreshing via OIDC...");
      const renewed = await refreshViaOidc(
        manifest.refresh,
        secret[REFRESH_TOKEN_KEY],
        manifest.userAgent,
      );
      if (renewed) {
        renewedValues = { ...secret };
        const cookieName = manifest.refresh.accessTokenCookie;
        if (cookieName) renewedValues[`cookie:${cookieName}`] = renewed.accessToken;
        const bearer = manifest.authBundle?.credentials.find((c) => c.kind === "bearer");
        if (bearer) renewedValues[bearer.location] = `Bearer ${renewed.accessToken}`;
        // Providers rotate refresh tokens; persist the new one or the next
        // refresh fails against an already-consumed token.
        if (renewed.refreshToken) renewedValues[REFRESH_TOKEN_KEY] = renewed.refreshToken;
      } else {
        console.error("OIDC refresh refused; falling back to browser re-auth...");
      }
    }

    if (!renewedValues) {
      const entryUrl =
        manifest.refresh?.kind === "browser" ? manifest.refresh.entryUrl : `${manifest.baseUrl}/`;
      const wanted = (manifest.authBundle?.credentials ?? []).map((c) => c.location);
      console.error("re-authenticating with the recorded browser profile...");
      let harvested = null;
      try {
        harvested = await reauthViaProfile(manifest.site, entryUrl, wanted);
      } catch (err) {
        // A missing dependency is not an expired session; say which it is.
        console.error((err as Error).message);
      }
      if (harvested) {
        renewedValues = { ...secret, ...harvested.values };
      } else {
        console.error(
          `could not re-authenticate "${manifest.site}". The saved browser profile is no ` +
            `longer signed in; re-run /derive-client to sign in again.`,
        );
      }
    }

    if (renewedValues) {
      await writeSecret(manifest.site, renewedValues);
      built = buildRequest(manifest, endpoint, params, renewedValues);
      ({ status, body } = await issue(built, limiter));
    }
  }

  if (status >= 400) {
    console.error(`HTTP ${status}`);
    console.error(redactAll(body, secret).slice(0, 2000));
    process.exit(1);
  }
  console.log(redactAll(body, secret));
}

if (import.meta.main) {
  await main();
}
