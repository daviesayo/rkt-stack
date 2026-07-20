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

/**
 * Find the response that produced this credential. Returns null when the
 * credential was already present when recording began, which is normal for a
 * profile authenticated in an earlier session.
 */
export function traceMintPoint(
  candidate: CredentialCandidate,
  entries: HarEntry[],
): string | null {
  const secret = candidate.kind === "bearer"
    ? candidate.value.replace(/^bearer\s+/i, "")
    : candidate.value;
  if (secret.length === 0) return null;

  const cookieName = candidate.location.startsWith("cookie:")
    ? candidate.location.slice("cookie:".length)
    : null;

  for (const e of entries) {
    if (cookieName) {
      const setCookie = e.responseHeaders["set-cookie"];
      if (setCookie) {
        const pattern = new RegExp(
          `(^|[,;\\s])${escapeRegExp(cookieName)}=${escapeRegExp(secret)}(;|,|\\s|$)`,
        );
        if (pattern.test(setCookie)) return e.url;
      }
    }
    // Substring matching is only safe for values long enough to be unlikely
    // to occur incidentally in an unrelated response body.
    if (
      secret.length >= MIN_SECRET_LENGTH &&
      e.responseBody &&
      e.responseBody.includes(secret)
    ) {
      return e.url;
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort expiry, as an ISO timestamp. A JWT exp claim wins; otherwise
 * fall back to cookie attributes. Null means "not discoverable", not an error.
 */
export function detectExpiry(
  candidate: CredentialCandidate,
  entries: HarEntry[],
): string | null {
  const secret = candidate.kind === "bearer"
    ? candidate.value.replace(/^bearer\s+/i, "")
    : candidate.value;

  const fromJwt = jwtExpiry(secret);
  if (fromJwt) return fromJwt;

  const cookieName = candidate.location.startsWith("cookie:")
    ? candidate.location.slice("cookie:".length)
    : null;
  if (!cookieName) return null;

  for (const e of entries) {
    const setCookie = e.responseHeaders["set-cookie"];
    if (!setCookie) continue;
    if (
      !new RegExp(`(^|[,;\\s])${escapeRegExp(cookieName)}=${escapeRegExp(secret)}`).test(setCookie)
    ) {
      continue;
    }

    const maxAge = setCookie.match(/Max-Age=(\d+)/i);
    if (maxAge) {
      const base = Date.parse(e.startedDateTime);
      if (Number.isFinite(base)) {
        return new Date(base + Number(maxAge[1]) * 1000).toISOString();
      }
    }

    const expires = setCookie.match(/Expires=([^;,]+(?:,[^;]+)?)/i);
    if (expires) {
      const parsed = Date.parse(expires[1].trim());
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return null;
}

function jwtExpiry(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload?.exp !== "number") return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}
