export const SCHEMA_VERSION = 1;

export interface ParamSpec {
  name: string;
  in: "path" | "query";
  type: "string" | "number";
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
