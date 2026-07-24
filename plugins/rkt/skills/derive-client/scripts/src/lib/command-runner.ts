import { shapeTypeAt, type CommandSpec, type IdentitySpec } from "./commands-schema";
import type { ClientManifest, JsonShape } from "./manifest-schema";
import { applyJoins, type Lookup } from "./join";
import { resolveIdentity, whoamiLine } from "./identity";
import { capText, CliError, MAX_BYTES, MAX_ROWS, writeSpill } from "./overflow";
import { maskHeaders, maskSecretValues, redactAll } from "./secrets";
import { resolveToken, type TokenContext } from "./tokens";
import { getPath, redactClone, renderJson, renderTable, sortRows } from "./render";
import { buildRequest, writesEnabled } from "./transport";

export interface RunnerCaller {
  call(
    endpointId: string,
    params: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: string }>;
  fetchJson(endpointId: string, params?: Record<string, string>): Promise<unknown>;
  /** Credential bundle for always-on output masking; mirrors runtime Caller.secret. */
  readonly secret?: Record<string, string> | null;
}

export interface RunFlags {
  json: boolean;
  raw: boolean;
  limit?: number;
}

export interface RunResult {
  /** "preview" means nothing was sent. Optional so existing literals still typecheck. */
  kind?: "preview" | "sent";
  rendered: string;
  rowCount?: number;
  fullPayload: string;
  /**
   * Re-render the first n rows in the same output mode. Provided when the
   * result is row-shaped; finishRun uses it so a row-capped result is
   * re-rendered from data (valid JSON / consistent table) instead of sliced
   * as text.
   */
  renderCapped?: (n: number) => string;
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
  /** True when --commit was passed. A write only sends when this is true. */
  commit?: boolean;
  /** Parsed --<name> flag values, for @arg: holes. */
  args?: Record<string, string>;
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
    return (memo ??= resolveIdentity(site, identity, (id, p) => caller.fetchJson(id, p)).then((r) => r.id));
  };
}

