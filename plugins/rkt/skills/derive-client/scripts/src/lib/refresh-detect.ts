import type { HarEntry } from "./har";
import type { RefreshSpec } from "./manifest-schema";

export interface RefreshDetection {
  spec: RefreshSpec | null;
  /** The refresh token observed, if any. Secret: never goes in a manifest. */
  refreshToken: string | null;
  notes: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  token_type?: string;
}

function postParams(entry: HarEntry): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = entry.postData ?? "";
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

/**
 * Find an OIDC token exchange in the recording and derive how to repeat it.
 *
 * Looks for a POST whose response carries access_token plus refresh_token.
 * That shape is the OAuth 2 token endpoint (RFC 6749) regardless of vendor,
 * so this works for Keycloak, Auth0, Okta, Entra and anything else standard,
 * rather than special-casing one product.
 */
export function detectRefresh(
  entries: HarEntry[],
  entryUrl: string,
  accessTokenCookie: string | null,
): RefreshDetection {
  const notes: string[] = [];

  for (const e of entries) {
    if (e.method.toUpperCase() !== "POST") continue;
    if (!e.responseBody) continue;

    let body: TokenResponse;
    try {
      body = JSON.parse(e.responseBody) as TokenResponse;
    } catch {
      continue;
    }
    if (!body.access_token) continue;

    const params = postParams(e);
    const clientId = params.client_id ?? "";

    if (!body.refresh_token) {
      notes.push(
        `token endpoint ${e.url} returned an access token with no refresh token; ` +
          `browser re-auth will be used instead`,
      );
      continue;
    }
    if (!clientId) {
      notes.push(
        `token endpoint ${e.url} had no client_id in its request body; ` +
          `cannot repeat the grant, falling back to browser re-auth`,
      );
      continue;
    }

    if (body.refresh_expires_in && body.refresh_expires_in < 86400) {
      notes.push(
        `refresh token lives ${body.refresh_expires_in}s (${(body.refresh_expires_in / 3600).toFixed(1)}h). ` +
          `A client idle longer than that falls back to browser re-auth.`,
      );
    }

    return {
      spec: {
        kind: "oidc",
        tokenEndpoint: e.url,
        clientId,
        accessTokenCookie,
        expiresIn: body.expires_in ?? null,
        refreshExpiresIn: body.refresh_expires_in ?? null,
      },
      refreshToken: body.refresh_token,
      notes,
    };
  }

  notes.push("no OAuth token exchange found; falling back to browser re-auth");
  return { spec: { kind: "browser", entryUrl }, refreshToken: null, notes };
}
