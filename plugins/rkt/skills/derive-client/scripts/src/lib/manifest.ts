import type { AuthBundle, AuthSpec, ClientManifest, ManifestEndpoint, RefreshSpec } from "./manifest-schema";
import type { EndpointGroup } from "./synthesize";
import { inferShape } from "./synthesize";
import { SCHEMA_VERSION, validateManifest } from "./manifest-schema";

export type { AuthSpec, AuthBundle, ClientManifest, ManifestEndpoint, RefreshSpec } from "./manifest-schema";
export { SCHEMA_VERSION, validateManifest } from "./manifest-schema";

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
