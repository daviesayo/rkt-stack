import type { AuthBundle } from "./auth";
import type { RefreshSpec } from "./refresh";
import type { EndpointGroup, JsonShape, ParamSpec } from "./synthesize";
import { inferShape } from "./synthesize";

/**
 * 2: auth became a bundle (sites need several credentials at once) and gained
 *    a refresh spec. Version 1 manifests are rejected: their single static
 *    credential produces a client that 401s on any site with short-lived
 *    tokens, so failing loudly beats replaying a dead credential.
 */
export const SCHEMA_VERSION = 2;

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
  /** Every credential the API requires. Preferred over `auth`. */
  authBundle: AuthBundle | null;
  /** How to renew credentials when they go stale. */
  refresh: RefreshSpec | null;
  endpoints: ManifestEndpoint[];
}

export interface BuildManifestInput {
  site: string;
  groups: EndpointGroup[];
  harSha256: string;
  recordedAt: string;
  auth?: AuthSpec | null;
  authBundle?: AuthBundle | null;
  refresh?: RefreshSpec | null;
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
  // Origin selection happens in derive.ts before grouping, so by here every
  // group shares one origin. Kept as an assertion rather than the old
  // hard-fail, which made any multi-origin SPA underivable.
  const origins = new Set(groups.map((g) => g.origin));
  if (origins.size > 1) {
    throw new Error(
      `internal: buildManifest received ${origins.size} origins (${[...origins].sort().join(", ")}); ` +
        `derive.ts must select a primary origin before grouping`,
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
    authBundle: input.authBundle ?? null,
    refresh: input.refresh ?? null,
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
