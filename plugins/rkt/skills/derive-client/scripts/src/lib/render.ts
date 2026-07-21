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

function redactClone<T>(data: T, paths: string[]): T {
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

export function renderJson(data: unknown, opts: { redact: string[]; raw: boolean }): string {
  const out = opts.raw ? data : redactClone(data, opts.redact);
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
