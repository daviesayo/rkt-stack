import type { EndpointGroup } from "./synthesize";
import { inferShape } from "./synthesize";
import type { AuthSpec, ClientManifest, ManifestEndpoint } from "./manifest-schema";
import { SCHEMA_VERSION, validateManifest } from "./manifest-schema";

export type { AuthSpec, ClientManifest, ManifestEndpoint } from "./manifest-schema";
export { SCHEMA_VERSION, validateManifest } from "./manifest-schema";

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
