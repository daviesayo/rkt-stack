import { expect, test } from "bun:test";
import { assertResolvable, COMMANDS_SCHEMA_VERSION, validateCommandsFile } from "../src/lib/commands-schema";

const valid = () => JSON.parse(require("fs").readFileSync(`${import.meta.dir}/fixtures/commands.example.json`, "utf8"));

test("accepts a valid commands file", () => {
  const cf = validateCommandsFile(valid());
  expect(cf.schemaVersion).toBe(COMMANDS_SCHEMA_VERSION);
  expect(cf.commands[0].name).toBe("shifts");
  expect(cf.commands[0].join?.[0].onError).toBe("blank");
});

test("rejects an unsupported schema version, naming the field", () => {
  expect(() => validateCommandsFile({ ...valid(), schemaVersion: 99 })).toThrow(/schemaVersion/i);
});

test("rejects a command with no name", () => {
  const cf = valid(); delete cf.commands[0].name;
  expect(() => validateCommandsFile(cf)).toThrow(/name/i);
});

test("rejects a table output with no columns", () => {
  const cf = valid(); cf.commands[0].output = { kind: "table" };
  expect(() => validateCommandsFile(cf)).toThrow(/columns/i);
});

test("rejects an onError outside the allowed set", () => {
  const cf = valid(); cf.commands[0].join[0].onError = "explode";
  expect(() => validateCommandsFile(cf)).toThrow(/onError/i);
});

test("defaults onError to blank when omitted", () => {
  const cf = valid(); delete cf.commands[0].join[0].onError;
  expect(validateCommandsFile(cf).commands[0].join?.[0].onError).toBe("blank");
});

test("rejects a non-array commands field", () => {
  expect(() => validateCommandsFile({ schemaVersion: 1, site: "x", commands: {} })).toThrow(/commands/i);
});

test("rejects non-string join select elements", () => {
  const cf = valid();
  cf.commands[0].join[0].select = [42];
  expect(() => validateCommandsFile(cf)).toThrow(/join\[\]\.select\[0\]/);
});

test("rejects non-string output columns", () => {
  const cf = valid();
  cf.commands[0].output.columns = ["date", null];
  expect(() => validateCommandsFile(cf)).toThrow(/output\.columns\[1\]/);
});

test("rejects non-string identity display elements", () => {
  const cf = valid();
  cf.identity.display = [123];
  expect(() => validateCommandsFile(cf)).toThrow(/identity\.display\[0\]/);
});

test("rejects non-string redact elements", () => {
  const cf = valid();
  cf.commands[0].redact = [false];
  expect(() => validateCommandsFile(cf)).toThrow(/redact\[0\]/);
});

test("rejects non-string call.params values", () => {
  const cf = valid();
  cf.commands[0].call.params = { start: 123 };
  expect(() => validateCommandsFile(cf)).toThrow(/call\.params\.start/);
});

test("rejects non-object call.params", () => {
  const cf = valid();
  cf.commands[0].call.params = [];
  expect(() => validateCommandsFile(cf)).toThrow(/call\.params/);
});

const ep = (id: string, pathParams: number) => ({
  id,
  method: "GET",
  writeSemantics: null,
  params: Array.from({ length: pathParams }, (_, i) => ({
    name: i === 0 ? "id" : `id${i + 1}`,
    in: "path" as const,
    type: "string" as const,
    required: true,
  })),
});

test("passes an optional output.rows path through", () => {
  const cf = valid();
  cf.commands[0].output = { kind: "table", columns: ["a"], rows: "data" };
  expect(validateCommandsFile(cf).commands[0].output.rows).toBe("data");
});

test("assertResolvable accepts commands whose endpoints all exist", () => {
  const cf = validateCommandsFile(valid());
  expect(() =>
    assertResolvable(cf, [
      ep("get.api.v1.employees.me", 0),
      ep("get.scheduling.getShifts", 0),
      ep("get.api.v1.clients.id", 1),
    ]),
  ).not.toThrow();
});

test("assertResolvable rejects a call endpoint the manifest lacks", () => {
  const cf = validateCommandsFile(valid());
  expect(() => assertResolvable(cf, [ep("get.api.v1.employees.me", 0)])).toThrow(
    /get\.scheduling\.getShifts/,
  );
});

test("assertResolvable rejects a join lookup that is not single-path-param", () => {
  const cf = validateCommandsFile(valid());
  expect(() =>
    assertResolvable(cf, [
      ep("get.api.v1.employees.me", 0),
      ep("get.scheduling.getShifts", 0),
      ep("get.api.v1.clients.id", 2), // two path params: ambiguous target for the join key
    ]),
  ).toThrow(/exactly one path param/i);
});

test("assertResolvable rejects an identity endpoint missing a required path param in params", () => {
  const cf = validateCommandsFile(valid()); // identity -> get.api.v1.employees.me
  expect(() =>
    assertResolvable(cf, [
      ep("get.api.v1.employees.me", 1), // required path param must be pinned in identity.params
      ep("get.scheduling.getShifts", 0),
      ep("get.api.v1.clients.id", 1),
    ]),
  ).toThrow(/identity\.params/);
});

test("assertResolvable accepts an identity endpoint whose required query param is supplied", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "get.user.profile", params: { username: "usr-me" }, idField: "user.api_id", display: ["user.name"] },
    commands: [],
  });
  const eps = [{ id: "get.user.profile", method: "GET", writeSemantics: null, params: [{ name: "username", in: "query", type: "string", required: true }] }];
  expect(() => assertResolvable(cf, eps as never)).not.toThrow();
});

