import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertResolvable, validateCommandsFile, type CommandSpec } from "./commands-schema";
import { validateManifest, READ_METHODS, type ManifestEndpoint } from "./manifest-schema";
import {
  RESERVED_ARGS,
  assertReservedPagingArgs,
  escapeAgentValue,
  exposedParams,
  unsatisfiableArgs,
} from "./mcp-params";
import { runCommand, runWhoami, type RunnerCaller } from "./command-runner";
import { CliError, MAX_BYTES, MAX_ROWS, capText } from "./overflow";
import { rktRoot } from "./paths";
import { createCaller } from "./runtime";
import { refreshViaOidc as realRefreshViaOidc } from "./refresh";
import { readSecrets, redactAll, serializeCredentialWrite, writeSecret as realWriteSecret } from "./secrets";
import { createScheduler, type Scheduler } from "./scheduler";

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Strip host filesystem paths from an error string before it reaches an agent. */
export function stripHostPaths(text: string): string {
  const roots = [rktRoot()].sort((a, b) => b.length - a.length);
  let out = text;
  for (const root of roots) {
    if (root.length > 0) out = out.split(root).join("[path]");
  }
  // Conservative fallback for absolute paths at token boundaries — never the
  // path component of a URL (https://host/var/x must survive intact, because a
  // URL's path is always preceded by a host character, never by whitespace).
  // `var` stays in this alternation: macOS temp dirs live under /var/folders,
  // and dropping it would let a non-rktRoot temp path through.
  out = out.replace(/(?:^|\s)(\/(?:Users|tmp|var|home|private)\/[^\s]*)/g, (match) =>
    match.startsWith(" ") ? " [path]" : "[path]",
  );
  return out;
}

function endpointForCommand(
  byId: Map<string, ManifestEndpoint>,
  cmd: CommandSpec,
): ManifestEndpoint {
  const ep = byId.get(cmd.call.endpoint);
  if (!ep) {
    throw new Error(
      `commands.json: ${cmd.name} references endpoint '${cmd.call.endpoint}', which is not in client.json`,
    );
  }
  return ep;
}

function rowsResponseEnvelope(
  page: Record<string, unknown>[],
  opts: { truncated: boolean; start: number; allLength: number },
): string {
  const notice =
    opts.truncated || opts.start > 0
      ? `${opts.allLength} row(s) available; showing ${page.length} from offset ${opts.start}. Use _offset/_limit to page.`
      : undefined;
  return JSON.stringify(
    {
      rows: page,
      truncated: opts.truncated,
      ...(notice ? { notice } : {}),
    },
    null,
    2,
  );
}

function truncateRowFields(row: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  let candidate: Record<string, unknown> = { ...row };
  for (let pass = 0; pass < 64; pass++) {
    const envelope = rowsResponseEnvelope([candidate], {
      truncated: true,
      start: 0,
      allLength: 1,
    });
    if (Buffer.byteLength(envelope) <= maxBytes) return candidate;
    let longestKey: string | null = null;
    let longestLen = 0;
    for (const [key, value] of Object.entries(candidate)) {
      if (typeof value === "string" && value.length > longestLen) {
        longestLen = value.length;
        longestKey = key;
      }
    }
    if (!longestKey || longestLen <= 1) {
      // No string field left to shrink. A non-string field (a large array or
      // nested object) can still hold the envelope over the cap, so replace the
      // biggest one with a marker; without this the row escapes the cap entirely.
      let biggestKey: string | null = null;
      let biggestLen = 0;
      for (const [key, value] of Object.entries(candidate)) {
        if (typeof value === "string") continue;
        const len = JSON.stringify(value ?? null).length;
        if (len > biggestLen) {
          biggestLen = len;
          biggestKey = key;
        }
      }
      if (!biggestKey || biggestLen <= "\"[truncated]\"".length) break;
      candidate = { ...candidate, [biggestKey]: "[truncated]" };
      continue;
    }
    const value = candidate[longestKey] as string;
    candidate = { ...candidate, [longestKey]: value.slice(0, Math.max(1, Math.floor(value.length * 0.6))) };
  }
  return candidate;
}

function fitRowsPage(
  rows: Record<string, unknown>[],
  start: number,
  allLength: number,
): { page: Record<string, unknown>[]; truncated: boolean } {
  if (rows.length === 0) {
    return { page: [], truncated: start < allLength };
  }

  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = rows.slice(0, mid);
    const text = rowsResponseEnvelope(candidate, {
      truncated: start + mid < allLength,
      start,
      allLength,
    });
    if (Buffer.byteLength(text) <= MAX_BYTES) lo = mid;
    else hi = mid - 1;
  }

  if (lo > 0) {
    const page = rows.slice(0, lo);
    return { page, truncated: start + page.length < allLength };
  }

  const page = [truncateRowFields(rows[0] as Record<string, unknown>, MAX_BYTES)];
  return { page, truncated: true };
}

