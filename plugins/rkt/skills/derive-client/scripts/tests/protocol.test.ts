import { expect, test } from "bun:test";
import { parseCommand } from "../src/lib/protocol";

test("parses a goto command", () => {
  expect(parseCommand('{"kind":"goto","url":"https://example.test"}')).toEqual({
    kind: "goto",
    url: "https://example.test",
  });
});

test("parses click, fill, wait, snapshot and done", () => {
  expect(parseCommand('{"kind":"click","selector":"#next"}')).toEqual({
    kind: "click",
    selector: "#next",
  });
  expect(parseCommand('{"kind":"fill","selector":"#q","value":"x"}')).toEqual({
    kind: "fill",
    selector: "#q",
    value: "x",
  });
  expect(parseCommand('{"kind":"wait","ms":500}')).toEqual({ kind: "wait", ms: 500 });
  expect(parseCommand('{"kind":"snapshot"}')).toEqual({ kind: "snapshot" });
  expect(parseCommand('{"kind":"done"}')).toEqual({ kind: "done" });
});

test("rejects an unknown command kind", () => {
  expect(() => parseCommand('{"kind":"eval","code":"1"}')).toThrow(/unknown command/i);
});

test("rejects a goto without a url", () => {
  expect(() => parseCommand('{"kind":"goto"}')).toThrow(/url/i);
});

test("rejects a non-http url scheme", () => {
  expect(() => parseCommand('{"kind":"goto","url":"file:///etc/passwd"}')).toThrow(/http/i);
});

test("rejects malformed JSON with a clear message", () => {
  expect(() => parseCommand("not json")).toThrow(/invalid command JSON/i);
});

test("clamps an excessive wait to the ceiling", () => {
  expect(parseCommand('{"kind":"wait","ms":999999}')).toEqual({ kind: "wait", ms: 30000 });
});
