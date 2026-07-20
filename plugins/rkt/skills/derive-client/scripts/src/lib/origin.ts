import type { HarEntry } from "./har";

export interface OriginPick {
  /** The origin that carries the site's own API traffic. */
  primary: string;
  /** Every other origin seen, with why it lost, for reporting. */
  rejected: Array<{ origin: string; jsonResponses: number; reason: string }>;
}

/**
 * Third-party origins that are never a site's own API, even when they serve
 * JSON. Kept separate from filter.ts's analytics list because these are
 * embedded product widgets and vendor telemetry rather than pure analytics.
 */
const THIRD_PARTY = [
  "sendbird.com",
  "nr-data.net",
  "newrelic.com",
  "pendo.io",
  "cloudflareinsights.com",
  "gstatic.com",
  "googleapis.com",
  "google.com",
  "gravatar.com",
  "zendesk.com",
  "zdassets.com",
  "walkme.com",
  "appcues.com",
  "launchdarkly.com",
  "split.io",
  "optimizely.com",
  "bugsnag.com",
  "rollbar.com",
  "logrocket.com",
  "clarity.ms",
];

/** Hosts that look like an identity provider rather than an API. */
const IDENTITY_HINT = /(^|\.)(identity|auth|login|sso|accounts|idp|oauth)\d*\./i;

/** Path fragments that mark a request as an identity handshake. */
const IDENTITY_PATH = /\/(openid-connect|oauth2?|saml|realms)\//i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isThirdParty(host: string): boolean {
  return THIRD_PARTY.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isIdentityHost(host: string): boolean {
  return IDENTITY_HINT.test(host);
}

export function isIdentityRequest(url: string): boolean {
  const host = hostOf(url);
  if (host && isIdentityHost(host)) return true;
  return IDENTITY_PATH.test(url);
}

/**
 * Choose the origin carrying the site's own API.
 *
 * Real apps span many origins: an asset CDN, vendor telemetry, an embedded
 * chat widget, an identity provider. Treating that as an error (as the
 * previous hard-fail did) makes any modern SPA underivable, and the advice to
 * "record a narrower section" is wrong because those origins fire on every
 * page. Instead, rank origins by how much JSON they actually return and pick
 * the winner, reporting what was dropped.
 */
export function pickPrimaryOrigin(entries: HarEntry[]): OriginPick | null {
  const jsonCount = new Map<string, number>();
  const anyCount = new Map<string, number>();

  for (const e of entries) {
    const host = hostOf(e.url);
    if (!host) continue;
    anyCount.set(host, (anyCount.get(host) ?? 0) + 1);
    if (/json/i.test(e.mimeType) && e.status >= 200 && e.status < 300) {
      jsonCount.set(host, (jsonCount.get(host) ?? 0) + 1);
    }
  }

  const hosts = [...anyCount.keys()];
  if (hosts.length === 0) return null;

  const eligible = hosts.filter((h) => !isThirdParty(h) && !isIdentityHost(h));
  const ranked = (eligible.length > 0 ? eligible : hosts).sort(
    (a, b) => (jsonCount.get(b) ?? 0) - (jsonCount.get(a) ?? 0) || a.localeCompare(b),
  );

  // Prefer the JSON leader; if nothing returned JSON at all, fall back to the
  // busiest eligible origin so HTML-only sites (whose data is scraped, not
  // fetched) still derive rather than failing outright.
  let primary = ranked[0];
  if ((jsonCount.get(primary) ?? 0) === 0) {
    primary = [...(eligible.length > 0 ? eligible : hosts)].sort(
      (a, b) => (anyCount.get(b) ?? 0) - (anyCount.get(a) ?? 0) || a.localeCompare(b),
    )[0];
  }

  const rejected = hosts
    .filter((h) => h !== primary)
    .map((h) => ({
      origin: h,
      jsonResponses: jsonCount.get(h) ?? 0,
      reason: isThirdParty(h)
        ? "third-party widget or vendor telemetry"
        : isIdentityHost(h)
          ? "identity provider, not an API surface"
          : "fewer JSON responses than the primary origin",
    }))
    .sort((a, b) => b.jsonResponses - a.jsonResponses);

  return { primary, rejected };
}