/** Turn a thrown CliError into an agent-safe message. Never includes secrets or host paths. */
export function authAwareMessage(err: unknown, site: string): string {
  if (err instanceof CliError && err.exitCode === 4) {
    return (
      `the stored session for ${site} has expired. Run '${site} login' on the host machine; ` +
      "the next call picks up the new credential."
    );
  }
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  else parts.push(String(err));
  if (err instanceof CliError && err.hint) parts.push(err.hint);
  return stripHostPaths(parts.join(" "));
}

export interface BuildOpts {
  /** Overrides the real handler; lets registration be tested standalone. */
  runTool?: (cmd: CommandSpec, args: Record<string, unknown>) => Promise<string>;
  /** Overrides the real whoami handler. */
  runWhoamiTool?: () => Promise<string>;
  /** Injected in tests; Task 5 defaults it to createScheduler({ cache: false }). */
  scheduler?: Scheduler;
  /** Injected in tests; Task 5 defaults it to the real readSecrets. */
  readSecrets?: (site: string) => Promise<Record<string, string> | null>;
  /** Injected caller for tests; defaults to createCaller per call. */
  caller?: RunnerCaller;
  /** Observed when the browser re-auth tier would run; must never launch Chrome in MCP mode. */
  onReauth?: () => void;
  /** Observed when the server-scoped default scheduler is created (tests only). */
  onCreateScheduler?: () => void;
  /** Injected fetch for the default server scheduler (tests only). */
  schedulerFetchImpl?: typeof fetch;
  /** Injected credential writer; serialized across concurrent tool calls. */
  writeSecret?: typeof realWriteSecret;
  /** Injected OIDC refresh for tests that exercise the renewal path. */
  refreshViaOidc?: typeof realRefreshViaOidc;
  /** Observed when the paging reserved-arg guard runs (tests only). */
  onReservedPagingCheck?: () => void;
}

