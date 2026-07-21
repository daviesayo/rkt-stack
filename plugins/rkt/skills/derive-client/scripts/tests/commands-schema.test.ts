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
  params: Array.from({ length: pathParams }, (_, i) => ({
    name: i === 0 ? "id" : `id${i + 1}`,
    in: "path" as const,
    type: "string" as const,
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

test("assertResolvable rejects an identity endpoint that is not id-free", () => {
  const cf = validateCommandsFile(valid()); // identity -> get.api.v1.employees.me
  expect(() =>
    assertResolvable(cf, [
      ep("get.api.v1.employees.me", 1), // a path param means it is not the /me-style id-free route
      ep("get.scheduling.getShifts", 0),
      ep("get.api.v1.clients.id", 1),
    ]),
  ).toThrow(/identity.*id-free|id-free/i);
});
