import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertResolvable, validateCommandsFile, type CommandSpec } from "./commands-schema";
import { validateManifest, type ManifestEndpoint } from "./manifest-schema";
import { RESERVED_ARGS, exposedParams, unsatisfiableArgs } from "./mcp-params";
import type { Scheduler } from "./scheduler";

const READ_METHODS = new Set(["GET", "HEAD"]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface BuildOpts {
  /** Overrides the real handler; lets registration be tested standalone. */
  runTool?: (cmd: CommandSpec, args: Record<string, unknown>) => Promise<string>;
  /** Overrides the real whoami handler. */
  runWhoamiTool?: () => Promise<string>;
  /** Injected in tests; Task 5 defaults it to createScheduler({ cache: false }). */
  scheduler?: Scheduler;
  /** Injected in tests; Task 5 defaults it to the real readSecrets. */
  readSecrets?: (site: string) => Promise<Record<string, string> | null>;
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

  // Task 5 replaces these bodies with the real per-call implementation.
  const runTool = opts.runTool ?? (async () => "{}");
  const runWhoamiTool = opts.runWhoamiTool ?? (async () => "");

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
