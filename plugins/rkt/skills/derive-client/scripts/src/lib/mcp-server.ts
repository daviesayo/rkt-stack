import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertResolvable, validateCommandsFile, type CommandSpec } from "./commands-schema";
import { validateManifest, type ManifestEndpoint } from "./manifest-schema";
import { RESERVED_ARGS, escapeAgentValue, exposedParams, unsatisfiableArgs } from "./mcp-params";
import { runCommand, runWhoami, type RunnerCaller } from "./command-runner";
import { CliError, MAX_BYTES, MAX_ROWS, capText } from "./overflow";
import { createCaller } from "./runtime";
import { refreshViaOidc as realRefreshViaOidc } from "./refresh";
import { readSecrets, redactAll, writeSecret as realWriteSecret } from "./secrets";
import { createScheduler, type Scheduler } from "./scheduler";

const READ_METHODS = new Set(["GET", "HEAD"]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Strip host filesystem paths from an error string before it reaches an agent. */
function stripHostPaths(text: string): string {
  return text
    .replace(/[^\s]*\.rkt-clients[^\s]*/g, "[path]")
    .replace(/\/(?:Users|tmp|var|home|private)[^\s]*/g, "[path]");
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

  // ONE scheduler for the server: it owns pacing and request serialisation as
  // well as the cache. Per-call construction would reset the `first` flag and
  // remove serialisation, giving unbounded parallel bursts, which is exactly
  // the detection risk this project cares about.
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

  // In-process serialization. Two concurrent renewals would otherwise race on
  // the same "<path>.<pid>.tmp" file, where one error handler removes the
  // other's temp file. lock.ts is not part of the client runtime by design.
  let writeChain: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => {});
    return next;
  }

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
        ...(opts.refreshViaOidc ? { refreshViaOidc: opts.refreshViaOidc } : {}),
        writeSecret: (site, values) =>
          serialize(() => (opts.writeSecret ?? realWriteSecret)(site, values)),
      })
    );
  }

  const realRunTool = async (cmd: CommandSpec, args: Record<string, unknown>): Promise<string> => {
    const caller = await callerForCall();
    const { _limit, _offset, ...rest } = args;
    const overrideParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) overrideParams[k] = escapeAgentValue(String(v));
    }

    let res;
    try {
      res = await runCommand(cmd, {
        manifest,
        site: manifest.site,
        caller,
        identity: commands.identity,
        flags: { json: cmd.output.kind === "json", raw: false },
        now: new Date(),
        overrideParams,
        spill: false, // no spill file, no host path in any hint
      });
    } catch (err) {
      throw new Error(authAwareMessage(err, manifest.site));
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
    let page = all.slice(start, start + size);
    let text = JSON.stringify({ rows: page }, null, 2);
    // Row count alone does not bound context: shrink until the payload fits.
    while (page.length > 1 && Buffer.byteLength(text) > MAX_BYTES) {
      page = page.slice(0, Math.floor(page.length / 2));
      text = JSON.stringify({ rows: page }, null, 2);
    }
    const truncated = start + page.length < all.length;
    return redactAll(
      JSON.stringify(
        {
          rows: page,
          truncated,
          ...(truncated || start > 0
            ? {
                notice: `${all.length} row(s) available; showing ${page.length} from offset ${start}. Use _offset/_limit to page.`,
              }
            : {}),
        },
        null,
        2,
      ),
      secrets,
    );
  };

  const realRunWhoamiTool = async (): Promise<string> => {
    try {
      return await runWhoami(manifest.site, commands.identity, await callerForCall());
    } catch (err) {
      throw new Error(authAwareMessage(err, manifest.site));
    }
  };

  const runTool = opts.runTool ?? realRunTool;
  const runWhoamiTool = opts.runWhoamiTool ?? realRunWhoamiTool;

  let skippedWrites = 0;
  const registered = new Set<string>(commands.identity ? ["whoami"] : []);
  const toRegister: { cmd: CommandSpec; ep: ManifestEndpoint }[] = [];

  for (const cmd of commands.commands) {
    const ep = byId.get(cmd.call.endpoint) as ManifestEndpoint;
    // Structural: the endpoint's method decides, never the `write` field.
    if (!READ_METHODS.has(ep.method.toUpperCase())) {
      skippedWrites++;
      continue;
    }
    if (cmd.name.startsWith("_") || !TOOL_NAME.test(cmd.name)) {
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
    const shape: Record<string, z.ZodTypeAny> = {
      _limit: z.number().int().positive().optional(),
      _offset: z.number().int().nonnegative().optional(),
    };
    if (RESERVED_ARGS[0] !== "_limit" || RESERVED_ARGS[1] !== "_offset") {
      throw new Error("RESERVED_ARGS drifted from paging arg names");
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
