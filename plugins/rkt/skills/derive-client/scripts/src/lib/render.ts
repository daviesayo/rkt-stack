const REDACTED = "[REDACTED]";

export function getPath(obj: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function setPath(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cur[keys[i]];
    if (!next || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  if (keys[keys.length - 1] in cur) cur[keys[keys.length - 1]] = value;
}

export function redactClone<T>(data: T, paths: string[]): T {
  const clone = JSON.parse(JSON.stringify(data));
  const apply = (node: unknown) => {
    if (node && typeof node === "object") {
      for (const p of paths) setPath(node as Record<string, unknown>, p, REDACTED);
    }
  };
  if (Array.isArray(clone)) clone.forEach(apply);
  else apply(clone);
  return clone;
}

/**
 * Redact at the envelope root AND at the path where rows live.
 *
 * redactClone alone only matches at the clone root (or per array element), so a
 * declared path like "attendee.email" silently matches nothing against
 * {"data":{"items":[...]}}. Applying it at the rows path INSTEAD would fix that
 * but break a redact entry that legitimately resolves at the root, turning one
 * leak into another. So this is additive: root first, then rows.
 */
export function redactCloneAt<T>(data: T, rowsPath: string | undefined, paths: string[]): T {
  const clone = redactClone(data, paths) as T;
  if (!clone || typeof clone !== "object") return clone;
  if (!rowsPath) return clone;
  const keys = rowsPath.split(".");
  let cur = clone as unknown as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cur[keys[i]];
    if (!next || typeof next !== "object") return clone;
    cur = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (!(last in cur)) return clone;
  cur[last] = redactClone(cur[last], paths);
  return clone;
}

export function renderJson(
  data: unknown,
  opts: { redact: string[]; raw: boolean; rowsPath?: string },
): string {
  const out = opts.raw ? data : redactCloneAt(data, opts.rowsPath, opts.redact);
  return JSON.stringify(out, null, 2);
}

export function renderTable(
  rows: Record<string, unknown>[],
  columns: string[],
  opts: { redact: string[]; raw: boolean },
): string {
  const redactSet = new Set(opts.raw ? [] : opts.redact);
  const cell = (row: Record<string, unknown>, col: string): string => {
    if (redactSet.has(col)) return REDACTED;
    const v = getPath(row, col);
    return v == null ? "" : String(v);
  };
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const line = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join("  ");
  return [line(columns), ...rows.map((r) => line(columns.map((c) => cell(r, c))))].join("\n");
}

/** Return a copy of rows sorted by a dotted column. Numbers compare numerically;
 *  everything else by locale string. null/undefined sort last. */
export function sortRows(
  rows: Record<string, unknown>[],
  column: string,
): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const x = getPath(a, column);
    const y = getPath(b, column);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  });
}
