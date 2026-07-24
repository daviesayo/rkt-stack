/**
 * Derivation CLI: reads a recorded HAR and emits client.json.
 *
 * Usage: bun src/derive.ts --site <site> --har <path/to/session.har.zip>
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeAuthBundle, type AuthBundle } from "./lib/auth";
import { filterEntries, type DropRecord } from "./lib/filter";
import { readHar } from "./lib/har";
import { buildManifest, type ClientManifest } from "./lib/manifest";
import { assertUnderRktRoot } from "./lib/paths";
import { REFRESH_TOKEN_KEY, writeSecret } from "./lib/secrets";
import { pickPrimaryOrigin, type OriginPick } from "./lib/origin";
import { detectRefresh } from "./lib/refresh-detect";
import type { RefreshSpec } from "./lib/manifest-schema";
import { groupEndpoints } from "./lib/synthesize";

export interface DeriveResult {
  manifest: ClientManifest;
  dropped: DropRecord[];
  /** location -> secret value, plus the refresh token under a reserved key. */
  secrets: Record<string, string>;
  origin: OriginPick | null;
  refresh: RefreshSpec | null;
  notes: string[];
}

export async function deriveManifest(
  harPath: string,
  site: string,
  opts: { mode?: "read" | "full" } = {},
): Promise<DeriveResult> {
  const absHar = assertUnderRktRoot(resolve(harPath));
  const entries = await readHar(absHar);
  const notes: string[] = [];

  // Choose the API origin before anything else. Real SPAs span an asset CDN,
  // vendor telemetry, an embedded chat widget and an identity provider; all of
  // those are noise, and treating them as an error made such sites underivable.
  const origin = pickPrimaryOrigin(entries);
  if (!origin) {
    throw new Error(
      "no origin in this recording returned JSON. If the site routes its API through a " +
        "Service Worker the HAR will be empty even though the site worked; re-record and " +
        "confirm serviceWorkers: 'block' was in effect.",
    );
  }
  for (const r of origin.rejected) {
    notes.push(`dropped origin ${r.origin} (${r.jsonResponses} JSON responses): ${r.reason}`);
  }

  const originEntries = entries.filter((e) => {
    try {
      return new URL(e.url).hostname === origin.primary;
    } catch {
      return false;
    }
  });

  const { kept, dropped } = filterEntries(originEntries, { allowWrites: opts.mode === "full" });
  const groups = groupEndpoints(kept);

  // Auth analysis sees the API-origin entries for coverage (so a credential
  // present on every API call scores 100%, not 20% of the whole recording),
  // and ALL entries for mint tracing, because the credential is minted on the
  // identity origin which was just filtered out.
  const { bundle, values, rejected } = analyzeAuthBundle(originEntries, entries);
  for (const r of rejected) {
    notes.push(`credential candidate ${r.location} excluded: ${r.reason}`);
  }

  // Access tokens on modern SPAs live minutes. Without a renewal path a
  // derived client is a one-shot toy, so find one now while the evidence is
  // still in the recording.
  const accessTokenCookie =
    bundle?.credentials
      .map((c) => c.location)
      .find((l) => l.startsWith("cookie:") && /token/i.test(l))
      ?.slice("cookie:".length) ?? null;

  const detected = detectRefresh(entries, `https://${origin.primary}/`, accessTokenCookie);
  notes.push(...detected.notes);

  const secrets: Record<string, string> = { ...values };
  if (detected.refreshToken) secrets[REFRESH_TOKEN_KEY] = detected.refreshToken;

  const harSha256 = createHash("sha256").update(await readFile(absHar)).digest("hex");
  const recordedAt = entries[0]?.startedDateTime ?? new Date().toISOString();

  return {
    manifest: buildManifest({
      site,
      groups,
      harSha256,
      recordedAt,
      auth: bundle?.credentials[0] ?? null,
      authBundle: bundle,
      refresh: detected.spec,
      mode: opts.mode,
    }),
    dropped,
    secrets,
    origin,
    refresh: detected.spec,
    notes,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * `--mode` is optional (omitted means "read"), but a value that IS given
 * must be recognized. A typo like `--mode ful` used to silently derive a
 * read-only client with no error, and the mistake only surfaced much later
 * as a missing endpoint.
 */
export function parseMode(raw: string | undefined): "read" | "full" {
  if (raw === undefined || raw === "read") return "read";
  if (raw === "full") return "full";
  throw new Error(`--mode must be "read" or "full" (got "${raw}")`);
}

async function main() {
  const site = arg("site");
  const har = arg("har");
  if (!site || !har) {
    console.error("usage: bun src/derive.ts --site <site> --har <path> [--mode full]");
    process.exit(1);
  }

  const mode = parseMode(arg("mode"));
  if (mode === "full") {
    console.error(
      "FULL MODE: write endpoints (POST/PUT/PATCH/DELETE) will be derived. " +
        "They stay inert until you author a write task and set RKT_ALLOW_WRITES.",
    );
  }

  const absHar = assertUnderRktRoot(resolve(har));
  const { manifest, dropped, secrets, origin, notes } = await deriveManifest(absHar, site, { mode });
  const outPath = `${dirname(absHar)}/client.json`;
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const credCount = Object.keys(secrets).filter((k) => k !== REFRESH_TOKEN_KEY).length;
  if (credCount > 0) {
    await writeSecret(site, secrets);
    console.error(`Stored ${credCount} credential(s) for "${site}" at 0600:`);
    for (const c of manifest.authBundle?.credentials ?? []) {
      console.error(`  ${c.kind.padEnd(7)} ${c.location}${c.expiry ? `  expires ${c.expiry}` : ""}`);
    }
    if (manifest.refresh?.kind === "oidc") {
      console.error(
        `Renewal: OIDC refresh against ${new URL(manifest.refresh.tokenEndpoint).host}` +
          (manifest.refresh.expiresIn ? ` (access token lives ${manifest.refresh.expiresIn}s)` : ""),
      );
    } else if (manifest.refresh?.kind === "browser") {
      console.error("Renewal: headless browser re-auth using the recorded Chrome profile.");
    }
  } else {
    console.error(
      "No credential detected. If this site needs auth, the recording may have " +
        "missed the authenticated requests.",
    );
  }

  console.error(`\nAPI origin: ${origin?.primary}`);
  for (const n of notes) console.error(`  note: ${n}`);
  console.error("");

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
