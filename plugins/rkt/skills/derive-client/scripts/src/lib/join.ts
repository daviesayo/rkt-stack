import type { JoinSpec } from "./commands-schema";
import { getPath } from "./render";

export type Lookup = (endpointId: string, key: string) => Promise<unknown>;

function setPath(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = cur[key];
    if (!next || typeof next !== "object") cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

async function resolveOne(
  keyValue: string,
  join: JoinSpec,
  lookup: Lookup,
  cache: Map<string, Promise<unknown>>,
): Promise<unknown> {
  let p = cache.get(keyValue);
  if (!p) {
    p = lookup(join.endpoint, keyValue);
    cache.set(keyValue, p);
  }
  const body = await p;
  const picked: Record<string, unknown> = {};
  for (const f of join.select) setPath(picked, f, getPath(body, f));
  return picked;
}

export async function applyJoins(
  rows: Record<string, unknown>[],
  joins: JoinSpec[],
  lookup: Lookup,
): Promise<Record<string, unknown>[]> {
  const out = rows.map((r) => ({ ...r }));
  for (const join of joins) {
    // One cache per join so distinct keys => distinct lookups, repeats shared.
    const cache = new Map<string, Promise<unknown>>();
    for (const row of out) {
      const raw = getPath(row, join.key);
      if (raw == null) {
        row[join.as] = join.onError === "key" ? "" : {};
        continue;
      }
      if (Array.isArray(raw)) {
        throw new Error(`join key '${join.key}' is array-valued; joins need a scalar reference`);
      }
      const keyValue = String(raw);
      try {
        row[join.as] = await resolveOne(keyValue, join, lookup, cache);
      } catch (err) {
        if (join.onError === "fail") throw err;
        row[join.as] = join.onError === "key" ? keyValue : {};
      }
    }
  }
  return out;
}
