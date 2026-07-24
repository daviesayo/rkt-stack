import type { ClientManifest, ManifestEndpoint } from "./manifest-schema";
import type { Scheduler } from "./scheduler";
import { buildRequest, issue } from "./transport";
import { CliError } from "./overflow";
import { REFRESH_TOKEN_KEY, writeSecret as realWriteSecret } from "./secrets";
import { refreshViaOidc as realRefresh } from "./refresh";
import { reauthViaProfile as realReauth } from "./reauth";

export interface CallerDeps {
  refreshViaOidc?: typeof realRefresh;
  reauthViaProfile?: typeof realReauth;
  writeSecret?: typeof realWriteSecret;
  log?: (msg: string) => void;
}

export interface Caller {
  call(
    endpointId: string,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: string }>;
  fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown>;
  readonly secret: Record<string, string> | null;
}

export function createCaller(
  manifest: ClientManifest,
  scheduler: Scheduler,
  initialSecret: Record<string, string> | null,
  deps: CallerDeps = {},
): Caller {
  const refresh = deps.refreshViaOidc ?? realRefresh;
  const reauth = deps.reauthViaProfile ?? realReauth;
  const writeSecret = deps.writeSecret ?? realWriteSecret;
  const log = deps.log ?? ((m: string) => console.error(m));
  let secret = initialSecret;

  function endpointById(id: string): ManifestEndpoint {
    const ep = manifest.endpoints.find((e) => e.id === id);
    if (!ep) throw new CliError(
      `endpoint ${id} is missing from client.json`,
      "regenerate this client: bash regenerate.sh",
    );
    return ep;
  }

  // Tiered renewal: OIDC refresh first (one POST), browser re-auth second
  // (a headless Chrome launch that survives an expired refresh token). Returns
  // true when `secret` was replaced with a fresh, persisted bundle.
  async function renew(): Promise<boolean> {
    if (!secret) return false;
    let renewed: Record<string, string> | null = null;

    if (manifest.refresh?.kind === "oidc" && secret[REFRESH_TOKEN_KEY]) {
      log("credential rejected (401); refreshing via OIDC...");
      const r = await refresh(manifest.refresh, secret[REFRESH_TOKEN_KEY], manifest.userAgent);
      if (r) {
        renewed = { ...secret };
        const cookieName = manifest.refresh.accessTokenCookie;
        if (cookieName) renewed[`cookie:${cookieName}`] = r.accessToken;
        const bearer = manifest.authBundle?.credentials.find((c) => c.kind === "bearer");
        if (bearer) renewed[bearer.location] = `Bearer ${r.accessToken}`;
        if (r.refreshToken) renewed[REFRESH_TOKEN_KEY] = r.refreshToken;
      } else {
        log("OIDC refresh refused; falling back to browser re-auth...");
      }
    }

    if (!renewed) {
      const entryUrl =
        manifest.refresh?.kind === "browser" ? manifest.refresh.entryUrl : `${manifest.baseUrl}/`;
      const wanted = (manifest.authBundle?.credentials ?? []).map((c) => c.location);
      log("re-authenticating with the recorded browser profile...");
      let harvested = null;
      try {
        harvested = await reauth(manifest.site, entryUrl, wanted);
      } catch (err) {
        // A missing dependency is not an expired session; say which it is.
        log((err as Error).message);
      }
      if (harvested) renewed = { ...secret, ...harvested.values };
    }

    if (!renewed) return false;
    await writeSecret(manifest.site, renewed);
    secret = renewed;
    return true;
  }

  const READ_METHODS = new Set(["GET", "HEAD"]);

  async function call(endpointId: string, params: Record<string, string>, body?: unknown) {
    const ep = endpointById(endpointId);
    const isWrite = !READ_METHODS.has(ep.method.toUpperCase());
    let built = buildRequest(manifest, ep, params, secret, body);
    let res = await issue(built, scheduler);
    if (res.status === 401 && secret && (await renew())) {
      // A read is safe to replay. A write is not: the server may have committed
      // it before the token expired, so replaying could apply it twice.
      if (isWrite) {
        throw new CliError(
          `${ep.method} ${ep.pathTemplate} returned HTTP 401 and the credential was renewed, ` +
            `but the write was NOT retried. It may or may not have applied.`,
          "verify the resource on the site before re-running this command",
          4,
        );
      }
      built = buildRequest(manifest, ep, params, secret, body);
      res = await issue(built, scheduler);
    }
    return res;
  }

  async function fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown> {
    const { status, body } = await call(endpointId, params ?? {});
    if (status >= 400) throw new CliError(
      `endpoint ${endpointId} returned HTTP ${status}`,
      status === 401
        ? "run: login  (then check: auth status)"
        : "re-run the command with --dry-run to inspect the request",
      status === 401 ? 4 : 1,
    );
    try {
      return JSON.parse(body);
    } catch {
      throw new CliError(
        `endpoint ${endpointId} did not return JSON`,
        "re-run the command with --dry-run to inspect the request",
      );
    }
  }

  return {
    call,
    fetchJson,
    get secret() {
      return secret;
    },
  };
}
