import { readFile } from "node:fs/promises";

export interface HarEntry {
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  mimeType: string;
  responseBody: string | null;
  /** Request body text, needed to replay token grants. Empty when absent. */
  postData: string | null;
  startedDateTime: string;
}

interface RawHeader {
  name: string;
  value: string;
}

function headerMap(headers: RawHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

export async function readHar(path: string): Promise<HarEntry[]> {
  let parsed: any;
  try {
    if (path.endsWith(".zip")) {
      parsed = await readHarFromZip(path);
    } else {
      parsed = JSON.parse(await readFile(path, "utf8"));
    }
  } catch (err) {
    throw new Error(`could not read HAR at ${path}: ${(err as Error).message}`);
  }

  const entries = parsed?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`could not read HAR at ${path}: missing log.entries`);
  }

  return entries.map((e: any) => ({
    method: e.request?.method ?? "GET",
    url: e.request?.url ?? "",
    status: e.response?.status ?? 0,
    requestHeaders: headerMap(e.request?.headers),
    responseHeaders: headerMap(e.response?.headers),
    mimeType: e.response?.content?.mimeType ?? "",
    responseBody: e.response?.content?.text ?? null,
    postData: readPostData(e.request?.postData),
    startedDateTime: e.startedDateTime ?? "",
  }));
}

async function readHarFromZip(path: string): Promise<any> {
  // Playwright writes har.har plus one file per attached body into the zip.
  const { unzipSync } = await import("fflate");
  const buf = await readFile(path);
  const files = unzipSync(new Uint8Array(buf));

  const harName = Object.keys(files).find((n) => n.endsWith(".har"));
  if (!harName) throw new Error("no .har entry inside archive");

  const decoder = new TextDecoder();
  const har = JSON.parse(decoder.decode(files[harName]));

  for (const entry of har?.log?.entries ?? []) {
    const ref = entry.response?.content?._file;
    if (ref && files[ref]) {
      entry.response.content.text = decoder.decode(files[ref]);
    }
  }
  return har;
}

interface RawPostData {
  text?: string;
  params?: Array<{ name?: string; value?: string }>;
}

/**
 * HAR stores a request body either as raw text or as parsed params, depending
 * on content type. Normalize to urlencoded text so callers see one shape.
 */
function readPostData(post: RawPostData | undefined): string | null {
  if (!post) return null;
  if (typeof post.text === "string" && post.text.length > 0) return post.text;
  if (Array.isArray(post.params) && post.params.length > 0) {
    return post.params
      .map((p) => `${encodeURIComponent(p.name ?? "")}=${encodeURIComponent(p.value ?? "")}`)
      .join("&");
  }
  return null;
}
