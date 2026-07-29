import type { CommandSpec } from "./commands-schema";
import type { ManifestEndpoint } from "./manifest-schema";

/** Mirrors tokens.ts: @today with an optional ±<n><d|w|m|y> offset. */
const TODAY = /^@today(?:[+-]\d+[dwmy]?)?$/;

/**
 * Paging arguments are namespaced so they can never collide with a real API
 * param (no HTTP API names a query param "_limit" by accident, and Task 4
 * rejects any exposed param starting with "_").
 */
export const RESERVED_ARGS = ["_limit", "_offset"] as const;

const RESERVED = new Set<string>(RESERVED_ARGS);

/** Runtime guard: paging arg names must stay aligned with tool schema injection. */
export function assertReservedPagingArgs(): void {
  const expected: readonly string[] = ["_limit", "_offset"];
  if (
    RESERVED_ARGS.length !== expected.length ||
    RESERVED_ARGS.some((name, i) => name !== expected[i])
  ) {
    throw new Error("RESERVED_ARGS drifted from paging arg names");
  }
}

export type ParamKind =
  | { kind: "server" }
  | { kind: "arg"; name: string }
  | { kind: "literal" }
  | { kind: "unknown-token" };

export function classifyParam(value: string): ParamKind {
  if (value.startsWith("@@")) return { kind: "literal" };
  if (value === "@me") return { kind: "server" };
  if (TODAY.test(value)) return { kind: "server" };
  if (value.startsWith("@arg:")) return { kind: "arg", name: value.slice("@arg:".length) };
  // An unrecognised @token is not a literal: resolveToken throws for it.
  if (value.startsWith("@")) return { kind: "unknown-token" };
  return { kind: "literal" };
}

/**
 * Neutralise an agent-supplied value so it cannot assert an identity or a date.
 * runCommand pushes every merged param through resolveToken, so an unescaped
 * "@me" from a tool call would resolve to the operator. Security control.
 */
export function escapeAgentValue(v: string): string {
  return v.startsWith("@") ? `@${v}` : v;
}

export interface ExposedParam {
  name: string;
  required: boolean;
  type: "string" | "number";
}

/**
 * Which curated params become tool arguments. A param with no matching
 * ParamSpec is dropped: buildRequest ignores it, so exposing it would advertise
 * an argument that provably does nothing on the wire.
 */
export function exposedParams(cmd: CommandSpec, endpoint: ManifestEndpoint): ExposedParam[] {
  const specs = new Map(endpoint.params.map((p) => [p.name, p]));
  const out: ExposedParam[] = [];
  for (const [name, value] of Object.entries(cmd.call.params ?? {})) {
    const spec = specs.get(name);
    if (!spec) continue;
    const k = classifyParam(value);
    if (k.kind === "server" || k.kind === "unknown-token") continue;
    out.push({ name, required: k.kind === "arg", type: spec.type });
  }
  return out;
}

/**
 * Params that would throw at runtime on every single call: an @arg: hole with
 * no ParamSpec (unsuppliable, because buildRequest drops it) or an unknown
 * @token. Callers reject these at startup rather than per call.
 */
export function unsatisfiableArgs(cmd: CommandSpec, endpoint: ManifestEndpoint): string[] {
  const specs = new Set(endpoint.params.map((p) => p.name));
  const bad: string[] = [];
  for (const [name, value] of Object.entries(cmd.call.params ?? {})) {
    const k = classifyParam(value);
    if (k.kind === "unknown-token") bad.push(name);
    else if (k.kind === "arg" && !specs.has(name)) bad.push(name);
    else if (RESERVED.has(name) && specs.has(name)) bad.push(name);
  }
  for (const param of endpoint.params) {
    if (RESERVED.has(param.name) && !bad.includes(param.name)) bad.push(param.name);
  }
  return bad;
}
