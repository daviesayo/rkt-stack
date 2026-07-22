import type { ManifestEndpoint } from "./manifest-schema";

export const COMMANDS_SCHEMA_VERSION = 1;

export interface IdentitySpec {
  endpoint: string;
  params?: Record<string, string>;
  idField: string;
  display: string[];
}

export interface JoinSpec {
  key: string;
  endpoint: string;
  select: string[];
  as: string;
  onError: "blank" | "key" | "fail";
}

export interface CommandOutput {
  kind: "table" | "json";
  columns?: string[];
  sort?: string;
  rows?: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  call: { endpoint: string; params?: Record<string, string> };
  join?: JoinSpec[];
  output: CommandOutput;
  redact?: string[];
}

export interface CommandsFile {
  schemaVersion: number;
  site: string;
  identity?: IdentitySpec;
  commands: CommandSpec[];
}

function fail(field: string, why: string): never {
  throw new Error(`commands.json: ${field} ${why}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStringArray(arr: unknown, field: string): string[] {
  if (!Array.isArray(arr)) fail(field, "must be an array");
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "string") fail(`${field}[${i}]`, "must be a string");
  }
  return arr as string[];
}

function validateStringMap(value: unknown, field: string): Record<string, string> {
  if (!isPlainObject(value)) fail(field, "must be an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") fail(`${field}.${k}`, "must be a string");
    out[k] = v;
  }
  return out;
}

function validateParams(params: unknown, cmd: string): Record<string, string> {
  if (params === undefined) return {};
  if (!isPlainObject(params)) fail(`${cmd}.call.params`, "must be an object");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string") fail(`${cmd}.call.params.${key}`, "must be a string");
    out[key] = value;
  }
  return out;
}

function validateJoin(j: unknown, cmd: string): JoinSpec {
  const o = j as Partial<JoinSpec>;
  if (typeof o?.key !== "string") fail(`${cmd}.join[].key`, "must be a string");
  if (typeof o.endpoint !== "string") fail(`${cmd}.join[].endpoint`, "must be a string");
  const select = validateStringArray(o.select, `${cmd}.join[].select`);
  if (typeof o.as !== "string") fail(`${cmd}.join[].as`, "must be a string");
  const onError = o.onError ?? "blank";
  if (!["blank", "key", "fail"].includes(onError)) fail(`${cmd}.join[].onError`, "must be blank, key, or fail");
  return { key: o.key, endpoint: o.endpoint, select, as: o.as, onError };
}

function validateCommand(c: unknown): CommandSpec {
  const o = c as Partial<CommandSpec>;
  if (typeof o?.name !== "string" || o.name.length === 0) fail("commands[].name", "must be a non-empty string");
  if (typeof o.summary !== "string") fail(`${o.name}.summary`, "must be a string");
  if (typeof o.call?.endpoint !== "string") fail(`${o.name}.call.endpoint`, "must be a string");
  const output = o.output as CommandOutput | undefined;
  if (output?.kind !== "table" && output?.kind !== "json") fail(`${o.name}.output.kind`, "must be table or json");
  if (output.kind === "table" && !Array.isArray(output.columns)) fail(`${o.name}.output.columns`, "required for a table");
  const columns =
    output.kind === "table" ? validateStringArray(output.columns, `${o.name}.output.columns`) : output.columns;
  const rows =
    output.rows === undefined
      ? undefined
      : typeof output.rows === "string"
        ? output.rows
        : fail(`${o.name}.output.rows`, "must be a string");
  const join = Array.isArray(o.join) ? o.join.map((j) => validateJoin(j, o.name!)) : undefined;
  const redact = Array.isArray(o.redact) ? validateStringArray(o.redact, `${o.name}.redact`) : [];
  return {
    name: o.name,
    summary: o.summary,
    call: { endpoint: o.call.endpoint, params: validateParams(o.call.params, o.name) },
    join,
    output: { ...output, columns, rows },
    redact,
  };
}

export function validateCommandsFile(value: unknown): CommandsFile {
  const o = value as Partial<CommandsFile>;
  if (typeof o !== "object" || o === null) fail("root", "must be an object");
  if (o.schemaVersion !== COMMANDS_SCHEMA_VERSION) fail("schemaVersion", `must be ${COMMANDS_SCHEMA_VERSION}`);
  if (typeof o.site !== "string") fail("site", "must be a string");
  if (!Array.isArray(o.commands)) fail("commands", "must be an array");
  let identity: IdentitySpec | undefined;
  if (o.identity) {
    const i = o.identity as Partial<IdentitySpec>;
    if (typeof i.endpoint !== "string" || typeof i.idField !== "string") {
      fail("identity", "needs endpoint, idField, and display[]");
    }
    const display = validateStringArray(i.display, "identity.display");
    const params = i.params === undefined ? undefined : validateStringMap(i.params, "identity.params");
    identity = { endpoint: i.endpoint, idField: i.idField, display, params };
  }
  return { schemaVersion: o.schemaVersion, site: o.site, identity, commands: o.commands.map(validateCommand) };
}

export function assertResolvable(
  commands: CommandsFile,
  endpoints: Pick<ManifestEndpoint, "id" | "params">[],
): void {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const need = (cmd: string, endpoint: string): Pick<ManifestEndpoint, "id" | "params"> => {
    const ep = byId.get(endpoint);
    if (!ep) {
      throw new Error(
        `commands.json: ${cmd} references endpoint '${endpoint}', which is not in client.json`,
      );
    }
    return ep;
  };

  if (commands.identity) {
    const idEp = need("identity", commands.identity.endpoint);
    const supplied = new Set(Object.keys(commands.identity.params ?? {}));
    const missing = idEp.params.filter((p) => p.required && !supplied.has(p.name));
    if (missing.length) {
      throw new Error(
        `commands.json: identity endpoint '${commands.identity.endpoint}' needs ` +
          `param(s) ${missing.map((p) => p.name).join(", ")} in identity.params ` +
          `(set them to your own id, e.g. from your profile URL)`,
      );
    }
  }
  for (const c of commands.commands) {
    need(c.name, c.call.endpoint);
    for (const j of c.join ?? []) {
      const ep = need(c.name, j.endpoint);
      const pathParams = ep.params.filter((p) => p.in === "path");
      if (pathParams.length !== 1) {
        throw new Error(
          `commands.json: ${c.name}.join lookup '${j.endpoint}' must have exactly one path param ` +
            `to receive the join key, but has ${pathParams.length}`,
        );
      }
    }
  }
}
