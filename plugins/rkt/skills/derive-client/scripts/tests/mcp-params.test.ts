import { expect, test } from "bun:test";
import { resolveToken } from "../src/lib/tokens";
import {
  RESERVED_ARGS,
  classifyParam,
  escapeAgentValue,
  exposedParams,
  unsatisfiableArgs,
} from "../src/lib/mcp-params";

const NOW = new Date("2026-07-21T12:00:00Z");
const ctx = { resolveMe: async () => "924" };

test("classifyParam covers every token form the codebase supports", () => {
  expect(classifyParam("@me")).toEqual({ kind: "server" });
  expect(classifyParam("@today")).toEqual({ kind: "server" });
  expect(classifyParam("@today+14d")).toEqual({ kind: "server" });
  expect(classifyParam("@today-3w")).toEqual({ kind: "server" });
  expect(classifyParam("@arg:query")).toEqual({ kind: "arg", name: "query" });
  expect(classifyParam("@@literal")).toEqual({ kind: "literal" });
  expect(classifyParam("plain")).toEqual({ kind: "literal" });
  expect(classifyParam("@bogus")).toEqual({ kind: "unknown-token" });
});

test("escapeAgentValue neutralises tokens in agent input", () => {
  expect(escapeAgentValue("@me")).toBe("@@me");
  expect(escapeAgentValue("@handle")).toBe("@@handle");
  expect(escapeAgentValue("plain")).toBe("plain");
});

test("escapeAgentValue round-trip preserves token-shaped agent literals", async () => {
  for (const original of ["@me", "@today", "@today+7d", "@arg:something", "@@"]) {
    const escaped = escapeAgentValue(original);
    expect(await resolveToken(escaped, ctx, NOW)).toBe(original);
  }
});

const EP = {
  id: "get.api.events",
  method: "GET",
  pathTemplate: "/api/events",
  params: [
    { name: "count", in: "query", type: "number" },
    { name: "q", in: "query", type: "string" },
  ],
};

test("exposedParams exposes literals and @arg holes, hides server tokens", () => {
  const cmd = { call: { params: { q: "@arg:query", count: "10", when: "@today" } } };
  expect(exposedParams(cmd as never, EP as never)).toEqual([
    { name: "q", required: true, type: "string" },
    { name: "count", required: false, type: "number" },
  ]);
});

test("exposedParams drops a literal with no matching ParamSpec (no ghost args)", () => {
  const cmd = { call: { params: { nope: "x" } } };
  expect(exposedParams(cmd as never, EP as never)).toEqual([]);
});

test("exposedParams lists every @arg hole the command requires", () => {
  const cmd = { call: { params: { q: "@arg:query", count: "10" } } };
  const exposed = exposedParams(cmd as never, EP as never);
  expect(exposed.find((p) => p.name === "q")).toEqual({
    name: "q",
    required: true,
    type: "string",
  });
});

test("exposedParams never advertises a param the command does not consume", () => {
  const cmd = { call: { params: { q: "@arg:query" } } };
  const exposed = exposedParams(cmd as never, EP as never);
  for (const p of exposed) {
    expect(cmd.call.params).toHaveProperty(p.name);
  }
});

test("unsatisfiableArgs flags an @arg hole that can never reach the wire", () => {
  const cmd = { call: { params: { nope: "@arg:nope" } } };
  expect(unsatisfiableArgs(cmd as never, EP as never)).toEqual(["nope"]);
});

test("unsatisfiableArgs also flags an unknown @token", () => {
  const cmd = { call: { params: { q: "@bogus" } } };
  expect(unsatisfiableArgs(cmd as never, EP as never)).toEqual(["q"]);
});

test("unsatisfiableArgs rejects reserved paging names that collide with real params", () => {
  const epWithLimit = {
    ...EP,
    params: [...EP.params, { name: "_limit", in: "query", type: "number" }],
  };
  const cmd = { call: { params: { _limit: "25" } } };
  expect(unsatisfiableArgs(cmd as never, epWithLimit as never)).toEqual(["_limit"]);
});

test("RESERVED_ARGS names the paging arguments Task 4 will inject", () => {
  expect(RESERVED_ARGS).toEqual(["_limit", "_offset"]);
});
