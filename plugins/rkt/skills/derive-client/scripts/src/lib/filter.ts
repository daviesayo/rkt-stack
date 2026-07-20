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

export function filterEntries(entries: HarEntry[]): FilterResult {
  const kept: HarEntry[] = [];
  const dropped: DropRecord[] = [];

  for (const e of entries) {
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
    if (e.responseBody === null || e.responseBody.length === 0) {
      dropped.push({ url: e.url, reason: "empty response body" });
      continue;
    }
    if (!DATA_MIME.test(e.mimeType)) {
      dropped.push({ url: e.url, reason: `non-data content type (${e.mimeType})` });
      continue;
    }
    kept.push(e);
  }

  return { kept, dropped };
}
