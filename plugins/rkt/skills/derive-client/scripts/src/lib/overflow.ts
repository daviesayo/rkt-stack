import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { outDir } from "./paths";

/**
 * An error with a built-in recovery path. Library code throws these; the
 * generated CLI's top-level catch turns them into `fail(message, hint, code)`.
 * Library code must never process.exit — unit tests assert on throws.
 */
export class CliError extends Error {
  readonly hint: string;
  readonly exitCode: number;
  constructor(message: string, hint: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export const MAX_BYTES = 50_000;
export const MAX_ROWS = 200;
const KEEP_SPILLS = 20;

/** Cap text at a byte budget without splitting the final line mid-way. */
export function capText(text: string, maxBytes = MAX_BYTES): { text: string; capped: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, capped: false };
  let out = Buffer.from(text).subarray(0, maxBytes).toString();
  // A multi-byte char sliced in half decodes to U+FFFD at the end; drop it.
  out = out.replace(/\uFFFD+$/, "");
  const lastNewline = out.lastIndexOf("\n");
  if (lastNewline > 0) out = out.slice(0, lastNewline);
  return { text: out, capped: true };
}

/** Write the full payload for a capped result; prune the site dir to the newest 20. */
export async function writeSpill(
  site: string,
  command: string,
  payload: string,
  now: Date,
): Promise<string> {
  const dir = outDir(site);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/${ts}-${command}.json`;
  await writeFile(path, payload, { mode: 0o600 });
  // Best-effort prune; concurrent invocations may race, so ignore ENOENT.
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  for (const stale of files.slice(0, Math.max(0, files.length - KEEP_SPILLS))) {
    await rm(`${dir}/${stale}`, { force: true });
  }
  return path;
}

export function footer(opts: {
  exitCode: number;
  startedAt: number;
  size: { rows: number } | { bytes: number };
  spillPath?: string;
}): string {
  const secs = ((Date.now() - opts.startedAt) / 1000).toFixed(1);
  const size = "rows" in opts.size ? `${opts.size.rows} rows` : `${opts.size.bytes} bytes`;
  const full = opts.spillPath ? ` | full: ${opts.spillPath}` : "";
  return `[exit:${opts.exitCode} | ${secs}s | ${size}${full}]`;
}
