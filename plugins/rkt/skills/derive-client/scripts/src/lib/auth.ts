import type { HarEntry } from "./har";

export interface CredentialCandidate {
  kind: "cookie" | "bearer" | "csrf";
  location: string;
  coverage: number;
  value: string;
}

/** Cookie names that look like session credentials rather than preferences. */
const SESSION_COOKIE = /sess|auth|token|sid|jwt|login|identity|csrf|xsrf/i;

/**
 * Headers that carry a CSRF token. x-requested-with is deliberately excluded:
 * its value is the constant "XMLHttpRequest", so it would win on coverage and
 * be persisted as the site's "secret".
 */
const CSRF_HEADER = /^x-(csrf|xsrf)-token$/i;

/** Values that are structurally credential-shaped but carry no secret. */
const NON_SECRET_VALUES = new Set([
  "xmlhttprequest",
  "undefined",
  "null",
  "true",
  "false",
  "none",
  "0",
  "1",
]);

/** Shorter than this cannot be a meaningful credential, and short values
 *  produce false positives when substring-matched against response bodies. */
export const MIN_SECRET_LENGTH = 8;

function isPlausibleSecret(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (NON_SECRET_VALUES.has(value.toLowerCase())) return false;
  return true;
}

function parseCookies(header: string): Array<[string, string]> {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1
        ? ([part, ""] as [string, string])
        : ([part.slice(0, eq), part.slice(eq + 1)] as [string, string]);
    });
}

export function detectCredentials(entries: HarEntry[]): CredentialCandidate[] {
  const total = entries.length;
  if (total === 0) return [];

  const seen = new Map<
    string,
    { kind: CredentialCandidate["kind"]; value: string; count: number }
  >();

  const bump = (location: string, kind: CredentialCandidate["kind"], value: string) => {
    const existing = seen.get(location);
    if (existing) existing.count += 1;
    else seen.set(location, { kind, value, count: 1 });
  };

  for (const e of entries) {
    const auth = e.requestHeaders["authorization"];
    if (auth && /^bearer\s+\S+/i.test(auth)) {
      if (isPlausibleSecret(auth.replace(/^bearer\s+/i, ""))) {
        bump("authorization", "bearer", auth);
      }
    }

    const cookie = e.requestHeaders["cookie"];
    if (cookie) {
      for (const [name, value] of parseCookies(cookie)) {
        if (SESSION_COOKIE.test(name) && isPlausibleSecret(value)) {
          bump(`cookie:${name}`, "cookie", value);
        }
      }
    }

    for (const [name, value] of Object.entries(e.requestHeaders)) {
      if (CSRF_HEADER.test(name) && isPlausibleSecret(value)) {
        bump(name, "csrf", value);
      }
    }
  }

  return [...seen.entries()]
    .map(([location, v]) => ({ kind: v.kind, location, coverage: v.count / total, value: v.value }))
    .sort((a, b) => b.coverage - a.coverage);
}
