import type { ClientManifest, ManifestEndpoint } from "./manifest";

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

export function buildRequest(
  manifest: ClientManifest,
  endpoint: ManifestEndpoint,
  params: Record<string, string>,
  secret: string | null,
): BuiltRequest {
  // Defence in depth: the filter pass should already have excluded writes,
  // but nothing reaches the network without passing this check too.
  if (!READ_METHODS.has(endpoint.method.toUpperCase())) {
    throw new Error(
      `refusing ${endpoint.method} ${endpoint.pathTemplate}: read mode issues GET and HEAD only`,
    );
  }

  let path = endpoint.pathTemplate;
  for (const p of endpoint.params.filter((x) => x.in === "path")) {
    const value = params[p.name];
    if (value === undefined) throw new Error(`missing required path param: ${p.name}`);
    path = path.replace(`{${p.name}}`, encodeURIComponent(value));
  }

  const query = new URLSearchParams();
  for (const p of endpoint.params.filter((x) => x.in === "query")) {
    const value = params[p.name];
    if (value !== undefined) query.set(p.name, value);
  }

  const qs = query.toString();
  const url = `${manifest.baseUrl}${path}${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = {
    "user-agent": manifest.userAgent,
    accept: "application/json, text/plain, */*",
    ...manifest.clientHints,
  };

  const auth = manifest.auth;
  if (auth && secret) {
    if (auth.kind === "cookie") {
      const name = auth.location.startsWith("cookie:")
        ? auth.location.slice("cookie:".length)
        : auth.location;
      headers["cookie"] = `${name}=${secret}`;
    } else {
      headers[auth.location.toLowerCase()] = secret;
    }
  }

  return { url, method: endpoint.method, headers };
}

export async function issue(
  built: BuiltRequest,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{ status: number; body: string }> {
  if (!READ_METHODS.has(built.method.toUpperCase())) {
    throw new Error(
      `refusing ${built.method} ${built.url}: read mode issues GET and HEAD only`,
    );
  }

  return limit(async () => {
    const res = await fetch(built.url, { method: built.method, headers: built.headers });
    return { status: res.status, body: await res.text() };
  });
}