test("assertResolvable rejects when a required identity param is missing", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "get.user.profile", idField: "user.api_id", display: ["user.name"] },
    commands: [],
  });
  const eps = [{ id: "get.user.profile", method: "GET", writeSemantics: null, params: [{ name: "username", in: "query", type: "string", required: true }] }];
  expect(() => assertResolvable(cf, eps as never)).toThrow(/username/);
  expect(() => assertResolvable(cf, eps as never)).toThrow(/identity\.params/);
});

test("assertResolvable accepts a param-free identity endpoint (back-compat)", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "get.api.v1.employees.924", idField: "id", display: ["full_name"] },
    commands: [],
  });
  const eps = [{ id: "get.api.v1.employees.924", method: "GET", writeSemantics: null, params: [] }];
  expect(() => assertResolvable(cf, eps as never)).not.toThrow();
});

test("identity carries a validated params map through validation", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "get.user.profile", params: { username: "usr-me" }, idField: "user.api_id", display: ["user.name"] },
    commands: [],
  });
  expect(cf.identity?.params).toEqual({ username: "usr-me" });
});

test("identity.params rejects a non-string value under an identity.params label", () => {
  expect(() =>
    validateCommandsFile({
      schemaVersion: 1, site: "s",
      identity: { endpoint: "e", params: { username: 5 }, idField: "id", display: [] },
      commands: [],
    }),
  ).toThrow(/identity\.params\.username/);
});

test("identity without params still validates (back-compat)", () => {
  const cf = validateCommandsFile({
    schemaVersion: 1, site: "s",
    identity: { endpoint: "e", idField: "id", display: ["full_name"] },
    commands: [],
  });
  expect(cf.identity?.params).toBeUndefined();
});

const WRITE_EP = { id: "post.api.events", params: [], method: "POST", writeSemantics: { bodyShape: null, bodyHints: {}, contentType: "application/json" } };
const READ_EP = { id: "get.api.events", params: [], method: "GET", writeSemantics: null };

const file = (cmd: Record<string, unknown>) => ({
  schemaVersion: 1,
  site: "x",
  commands: [{ name: "c", summary: "s", output: { kind: "json" }, redact: [], ...cmd }],
});

test("write and call.body survive validation", () => {
  const f = validateCommandsFile(
    file({ write: true, call: { endpoint: "post.api.events", body: { name: "@arg:title" } } }),
  );
  expect(f.commands[0].write).toBe(true);
  expect(f.commands[0].call.body).toEqual({ name: "@arg:title" });
});

test("rejects a command on a write endpoint without write: true", () => {
  const f = validateCommandsFile(file({ call: { endpoint: "post.api.events" } }));
  expect(() => assertResolvable(f, [WRITE_EP] as never)).toThrow(/write: true/);
});

test("rejects write: true on a read endpoint", () => {
  const f = validateCommandsFile(file({ write: true, call: { endpoint: "get.api.events" } }));
  expect(() => assertResolvable(f, [READ_EP] as never)).toThrow(/is not a write endpoint/);
});

test("rejects a non-boolean write", () => {
  expect(() => validateCommandsFile(file({ write: "yes", call: { endpoint: "x" } }))).toThrow(/write/);
});

test("rejects an @arg hole with no modelled body shape", () => {
  const f = { schemaVersion: 1, site: "x", commands: [{
    name: "event-create", summary: "", write: true,
    call: { endpoint: "post.api.events", body: { nope: "@arg:nope" } },
    output: { kind: "json" }, redact: [],
  }] };
  expect(() => assertResolvable(f as never, [WRITE_EP] as never)).toThrow(/no modelled shape/);
});

test("assertResolvable accepts an @arg hole in a modelled array body", () => {
  const f = { schemaVersion: 1, site: "x", commands: [{
    name: "tag-update", summary: "", write: true,
    call: { endpoint: "post.api.tags", body: ["@arg:tags_0"] },
    output: { kind: "json" }, redact: [],
  }] };
  const endpoints = [{
    id: "post.api.tags",
    params: [],
    method: "POST",
    writeSemantics: {
      bodyShape: { type: "array", items: { type: "string" } },
      bodyHints: {},
      contentType: "application/json",
    },
  }];
  expect(() => assertResolvable(f as never, endpoints as never)).not.toThrow();
});

test("assertResolvable accepts a root-level @arg string body hole", () => {
  const f = { schemaVersion: 1, site: "x", commands: [{
    name: "note-create", summary: "", write: true,
    call: { endpoint: "post.api.notes", body: "@arg:name" },
    output: { kind: "json" }, redact: [],
  }] };
  const endpoints = [{
    id: "post.api.notes",
    params: [],
    method: "POST",
    writeSemantics: {
      bodyShape: { type: "string" },
      bodyHints: {},
      contentType: "application/json",
    },
  }];
  expect(() => assertResolvable(f as never, endpoints as never)).not.toThrow();
});

test("assertResolvable rejects a root-level @arg hole with no modelled body shape", () => {
  const f = { schemaVersion: 1, site: "x", commands: [{
    name: "note-create", summary: "", write: true,
    call: { endpoint: "post.api.notes", body: "@arg:name" },
    output: { kind: "json" }, redact: [],
  }] };
  const endpoints = [{
    id: "post.api.notes",
    params: [],
    method: "POST",
    writeSemantics: { bodyShape: null, bodyHints: {}, contentType: "application/json" },
  }];
  expect(() => assertResolvable(f as never, endpoints as never)).toThrow(/no modelled shape/);
});