export async function buildServer(
  clientDir: string,
  opts: BuildOpts = {},
): Promise<{ server: McpServer; skippedWrites: number }> {
  const manifest = validateManifest(
    JSON.parse(await readFile(join(clientDir, "client.json"), "utf8")),
  );
  const commands = validateCommandsFile(
    JSON.parse(await readFile(join(clientDir, "commands.json"), "utf8")),
  );
  // Fail closed: a hand-edited commands.json that mislabels a write must stop
  // the server, not silently register a mutation as a read tool.
  assertResolvable(commands, manifest.endpoints);

  const byId = new Map(manifest.endpoints.map((e) => [e.id, e]));

  // ONE scheduler per buildServer call: it owns pacing and request serialisation
  // as well as the cache. Per-call construction would reset the `first` flag and
  // remove serialisation, giving unbounded parallel bursts, which is exactly
  // the detection risk this project cares about. HTTP mode calls buildServer once
  // per session, so concurrent sessions are paced independently, not globally;
  // that is acceptable for loopback-bound, token-gated, single-operator use.
  // Stdio mode (the default) is unaffected: one server, one scheduler.
  const scheduler =
    opts.scheduler ??
    (() => {
      opts.onCreateScheduler?.();
      if (opts.schedulerFetchImpl) {
        return createScheduler({
          cache: false,
          minDelayMs: 0,
          maxDelayMs: 0,
          fetchImpl: opts.schedulerFetchImpl,
          sleepImpl: async () => {},
        });
      }
      return createScheduler({ cache: false });
    })();
  const readSecretsFn = opts.readSecrets ?? readSecrets;

  async function callerForCall() {
    // Re-read per call: a long-lived process would otherwise hold a stale
    // bundle forever and the "run login" remediation would never take effect.
    const secret = await readSecretsFn(manifest.site);
    return (
      opts.caller ??
      createCaller(manifest, scheduler, secret, {
        // An agent must never launch a browser. OIDC refresh may still run.
        reauthViaProfile: async () => {
          opts.onReauth?.();
          return null;
        },
        refreshViaOidc: opts.refreshViaOidc,
        readSecrets: readSecretsFn,
        writeSecret: (site, values) =>
          serializeCredentialWrite(() => (opts.writeSecret ?? realWriteSecret)(site, values)),
      })
    );
  }

  const realRunTool = async (cmd: CommandSpec, args: Record<string, unknown>): Promise<string> => {
    const { _limit, _offset, ...rest } = args;
    let caller: RunnerCaller | undefined;
    let res;
    try {
      caller = await callerForCall();
      const overrideParams: Record<string, string> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) overrideParams[k] = escapeAgentValue(String(v));
      }

      res = await runCommand(cmd, {
        manifest,
        site: manifest.site,
        caller,
        identity: commands.identity,
        flags: { json: false, raw: false },
        now: new Date(),
        overrideParams,
        spill: false, // no spill file, no host path in any hint
      });
    } catch (err) {
      const secrets = caller?.secret ?? null;
      throw new Error(redactAll(authAwareMessage(err, manifest.site), secrets));
    }

    const secrets = caller.secret ?? null;
    // A json-kind command never computes rows; return its raw rendered body,
    // matching CLI --json semantics rather than an empty rows array.
    if (res.rows === undefined) {
      const notice = `\n\n${MAX_BYTES} byte limit exceeded; body truncated. Use narrower queries or paging where available.`;
      const budget = MAX_BYTES - Buffer.byteLength(notice);
      const { text, capped } = capText(redactAll(res.rendered, secrets), budget);
      return capped ? text + notice : text;
    }

    const all = res.rows;
    const start = typeof _offset === "number" ? _offset : 0;
    const size = typeof _limit === "number" ? Math.min(_limit, MAX_ROWS) : MAX_ROWS;
    const slice = all.slice(start, start + size);
    const { page, truncated } = fitRowsPage(slice, start, all.length);
    return redactAll(rowsResponseEnvelope(page, { truncated, start, allLength: all.length }), secrets);
  };

  const realRunWhoamiTool = async (): Promise<string> => {
    let caller: RunnerCaller | undefined;
    try {
      caller = await callerForCall();
      return await runWhoami(manifest.site, commands.identity, caller);
    } catch (err) {
      const secrets = caller?.secret ?? null;
      throw new Error(redactAll(authAwareMessage(err, manifest.site), secrets));
    }
  };

  const runTool = opts.runTool ?? realRunTool;
  const runWhoamiTool = opts.runWhoamiTool ?? realRunWhoamiTool;

  assertReservedPagingArgs();
  opts.onReservedPagingCheck?.();

  let skippedWrites = 0;
  const registered = new Set<string>(commands.identity ? ["whoami"] : []);
  const toRegister: { cmd: CommandSpec; ep: ManifestEndpoint }[] = [];

  for (const cmd of commands.commands) {
    const ep = endpointForCommand(byId, cmd);
    // Structural: the endpoint's method decides, never the `write` field.
    if (!READ_METHODS.has(ep.method.toUpperCase())) {
      skippedWrites++;
      continue;
    }
    if (cmd.name.startsWith("_")) {
      throw new Error(`commands.json: tool name "${cmd.name}" uses the reserved "_" prefix`);
    }
    if (!TOOL_NAME.test(cmd.name)) {
      throw new Error(`commands.json: "${cmd.name}" is not a valid MCP tool name`);
    }
    if (registered.has(cmd.name)) {
      throw new Error(`commands.json: tool name "${cmd.name}" collides with an existing tool`);
    }
    const bad = unsatisfiableArgs(cmd, ep);
    if (bad.length) {
      throw new Error(
        `commands.json: ${cmd.name} param(s) ${bad.join(", ")} can never be supplied ` +
          `(an @arg: hole with no matching endpoint param, or an unknown @token)`,
      );
    }
    for (const p of exposedParams(cmd, ep)) {
      if (p.name.startsWith("_")) {
        throw new Error(`commands.json: ${cmd.name} param "${p.name}" uses the reserved "_" prefix`);
      }
    }
    registered.add(cmd.name);
    toRegister.push({ cmd, ep });
  }

  const instructions =
    `Curated read tools for ${manifest.site}.` +
    (skippedWrites > 0
      ? ` ${skippedWrites} write command(s) are not exposed: MCP mode is read-only.`
      : "");

  const server = new McpServer({ name: `rkt-${manifest.site}`, version: "1.0.0" }, { instructions });

  for (const { cmd, ep } of toRegister) {
    const shape: Record<string, z.ZodTypeAny> = {};
    if (cmd.output.kind !== "json") {
      // Keyed off RESERVED_ARGS, not off literals: assertReservedPagingArgs()
      // pins RESERVED_ARGS to the names realRunTool destructures, so deriving
      // the schema from it makes drift between the two structurally impossible
      // rather than merely detected.
      const [limitArg, offsetArg] = RESERVED_ARGS;
      shape[limitArg] = z.number().int().positive().optional();
      shape[offsetArg] = z.number().int().nonnegative().optional();
    }
    for (const p of exposedParams(cmd, ep)) {
      const base = p.type === "number" ? z.number() : z.string();
      shape[p.name] = p.required ? base : base.optional();
    }
    server.registerTool(
      cmd.name,
      { description: cmd.summary, inputSchema: shape, annotations: { readOnlyHint: true } },
      async (args: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: await runTool(cmd, args) }],
      }),
    );
  }

  if (commands.identity) {
    server.registerTool(
      "whoami",
      { description: "The signed-in user this client acts as.", annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text" as const, text: await runWhoamiTool() }] }),
    );
  }

  return { server, skippedWrites };
}
