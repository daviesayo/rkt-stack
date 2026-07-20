import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { secretsDir, secretsFile } from "./paths";

/** Reserved secrets key for the OAuth refresh token. */
export const REFRESH_TOKEN_KEY = "@refresh_token";

interface SecretBody {
  /** location -> value, e.g. {"cookie:PHPSESSID": "...", "x-csrf-token": "..."} */
  values: Record<string, string>;
  storedAt: string;
  /** Legacy single-value field, read for forward compat only. */
  value?: string;
}

/**
 * Write the credential atomically at 0600.
 *
 * writeFile's mode option applies only when creating a new file, so
 * overwriting an existing loose-permission file would expose the credential
 * until a follow-up chmod. Writing a fresh 0600 temp file and renaming it
 * into place closes that window: rename is atomic and keeps the source mode.
 */
export async function writeSecret(
  site: string,
  values: Record<string, string> | string,
): Promise<void> {
  const dir = secretsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir ignores mode when the directory already exists.
  await chmod(dir, 0o700);

  const finalPath = secretsFile(site);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  const normalized = typeof values === "string" ? { default: values } : values;
  const body: SecretBody = { values: normalized, storedAt: new Date().toISOString() };

  try {
    await writeFile(tmpPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, finalPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

/** All stored credentials for a site, keyed by location. */
export async function readSecrets(site: string): Promise<Record<string, string> | null> {
  try {
    const body = JSON.parse(await readFile(secretsFile(site), "utf8")) as SecretBody;
    if (body.values && typeof body.values === "object") return body.values;
    if (typeof body.value === "string") return { default: body.value };
    return null;
  } catch {
    return null;
  }
}

/** Single-credential accessor, kept for callers that only need one value. */
export async function readSecret(site: string): Promise<string | null> {
  const all = await readSecrets(site);
  if (!all) return null;
  return Object.values(all)[0] ?? null;
}

/** Redact every value in a bundle, longest first so substrings cannot survive. */
export function redactAll(
  text: string,
  values: Record<string, string> | string | null,
): string {
  if (!values) return text;
  if (typeof values === "string") return redact(text, values);
  let out = text;
  for (const v of Object.values(values).sort((a, b) => b.length - a.length)) {
    out = redact(out, v);
  }
  return out;
}

/**
 * Mask a secret in text bound for a terminal or log. Masks both the stored
 * value and its bare token, since "Bearer abc" is stored whole while "abc"
 * may appear alone elsewhere.
 *
 * Callers must redact BEFORE truncating: redacting after a slice can emit a
 * partial secret that no longer matches.
 */
const REDACTED = "[REDACTED]";

export function redact(text: string, secret: string | null): string {
  if (!secret || secret.length === 0) return text;

  const bare = secret.replace(/^bearer\s+/i, "");
  let out = text.split(secret).join(REDACTED);
  if (bare !== secret && bare.length > 0) {
    out = out.split(bare).join(REDACTED);
  }
  return out;
}

/**
 * Return a copy of headers with credential values replaced before serialization.
 * Masks at the value level so JSON.stringify escaping cannot hide the secret.
 */
export function maskHeaders(
  headers: Record<string, string>,
  secret: Record<string, string> | string | null,
): Record<string, string> {
  if (secret && typeof secret === "object") {
    // Mask longest-first so a short value cannot leave a longer one partly
    // visible after substitution.
    let out = { ...headers };
    for (const v of Object.values(secret).sort((a, b) => b.length - a.length)) {
      out = maskHeaders(out, v);
    }
    return out;
  }
  if (!secret || secret.length === 0) return { ...headers };

  const bare = secret.replace(/^bearer\s+/i, "");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === secret) {
      out[key] = REDACTED;
    } else if (value.includes(secret)) {
      out[key] = value.split(secret).join(REDACTED);
    } else if (bare !== secret && bare.length > 0 && value.includes(bare)) {
      out[key] = value.split(bare).join(REDACTED);
    } else {
      out[key] = value;
    }
  }
  return out;
}
