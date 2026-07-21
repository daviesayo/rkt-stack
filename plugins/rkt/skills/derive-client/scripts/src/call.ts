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
import { createScheduler } from "./lib/scheduler";
import { maskHeaders, readSecrets, redactAll } from "./lib/secrets";
import { createCaller } from "./lib/runtime";
import { buildRequest, type BuiltRequest } from "./lib/transport";

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

  if (process.argv.includes("--dry-run")) {
    const built = buildRequest(manifest, endpoint, params, secret);
    console.log(formatDryRunPreview(built, secret));
    return;
  }

  const scheduler = createScheduler();
  const caller = createCaller(manifest, scheduler, secret);
  const { status, body } = await caller.call(endpoint.id, params);

  if (status >= 400) {
    console.error(`HTTP ${status}`);
    console.error(redactAll(body, caller.secret).slice(0, 2000));
    process.exit(1);
  }
  console.log(redactAll(body, caller.secret));
}

if (import.meta.main) {
  await main();
}