export async function runWhoami(
  site: string,
  identity: IdentitySpec | undefined,
  caller: RunnerCaller,
): Promise<string> {
  if (!identity) throw new Error("this client has no identity endpoint; whoami is unavailable");
  const r = await resolveIdentity(site, identity, (id, p) => caller.fetchJson(id, p));
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

/**
 * Tokens resolve to strings, but a JSON body needs real numbers and booleans.
 * Coerce against the modelled shape so --count 5 goes on the wire as 5.
 */
function coerce(value: string, type: string | undefined, path: string, hint?: string): unknown {
  if (hint && type !== "number" && type !== "boolean") {
    const ok =
      hint === "iso8601"
        ? !Number.isNaN(Date.parse(value))
        : hint === "email"
          ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
          : hint === "uuid"
            ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
            : hint === "url"
              ? URL.canParse(value)
              : true;
    if (!ok) throw new Error(`body field ${path} must be ${hint}, got ${JSON.stringify(value)}`);
  }
  if (type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`body field ${path} must be a number, got ${JSON.stringify(value)}`);
    }
    return n;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`body field ${path} must be true or false, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Walk the body template, resolving tokens per string leaf and coercing. */
async function materialiseBody(
  template: unknown,
  shape: JsonShape | null,
  hints: Record<string, string>,
  ctx: TokenContext,
  now: Date,
  path = "",
): Promise<unknown> {
  if (Array.isArray(template)) {
    return Promise.all(
      template.map((v, i) =>
        materialiseBody(v, shape, hints, ctx, now, path ? `${path}.${i}` : String(i)),
      ),
    );
  }
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = await materialiseBody(v, shape, hints, ctx, now, path ? `${path}.${k}` : k);
    }
    return out;
  }
  if (typeof template !== "string") return template;
  const resolved = await resolveToken(template, ctx, now);
  return coerce(resolved, shapeTypeAt(shape, path), path, hints[path]);
}

export async function runCommand(cmd: CommandSpec, opts: RunOpts): Promise<RunResult> {
  const { manifest, site, caller, identity, flags, now } = opts;
  const ctx: TokenContext = {
    resolveMe: makeResolveMe(site, identity, caller),
    timezone: opts.timezone,
    args: opts.args ?? {},
  };
  const merged = { ...(cmd.call.params ?? {}), ...(opts.overrideParams ?? {}) };
  const params = await resolveParams(merged, ctx, now);

  const ep = manifest.endpoints.find((e) => e.id === cmd.call.endpoint);
  if (!ep) throw new Error(`${cmd.name}: endpoint ${cmd.call.endpoint} is missing from client.json`);
  const isWrite = !["GET", "HEAD"].includes(ep.method.toUpperCase());

  if (isWrite) {
    const body =
      cmd.call.body === undefined
        ? undefined
        : await materialiseBody(
            cmd.call.body,
            ep.writeSemantics?.bodyShape ?? null,
            ep.writeSemantics?.bodyHints ?? {},
            ctx,
            now,
          );

    if (!opts.commit) {
      const built = buildRequest(manifest, ep, params, caller.secret ?? null, body);
      const bodyRedact = (cmd.redact ?? [])
        .filter((r) => r.startsWith("body."))
        .map((r) => r.slice("body.".length));
      const preview = {
        method: built.method,
        url: built.url,
        headers: maskHeaders(built.headers, caller.secret ?? null),
        body: body === undefined ? undefined : redactClone(body, bodyRedact),
      };
      const rendered = redactAll(
        JSON.stringify(maskSecretValues(preview, caller.secret ?? null), null, 2),
        caller.secret ?? null,
      );
      return { kind: "preview", rendered, fullPayload: rendered };
    }

    if (!writesEnabled()) {
      throw new CliError(
        `${cmd.name} is a write and writes are disabled: set RKT_ALLOW_WRITES=1`,
        "set RKT_ALLOW_WRITES=1 to enable writes for this session",
        2,
      );
    }
    const { status, body: resBody } = await caller.call(cmd.call.endpoint, params, body);
    if (status >= 400) {
      throw new CliError(
        `HTTP ${status} from ${cmd.call.endpoint}\n${resBody.slice(0, 2000)}`,
        "this write may or may not have been applied; verify the remote state before re-running",
        1,
      );
    }
    const rendered =
      resBody.trim().length === 0
        ? ""
        : renderJson(maskSecretValues(JSON.parse(resBody), caller.secret ?? null), {
            redact: (cmd.redact ?? []).filter((r) => !r.startsWith("body.")),
            raw: flags.raw,
          });
    return { kind: "sent", rendered, fullPayload: rendered };
  }

  const { status, body } = await caller.call(cmd.call.endpoint, params);
  if (status >= 400) {
    let redactedBody: string;
    try {
      const parsed = JSON.parse(body);
      redactedBody = JSON.stringify(maskSecretValues(parsed, caller.secret ?? null));
    } catch {
      redactedBody = redactAll(body, caller.secret ?? null);
    }
    const spill = await writeSpill(site, cmd.name, redactedBody, now).catch(() => undefined);
    const head = redactedBody.slice(0, 2000);
    let hint: string;
    let exitCode = 1;
    if (status === 401) {
      // createCaller already ran its renewal tiers and still got 401: exhausted.
      hint = "run: login  (then check: auth status)";
      exitCode = 4;
    } else if (status === 403) {
      hint = `the session may lack permission for this resource; if the whole client fails, try: login${spill ? `. full body: ${spill}` : ""}`;
    } else {
      hint = `${spill ? `full body: ${spill}. ` : ""}re-run with --dry-run to inspect the request`;
    }
    throw new CliError(`HTTP ${status} from ${cmd.call.endpoint}\n${head}`, hint, exitCode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${cmd.name}: response was not JSON`);
  }

  const redact = (cmd.redact ?? []).filter((r) => !r.startsWith("body."));
  const secrets = caller.secret ?? null;
  const mask = (text: string) => redactAll(text, secrets);

  const useJson = cmd.output.kind === "json" || flags.json;

  if (useJson) {
    let data = parsed;
    if (typeof flags.limit === "number" && Array.isArray(data)) {
      data = (data as unknown[]).slice(0, flags.limit);
    }
    data = maskSecretValues(data, secrets);
    const rendered = mask(renderJson(data, { redact, raw: flags.raw }));
    const rowCount = Array.isArray(data) ? (data as unknown[]).length : undefined;
    // Line-slicing pretty-printed JSON would emit an unparseable fragment;
    // re-render a sliced array instead so capped stdout stays valid JSON.
    const renderCapped =
      rowCount !== undefined
        ? (n: number) => mask(renderJson((data as unknown[]).slice(0, n), { redact, raw: flags.raw }))
        : undefined;
    return { kind: "sent", rendered, rowCount, fullPayload: rendered, renderCapped };
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
  const rendered = mask(renderTable(rows, cmd.output.columns ?? [], { redact, raw: flags.raw }));
  const maskedRows = maskSecretValues(rows, secrets);
  const fullPayload = mask(renderJson(maskedRows, { redact, raw: flags.raw }));
  const renderCapped = (n: number) =>
    mask(renderTable(rows.slice(0, n), cmd.output.columns ?? [], { redact, raw: flags.raw }));
  return { kind: "sent", rendered, rowCount: rows.length, fullPayload, renderCapped };
}

/** Apply overflow caps to a finished run; spill the full payload when capped. */
export async function finishRun(
  site: string,
  command: string,
  result: RunResult,
  opts: { full: boolean; now: Date },
): Promise<{
  stdout: string;
  size: { rows: number } | { bytes: number };
  spillPath?: string;
  hint?: string;
}> {
  const size =
    result.rowCount !== undefined
      ? { rows: result.rowCount }
      : { bytes: Buffer.byteLength(result.rendered) };
  if (opts.full) return { stdout: result.rendered, size };

  let text = result.rendered;
  let capped = false;
  if (result.rowCount !== undefined && result.rowCount > MAX_ROWS) {
    // Re-render from data when possible: slicing pretty-printed JSON by line
    // emits an unparseable fragment. Text-slicing is only a last resort.
    text = result.renderCapped
      ? result.renderCapped(MAX_ROWS)
      : text.split("\n").slice(0, MAX_ROWS + 1).join("\n");
    capped = true;
  }
  const byteCap = capText(text, MAX_BYTES);
  text = byteCap.text;
  capped = capped || byteCap.capped;

  if (!capped) return { stdout: result.rendered, size };
  const spillPath = await writeSpill(site, command, result.fullPayload, opts.now);
  return {
    stdout: text,
    size,
    spillPath,
    hint: `narrow with --limit or a declared --<param>, or: jq . ${spillPath}`,
  };
}
