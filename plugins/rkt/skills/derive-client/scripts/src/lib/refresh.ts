export type { RefreshSpec } from "./manifest-schema";

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  token_type?: string;
}

/**
 * Perform the refresh_token grant. Public-client form: no secret, client_id in
 * the body (verified against Keycloak's documented token endpoint contract).
 * Returns null when the grant is refused, which is the signal to fall back to
 * browser re-auth rather than to keep retrying.
 */
export async function refreshViaOidc(
  spec: Extract<import("./manifest-schema").RefreshSpec, { kind: "oidc" }>,
  refreshToken: string,
  userAgent: string,
): Promise<RefreshedTokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: spec.clientId,
  });

  let res: Response;
  try {
    res = await fetch(spec.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": userAgent,
      },
      body: body.toString(),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let parsed: TokenResponse;
  try {
    parsed = (await res.json()) as TokenResponse;
  } catch {
    return null;
  }
  if (!parsed.access_token) return null;

  return {
    accessToken: parsed.access_token,
    // Providers rotate refresh tokens; persist the new one or the next
    // refresh fails with the now-consumed original.
    refreshToken: parsed.refresh_token ?? null,
    expiresIn: parsed.expires_in ?? null,
  };
}
