export const COMMANDS_SCHEMA_VERSION = 1;

export interface IdentitySpec {
  endpoint: string;
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

function validateJoin(j: unknown, cmd: string): JoinSpec {
  const o = j as Partial<JoinSpec>;
  if (typeof o?.key !== "string") fail(`${cmd}.join[].key`, "must be a string");
  if (typeof o.endpoint !== "string") fail(`${cmd}.join[].endpoint`, "must be a string");
  if (!Array.isArray(o.select)) fail(`${cmd}.join[].select`, "must be an array");
  if (typeof o.as !== "string") fail(`${cmd}.join[].as`, "must be a string");
  const onError = o.onError ?? "blank";
  if (!["blank", "key", "fail"].includes(onError)) fail(`${cmd}.join[].onError`, "must be blank, key, or fail");
  return { key: o.key, endpoint: o.endpoint, select: o.select as string[], as: o.as, onError };
}

function validateCommand(c: unknown): CommandSpec {
  const o = c as Partial<CommandSpec>;
  if (typeof o?.name !== "string" || o.name.length === 0) fail("commands[].name", "must be a non-empty string");
  if (typeof o.summary !== "string") fail(`${o.name}.summary`, "must be a string");
  if (typeof o.call?.endpoint !== "string") fail(`${o.name}.call.endpoint`, "must be a string");
  const output = o.output as CommandOutput | undefined;
  if (output?.kind !== "table" && output?.kind !== "json") fail(`${o.name}.output.kind`, "must be table or json");
  if (output.kind === "table" && !Array.isArray(output.columns)) fail(`${o.name}.output.columns`, "required for a table");
  const join = Array.isArray(o.join) ? o.join.map((j) => validateJoin(j, o.name!)) : undefined;
  return {
    name: o.name,
    summary: o.summary,
    call: { endpoint: o.call.endpoint, params: o.call.params ?? {} },
    join,
    output,
    redact: Array.isArray(o.redact) ? (o.redact as string[]) : [],
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
    if (typeof i.endpoint !== "string" || typeof i.idField !== "string" || !Array.isArray(i.display)) {
      fail("identity", "needs endpoint, idField, and display[]");
    }
    identity = { endpoint: i.endpoint, idField: i.idField, display: i.display as string[] };
  }
  return { schemaVersion: o.schemaVersion, site: o.site, identity, commands: o.commands.map(validateCommand) };
}
