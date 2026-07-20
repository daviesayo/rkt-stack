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
import { maskHeaders, readSecrets, redactAll, writeSecret } from "./lib/secrets";
import { refreshViaOidc } from "./lib/refresh";
import { REFRESH_TOKEN_KEY } from "./derive";
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

  // Modern SPAs hold access tokens measured in minutes, so a 401 usually means
  // "stale", not "wrong". Renew once and retry before reporting failure.
  if (status === 401 && secret && manifest.refresh?.kind === "oidc") {
    const rt = secret[REFRESH_TOKEN_KEY];
    if (rt) {
      console.error("credential rejected (401); refreshing via OIDC and retrying once...");
      const renewed = await refreshViaOidc(manifest.refresh, rt, manifest.userAgent);
      if (renewed) {
        const updated = { ...secret };
        const cookieName = manifest.refresh.accessTokenCookie;
        if (cookieName) updated[`cookie:${cookieName}`] = renewed.accessToken;
        const bearer = manifest.authBundle?.credentials.find((c) => c.kind === "bearer");
        if (bearer) updated[bearer.location] = `Bearer ${renewed.accessToken}`;
        // Providers rotate refresh tokens; persist the new one or the next
        // refresh fails against an already-consumed token.
        if (renewed.refreshToken) updated[REFRESH_TOKEN_KEY] = renewed.refreshToken;
        await writeSecret(manifest.site, updated);

        built = buildRequest(manifest, endpoint, params, updated);
        ({ status, body } = await issue(built, limiter));
      } else {
        console.error(
          "refresh was refused. The refresh token has likely expired too; " +
            "re-run /derive-client to re-authenticate.",
        );
      }
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
