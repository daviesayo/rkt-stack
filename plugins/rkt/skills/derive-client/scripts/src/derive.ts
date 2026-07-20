/**
 * Derivation CLI: reads a recorded HAR and emits client.json.
 *
 * Usage: bun src/derive.ts --site <site> --har <path/to/session.har.zip>
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { filterEntries, type DropRecord } from "./lib/filter";
import { readHar } from "./lib/har";
import { buildManifest, type ClientManifest } from "./lib/manifest";
import { assertUnderRktRoot } from "./lib/paths";
import { groupEndpoints } from "./lib/synthesize";

export async function deriveManifest(
  harPath: string,
  site: string,
): Promise<{ manifest: ClientManifest; dropped: DropRecord[] }> {
  const absHar = assertUnderRktRoot(resolve(harPath));
  const entries = await readHar(absHar);
  const { kept, dropped } = filterEntries(entries);
  const groups = groupEndpoints(kept);

  const harSha256 = createHash("sha256").update(await readFile(absHar)).digest("hex");
  const recordedAt = entries[0]?.startedDateTime ?? new Date().toISOString();

  return { manifest: buildManifest({ site, groups, harSha256, recordedAt }), dropped };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const site = arg("site");
  const har = arg("har");
  if (!site || !har) {
    console.error("usage: bun src/derive.ts --site <site> --har <path>");
    process.exit(1);
  }

  const absHar = assertUnderRktRoot(resolve(har));
  const { manifest, dropped } = await deriveManifest(absHar, site);
  const outPath = `${dirname(absHar)}/client.json`;
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.error(`Derived ${manifest.endpoints.length} endpoint(s) -> ${outPath}`);
  console.error(`Filtered out ${dropped.length} request(s).`);
  for (const endpoint of manifest.endpoints) {
    console.error(`  ${endpoint.method} ${endpoint.pathTemplate}  [${endpoint.id}]`);
  }
  if (manifest.endpoints.length === 0) {
    console.error(
      "\nNo endpoints derived. If the site routes API calls through a Service Worker, " +
        "the recording will be empty even though the site worked. Re-record and confirm " +
        "serviceWorkers: 'block' was in effect.",
    );
  }
}

if (import.meta.main) {
  await main();
}
