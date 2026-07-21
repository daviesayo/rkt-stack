import { expect, test } from "bun:test";
import { COMMANDS_SCHEMA_VERSION, validateCommandsFile } from "../src/lib/commands-schema";

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
