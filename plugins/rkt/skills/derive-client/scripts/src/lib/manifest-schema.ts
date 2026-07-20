export const SCHEMA_VERSION = 2;

export interface ParamSpec {
  name: string;
  in: "path" | "query";
  type: "string" | "number";
  /** Present on every recorded sample, so the API almost certainly demands it. */
  required?: boolean;
  /** A value observed during recording, used as a default so calls work as-is. */
  example?: string;
}

export type JsonShape =
  | { type: "object"; properties: Record<string, JsonShape>; required: string[] }
  | { type: "array"; items: JsonShape }
  | { type: "string" | "number" | "boolean" | "null" | "unknown" };

export interface AuthSpec {
  kind: "cookie" | "bearer" | "csrf";
  location: string;
  mintedBy: string | null;
  expiry: string | null;
}

export interface AuthBundle {
  credentials: AuthSpec[];
  earliestExpiry: string | null;
}

export type RefreshSpec =
  | {
      kind: "oidc";
      /** Full token endpoint URL, e.g. https://idp/realms/x/protocol/openid-connect/token */
      tokenEndpoint: string;
      clientId: string;
      /** Cookie name the refreshed access token must be written back into, if any. */
      accessTokenCookie: string | null;
      /** Seconds the access token is valid, as observed. */
      expiresIn: number | null;
      /** Seconds the refresh token is valid, as observed. */
      refreshExpiresIn: number | null;
    }
  | {
      /** Relaunch the recorded Chrome profile headless and harvest fresh cookies. */
      kind: "browser";
      /** URL to load so the app performs its own token dance. */
      entryUrl: string;
    };

export interface ManifestEndpoint {
  id: string;
  method: string;
  pathTemplate: string;
  params: ParamSpec[];
  responseShape: JsonShape;
  source: "xhr" | "scrape";
  fragile: boolean;
  selectors: Record<string, string> | null;
  writeSemantics: null;
  stale?: boolean;
}

export interface ClientManifest {
  schemaVersion: number;
  site: string;
  baseUrl: string;
  recordedAt: string;
  harSha256: string;
  userAgent: string;
  clientHints: Record<string, string>;
  auth: AuthSpec | null;
  /** Every credential the API requires. Preferred over `auth`. */
  authBundle: AuthBundle | null;
  /** How to renew credentials when they go stale. */
  refresh: RefreshSpec | null;
  endpoints: ManifestEndpoint[];
}

export function validateManifest(value: unknown): ClientManifest {
  const m = value as Partial<ClientManifest>;
  if (typeof m !== "object" || m === null) {
    throw new Error("manifest must be an object");
  }
  if (m.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported manifest schema version ${String(m.schemaVersion)}; expected ${SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(m.endpoints)) {
    throw new Error("manifest must have an endpoints array");
  }
  if (typeof m.site !== "string" || m.site.length === 0) {
    throw new Error("manifest must have a site");
  }
  if (m.site.includes("..") || /[/\\]/.test(m.site)) {
    throw new Error(`manifest site must be a single path segment, got ${JSON.stringify(m.site)}`);
  }
  return m as ClientManifest;
}
