import type { ClientManifest, ManifestEndpoint } from "./manifest-schema";
import type { Scheduler } from "./scheduler";

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Serialised JSON payload for write methods. */
  body?: string;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Fail-closed: only an explicit "1"/"true" enables writes. Reading any
 * non-empty string as truthy would turn RKT_ALLOW_WRITES=0 into "enabled".
 */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.RKT_ALLOW_WRITES;
  return v === "1" || v === "true";
}

function assertSecureTransport(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`invalid baseUrl: ${JSON.stringify(baseUrl)}`);
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error(
      `refusing to send credentials over ${parsed.protocol}//${parsed.hostname}: ` +
        `use https or a loopback http origin`,
    );
  }
}

/**
 * Apply every credential the site requires.
 *
 * `secret` accepts either a bundle (location -> value) or a bare string for
 * single-credential callers. Cookies are merged into one header, since a
 * request carries at most one Cookie header and real sites need several
 * cookies at once.
 */
export function applyCredentials(
  manifest: ClientManifest,
  headers: Record<string, string>,
  secret: Record<string, string> | string | null,
): void {
  if (!secret) return;

  const bundle = manifest.authBundle?.credentials ?? (manifest.auth ? [manifest.auth] : []);
  if (bundle.length === 0) return;

  assertSecureTransport(manifest.baseUrl);

  const values: Record<string, string> =
    typeof secret === "string"
      ? { [bundle[0].location]: secret }
      : secret;

  const cookies: string[] = [];
  for (const cred of bundle) {
    const value = values[cred.location];
    if (value === undefined) continue;
    if (cred.kind === "cookie") {
      const name = cred.location.startsWith("cookie:")
        ? cred.location.slice("cookie:".length)
        : cred.location;
      cookies.push(`${name}=${value}`);
    } else {
      headers[cred.location.toLowerCase()] = value;
    }
  }
  if (cookies.length > 0) headers["cookie"] = cookies.join("; ");
}

export function buildRequest(
  manifest: ClientManifest,
  endpoint: ManifestEndpoint,
  params: Record<string, string>,
  secret: Record<string, string> | string | null,
  body?: unknown,
): BuiltRequest {
  const isWrite = !READ_METHODS.has(endpoint.method.toUpperCase());
  // A read-mode client has no business issuing a write regardless of the env
  // flag: structural check on the manifest, never on names.
  if (isWrite && manifest.mode !== "full") {
    throw new Error(
      `refusing ${endpoint.method} ${endpoint.pathTemplate}: read mode issues GET and HEAD only`,
    );
  }

  let path = endpoint.pathTemplate;
  for (const p of endpoint.params.filter((x) => x.in === "path")) {
    const value = params[p.name] ?? p.example;
    if (value === undefined) throw new Error(`missing required path param: ${p.name}`);
    path = path.replace(`{${p.name}}`, encodeURIComponent(value));
  }

  const query = new URLSearchParams();
  for (const p of endpoint.params.filter((x) => x.in === "query")) {
    // Fall back to the recorded value for params the API requires. Omitting
    // them yields a 400 that reads like a client bug, when the caller simply
    // had no way to know the argument was mandatory.
    const value = params[p.name] ?? (p.required ? p.example : undefined);
    if (value !== undefined) query.set(p.name, value);
  }

  const qs = query.toString();
  const url = `${manifest.baseUrl}${path}${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = {
    "user-agent": manifest.userAgent,
    accept: "application/json, text/plain, */*",
    ...manifest.clientHints,
  };

  applyCredentials(manifest, headers, secret);

  if (!isWrite) return { url, method: endpoint.method, headers };

  const contentType = endpoint.writeSemantics?.contentType ?? "application/json";
  if (body !== undefined && !/json/i.test(contentType)) {
    throw new Error(
      `refusing ${endpoint.method} ${endpoint.pathTemplate}: recorded content type ` +
        `${JSON.stringify(contentType)} is non-JSON; this client only serialises JSON bodies`,
    );
  }

  const serialised = body === undefined ? undefined : JSON.stringify(body);
  if (serialised !== undefined) {
    headers["content-type"] = contentType;
  }
  return { url, method: endpoint.method, headers, body: serialised };
}

export async function issue(
  built: BuiltRequest,
  scheduler: Scheduler,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number; body: string }> {
  // The gate lives here, at the send, not in buildRequest: a dry-run preview
  // must still be able to BUILD the request in order to display it.
  if (!READ_METHODS.has(built.method.toUpperCase()) && !writesEnabled(opts.env)) {
    throw new Error(
      `refusing ${built.method} ${built.url}: writes are disabled. ` +
        `Set RKT_ALLOW_WRITES=1 to enable them.`,
    );
  }
  const { status, body } = await scheduler.run({
    url: built.url,
    method: built.method,
    headers: built.headers,
    ...(built.body === undefined ? {} : { body: built.body }),
  });
  return { status, body };
}
