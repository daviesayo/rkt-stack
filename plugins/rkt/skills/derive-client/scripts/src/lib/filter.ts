import type { HarEntry } from "./har";

export interface DropRecord {
  url: string;
  reason: string;
}

export interface FilterResult {
  kept: HarEntry[];
  dropped: DropRecord[];
}

const STATIC_MIME = /^(image|font|video|audio)\/|javascript|text\/css|application\/wasm/i;

const ANALYTICS_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "segment.io",
  "segment.com",
  "posthog.com",
  "mixpanel.com",
  "amplitude.com",
  "sentry.io",
  "datadoghq.com",
  "intercom.io",
  "hotjar.com",
  "fullstory.com",
  "newrelic.com",
];

const DATA_MIME = /json|text\/html|xml/i;

/**
 * JSON that is shipped as a build artifact rather than served by an API:
 * micro-frontend manifests, webpack/federation manifests, i18n bundles,
 * source maps. These pass a mime-type check but are not endpoints, and on a
 * modern SPA they outnumber the real API surface.
 */
const STATIC_JSON_PATH =
  /\.(json|map)$|\/(shell|assets?|static|build|dist|locales?|i18n|webapp)\//i;

const READ_METHODS = new Set(["GET", "HEAD"]);

export interface FilterOptions {
  /** Full mode only. Read mode never derives endpoints that mutate state. */
  allowWrites?: boolean;
}

export function filterEntries(
  entries: HarEntry[],
  options: FilterOptions = {},
): FilterResult {
  const kept: HarEntry[] = [];
  const dropped: DropRecord[] = [];

  for (const e of entries) {
    if (!options.allowWrites && !READ_METHODS.has(e.method.toUpperCase())) {
      dropped.push({
        url: e.url,
        reason: `write method (${e.method}); read mode derives GET and HEAD only`,
      });
      continue;
    }
    let host = "";
    try {
      host = new URL(e.url).hostname;
    } catch {
      dropped.push({ url: e.url, reason: "unparseable URL" });
      continue;
    }

    if (ANALYTICS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      dropped.push({ url: e.url, reason: `analytics or telemetry host (${host})` });
      continue;
    }
    if (STATIC_MIME.test(e.mimeType)) {
      dropped.push({ url: e.url, reason: `static asset (${e.mimeType})` });
      continue;
    }
    if (e.status < 200 || e.status >= 300) {
      dropped.push({ url: e.url, reason: `non-success status (${e.status})` });
      continue;
    }
    const isWrite = !READ_METHODS.has(e.method.toUpperCase());

    // Response-quality gates judge whether a RESPONSE is useful data. A write is
    // kept for its REQUEST, and a 204 legitimately has neither body nor
    // content-type, so these two gates apply to reads only.
    if (!isWrite && (e.responseBody === null || e.responseBody.length === 0)) {
      dropped.push({ url: e.url, reason: "empty response body" });
      continue;
    }
    if (!isWrite && !DATA_MIME.test(e.mimeType)) {
      dropped.push({ url: e.url, reason: `non-data content type (${e.mimeType})` });
      continue;
    }
    if (/json/i.test(e.mimeType) && STATIC_JSON_PATH.test(new URL(e.url).pathname)) {
      dropped.push({ url: e.url, reason: "build artifact, not an API endpoint" });
      continue;
    }
    kept.push(e);
  }

  return { kept, dropped };
}
