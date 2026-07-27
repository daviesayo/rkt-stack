import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IdentitySpec } from "./commands-schema";
import { identityCacheFile } from "./session";
import { getPath } from "./render";

interface IdentityCache {
  id: string;
  display: Record<string, unknown>;
  label: string;
}

// In-process serialization. Two concurrent cache writes would otherwise race on
// the same "<path>.<pid>.tmp" file, where one error handler removes the
// other's temp file. lock.ts is not part of the client runtime by design.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeIdentityCache(path: string, cache: IdentityCache): Promise<void> {
  return serialize(async () => {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  });
}

export type FetchEndpoint = (endpointId: string, params?: Record<string, string>) => Promise<unknown>;

export async function resolveIdentity(
  site: string,
  spec: IdentitySpec,
  fetchEndpoint: FetchEndpoint,
): Promise<IdentityCache> {
  const path = identityCacheFile(site);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as IdentityCache;
    // Pre-label caches may have id without label; treat as a miss so we refetch and rewrite.
    if (typeof parsed.id === "string" && typeof parsed.label === "string") return parsed;
  } catch (err) {
    // ENOENT is the normal cold-cache path. A corrupt or unreadable cache is
    // also recoverable (we re-fetch and overwrite), but surface anything that
    // is not simply "absent" so a real fault is not masked as a cache miss.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`identity cache unreadable (${(err as Error).message}); re-fetching`);
    }
  }

  const body = await fetchEndpoint(spec.endpoint, spec.params ?? {});
  const idRaw = getPath(body, spec.idField);
  if (idRaw == null) {
    throw new Error(`identity endpoint returned no idField '${spec.idField}'`);
  }
  const display: Record<string, unknown> = {};
  for (const f of spec.display) display[f] = getPath(body, f);
  const cache: IdentityCache = { id: String(idRaw), display, label: whoamiLine(display, spec.display) };

  // Atomic write at 0600, mirroring secrets.ts, so an overwrite never leaves a
  // prior file's mode in place.
  await writeIdentityCache(path, cache);
  return cache;
}

export function whoamiLine(display: Record<string, unknown>, fields: string[]): string {
  const parts = fields.map((f) => display[f]).filter((v) => v != null).map(String);
  if (parts.length === 0) return "unknown";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} (${parts.slice(1).join(", ")})`;
}
