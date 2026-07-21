import type { CommandSpec, IdentitySpec } from "./commands-schema";
import type { ClientManifest } from "./manifest-schema";
import { applyJoins, type Lookup } from "./join";
import { resolveIdentity, whoamiLine } from "./identity";
import { maskSecretValues, redactAll } from "./secrets";
import { resolveToken, type TokenContext } from "./tokens";
import { getPath, renderJson, renderTable, sortRows } from "./render";

export interface RunnerCaller {
  call(endpointId: string, params: Record<string, string>): Promise<{ status: number; body: string }>;
  fetchJson(endpointId: string): Promise<unknown>;
  /** Credential bundle for always-on output masking; mirrors runtime Caller.secret. */
  readonly secret?: Record<string, string> | null;
}

export interface RunFlags {
  json: boolean;
  raw: boolean;
  limit?: number;
}

export interface RunOpts {
  manifest: ClientManifest;
  site: string;
  caller: RunnerCaller;
  identity?: IdentitySpec;
  flags: RunFlags;
  timezone?: string;
  now: Date;
  overrideParams?: Record<string, string>;
}

/** One memoized identity resolution per run, layered over identity's on-disk cache. */
export function makeResolveMe(
  site: string,
  identity: IdentitySpec | undefined,
  caller: RunnerCaller,
): () => Promise<string> {
  let memo: Promise<string> | undefined;
  return () => {
    if (!identity) {
      return Promise.reject(
        new Error("@me needs an identity block in commands.json; this client has none"),
      );
    }
    return (memo ??= resolveIdentity(site, identity, (id) => caller.fetchJson(id)).then((r) => r.id));
  };
}

export async function runWhoami(
  site: string,
  identity: IdentitySpec | undefined,
  caller: RunnerCaller,
): Promise<string> {
  if (!identity) throw new Error("this client has no identity endpoint; whoami is unavailable");
  const r = await resolveIdentity(site, identity, (id) => caller.fetchJson(id));
  return whoamiLine(r.display, identity.display);
}

function solePathParam(manifest: ClientManifest, endpointId: string): string {
  const ep = manifest.endpoints.find((e) => e.id === endpointId);
  const pathParams = (ep?.params ?? []).filter((p) => p.in === "path");
  if (pathParams.length !== 1) {
    throw new Error(`join lookup ${endpointId} must have exactly one path param`);
  }
  return pathParams[0].name;
}

function extractRows(body: unknown, rowsPath?: string): Record<string, unknown>[] {
  const src = rowsPath ? getPath(body, rowsPath) : body;
  if (Array.isArray(src)) return src as Record<string, unknown>[];
  if (rowsPath) throw new Error(`output.rows '${rowsPath}' did not resolve to an array`);
  if (src && typeof src === "object") return [src as Record<string, unknown>];
  return [];
}

async function resolveParams(
  params: Record<string, string>,
  ctx: TokenContext,
  now: Date,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = await resolveToken(v, ctx, now);
  return out;
}

export async function runCommand(cmd: CommandSpec, opts: RunOpts): Promise<string> {
  const { manifest, site, caller, identity, flags, now } = opts;
  const ctx: TokenContext = {
    resolveMe: makeResolveMe(site, identity, caller),
    timezone: opts.timezone,
  };
  const merged = { ...(cmd.call.params ?? {}), ...(opts.overrideParams ?? {}) };
  const params = await resolveParams(merged, ctx, now);

  const { status, body } = await caller.call(cmd.call.endpoint, params);
  if (status >= 400) throw new Error(`HTTP ${status} from ${cmd.call.endpoint}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${cmd.name}: response was not JSON`);
  }

  const redact = cmd.redact ?? [];
  const secrets = caller.secret ?? null;
  const mask = (text: string) => redactAll(text, secrets);

  const useJson = cmd.output.kind === "json" || flags.json;

  if (useJson) {
    let data = parsed;
    if (typeof flags.limit === "number" && Array.isArray(data)) {
      data = (data as unknown[]).slice(0, flags.limit);
    }
    data = maskSecretValues(data, secrets);
    return mask(renderJson(data, { redact, raw: flags.raw }));
  }

  let rows = extractRows(parsed, cmd.output.rows);
  if (cmd.join?.length) {
    const lookup: Lookup = (endpointId, key) => {
      const name = solePathParam(manifest, endpointId);
      return caller.call(endpointId, { [name]: key }).then((r) => {
        if (r.status >= 400) throw new Error(`join lookup ${endpointId} HTTP ${r.status}`);
        return JSON.parse(r.body);
      });
    };
    rows = await applyJoins(rows, cmd.join, lookup);
  }
  if (cmd.output.sort) rows = sortRows(rows, cmd.output.sort);
  if (typeof flags.limit === "number") rows = rows.slice(0, flags.limit);
  return mask(renderTable(rows, cmd.output.columns ?? [], { redact, raw: flags.raw }));
}
