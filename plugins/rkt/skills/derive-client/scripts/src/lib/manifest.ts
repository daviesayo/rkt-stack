import type { EndpointGroup, JsonShape, ParamSpec } from "./synthesize";
import { inferShape } from "./synthesize";

export const SCHEMA_VERSION = 1;

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

export interface BuildManifestInput {
  site: string;
  groups: EndpointGroup[];
  harSha256: string;
  recordedAt: string;
  auth?: AuthSpec | null;
}

function endpointId(method: string, pathTemplate: string): string {
  const path = pathTemplate
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/^\{(\w+)\}$/, "$1"))
    .join(".");
  return `${method.toLowerCase()}.${path}`;
}

export function buildManifest(input: BuildManifestInput): ClientManifest {
  const { site, groups, harSha256, recordedAt } = input;
  const origins = new Set(groups.map((g) => g.origin));
  if (origins.size > 1) {
    const listed = [...origins].sort().join(", ");
    throw new Error(
      `recording spans multiple origins (${listed}); Plan 1 supports one API origin per manifest — record a narrower section or wait for origin-qualified endpoint ids (Plan 2)`,
    );
  }
  const first = groups[0]?.samples[0];

  const endpoints: ManifestEndpoint[] = groups.map((g) => {
    const isHtml = /text\/html/i.test(g.samples[0]?.mimeType ?? "");
    return {
      id: endpointId(g.method, g.pathTemplate),
      method: g.method,
      pathTemplate: g.pathTemplate,
      params: g.params,
      responseShape: isHtml
        ? { type: "unknown" }
        : inferShape(g.samples.map((s) => s.responseBody ?? "")),
      source: isHtml ? "scrape" : "xhr",
      fragile: isHtml,
      selectors: null,
      writeSemantics: null,
    };
  });

  const clientHints: Record<string, string> = {};
  for (const key of ["sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile"]) {
    const value = first?.requestHeaders[key];
    if (value) clientHints[key] = value;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    site,
    baseUrl: groups[0]?.origin ?? "",
    recordedAt,
    harSha256,
    userAgent: first?.requestHeaders["user-agent"] ?? "",
    clientHints,
    auth: input.auth ?? null,
    endpoints,
  };
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
  return m as ClientManifest;
}
