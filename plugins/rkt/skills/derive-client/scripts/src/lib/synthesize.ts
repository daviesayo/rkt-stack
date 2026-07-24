import type { HarEntry } from "./har";
import type { JsonShape, ParamSpec, WriteSemantics } from "./manifest-schema";

export type { JsonShape, ParamSpec } from "./manifest-schema";

const READ_METHODS = new Set(["GET", "HEAD"]);

const ISO8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /^https?:\/\/\S+$/i;

export interface EndpointGroup {
  method: string;
  origin: string;
  pathTemplate: string;
  params: ParamSpec[];
  samples: HarEntry[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeIdentifier(segment: string): boolean {
  return /^\d+$/.test(segment) || UUID.test(segment);
}

function inferType(values: string[]): "string" | "number" {
  return values.every((v) => v !== "" && /^-?\d+(\.\d+)?$/.test(v)) ? "number" : "string";
}

/**
 * Replace segments that vary across observations with {id}, {id2}, and so on.
 * A single observation is never templated: one sample cannot show variation,
 * and guessing there would produce false parameters.
 */
export function templatePath(paths: string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((p) => p.split("/"));
  const width = split[0].length;
  if (!split.every((s) => s.length === width)) return paths[0];

  let counter = 0;
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const values = split.map((s) => s[i]);
    const varies = new Set(values).size > 1;
    if (varies && values.every(looksLikeIdentifier)) {
      counter += 1;
      out.push(counter === 1 ? "{id}" : `{id${counter}}`);
    } else {
      out.push(values[0]);
    }
  }
  return out.join("/");
}

export function groupEndpoints(entries: HarEntry[]): EndpointGroup[] {
  // First bucket by method plus a coarse shape key, so only comparable paths
  // are templated together.
  const buckets = new Map<string, HarEntry[]>();
  for (const e of entries) {
    const u = new URL(e.url);
    const shape = u.pathname
      .split("/")
      .map((s) => (looksLikeIdentifier(s) ? "*" : s))
      .join("/");
    const key = `${e.method} ${u.origin} ${shape}`;
    const list = buckets.get(key) ?? [];
    list.push(e);
    buckets.set(key, list);
  }

  const groups: EndpointGroup[] = [];
  for (const samples of buckets.values()) {
    const urls = samples.map((s) => new URL(s.url));
    const origin = urls[0].origin;
    const pathTemplate = templatePath(urls.map((u) => u.pathname));

    const params: ParamSpec[] = [];

    // Path params, in template order.
    const templateSegments = pathTemplate.split("/");
    const actualSegments = urls.map((u) => u.pathname.split("/"));
    templateSegments.forEach((seg, i) => {
      const match = seg.match(/^\{(\w+)\}$/);
      if (!match) return;
      params.push({
        name: match[1],
        in: "path",
        type: inferType(actualSegments.map((a) => a[i])),
        required: true,
        example: actualSegments[0]?.[i],
      });
    });

    // Query params, union across samples.
    const queryValues = new Map<string, string[]>();
    for (const u of urls) {
      for (const [name, value] of u.searchParams) {
        queryValues.set(name, [...(queryValues.get(name) ?? []), value]);
      }
    }
    for (const [name, values] of queryValues) {
      params.push({
        name,
        in: "query",
        type: inferType(values),
        // Seen on every sample means the endpoint refuses without it. Carrying
        // an observed value lets a caller invoke the endpoint without having to
        // reverse-engineer its required arguments.
        required: values.length === urls.length,
        example: values[0],
      });
    }

    groups.push({
      method: samples[0].method,
      origin,
      pathTemplate,
      params,
      samples,
    });
  }

  return groups;
}

function shapeOf(value: unknown): JsonShape {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? shapeOf(value[0]) : { type: "unknown" } };
  }
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      const properties: Record<string, JsonShape> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        properties[k] = shapeOf(v);
      }
      return { type: "object", properties, required: Object.keys(properties) };
    }
    default:
      return { type: "unknown" };
  }
}

/**
 * Merge shapes across samples. A key absent from any sample is optional,
 * which is why required is an intersection rather than a union.
 */
function mergeShapes(a: JsonShape, b: JsonShape): JsonShape {
  if (a.type === "unknown") return b;
  if (b.type === "unknown") return a;
  if (a.type === "object" && b.type === "object") {
    const properties: Record<string, JsonShape> = { ...a.properties };
    for (const [k, v] of Object.entries(b.properties)) {
      properties[k] = k in properties ? mergeShapes(properties[k], v) : v;
    }
    return {
      type: "object",
      properties,
      required: a.required.filter((k) => b.required.includes(k)),
    };
  }
  if (a.type === "array" && b.type === "array") {
    return { type: "array", items: mergeShapes(a.items, b.items) };
  }
  return a.type === b.type ? a : { type: "unknown" };
}

export function inferShape(bodies: string[]): JsonShape {
  let merged: JsonShape | null = null;
  for (const body of bodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { type: "unknown" };
    }
    const shape = shapeOf(parsed);
    merged = merged === null ? shape : mergeShapes(merged, shape);
  }
  return merged ?? { type: "unknown" };
}

/** Classify a value's FORMAT. Returns a hint only; the value never escapes. */
export function formatHint(value: string): string | undefined {
  if (UUID_RE.test(value)) return "uuid";
  if (EMAIL.test(value)) return "email";
  if (URL_RE.test(value)) return "url";
  if (ISO8601.test(value)) return "iso8601";
  return undefined;
}

/**
 * An object key that classifies as data (an email, uuid, or long opaque id) is
 * a VALUE wearing a key's clothing. Persisting it as a schema property name
 * would leak PII into the committed client.json, so such maps collapse to a
 * single wildcard entry.
 */
function isDataKey(key: string): boolean {
  // A plain length threshold is far too aggressive: real schemas have long
  // snake_case field names ("organization_identifier", "recipient_email_address"),
  // and collapsing those to a wildcard silently destroys the body model with no
  // signal. Only classify a key as data when it looks like an identifier VALUE:
  // a format-hint match (email/uuid/url/iso8601), or an opaque token with no
  // word separators and mixed alphanumerics.
  if (formatHint(key) !== undefined) return true;
  const opaque = /^[A-Za-z0-9]{16,}$/.test(key) && /\d/.test(key);
  const prefixedId = /^[a-z]{2,5}[-_][A-Za-z0-9]{10,}$/.test(key); // usr-8YWsBVeEy8stAMd
  return opaque || prefixedId;
}

const WILDCARD = "*";

function scrubShape(shape: JsonShape): JsonShape {
  if (shape.type === "array") return { type: "array", items: scrubShape(shape.items) };
  if (shape.type !== "object") return shape;

  const dataKeys: string[] = [];
  const schemaKeys: string[] = [];
  for (const k of Object.keys(shape.properties)) {
    if (isDataKey(k)) dataKeys.push(k);
    else schemaKeys.push(k);
  }

  const properties: Record<string, JsonShape> = {};
  if (dataKeys.length > 0) {
    const merged = dataKeys.map((k) => shape.properties[k]).reduce(mergeShapes);
    properties[WILDCARD] = scrubShape(merged);
  }
  for (const k of schemaKeys) properties[k] = scrubShape(shape.properties[k]);

  return {
    type: "object",
    properties,
    required: shape.required.filter((k) => !isDataKey(k)),
  };
}

function collectHints(value: unknown, prefix: string, out: Record<string, string>): void {
  if (Array.isArray(value)) return; // v1: no array-index or wildcard hint syntax
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isDataKey(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      const hint = formatHint(v);
      if (hint) out[path] = hint;
    } else {
      collectHints(v, path, out);
    }
  }
}

function isJsonContentType(ct: string): boolean {
  return /json/i.test(ct);
}

/**
 * Model a write endpoint's request body as shape + format hints, never values.
 * Returns null for a read endpoint. Always non-null for a write, even bodyless,
 * because its presence is what marks the endpoint as a write downstream.
 */
export function inferWriteSemantics(group: EndpointGroup): WriteSemantics | null {
  if (READ_METHODS.has(group.method.toUpperCase())) return null;

  const contentType =
    group.samples.map((s) => s.requestHeaders["content-type"] ?? "").find((c) => c.length > 0) ?? null;

  const bodies = group.samples
    .map((s) => s.postData)
    .filter((b): b is string => typeof b === "string" && b.length > 0);

  // Bodyless, or a body we do not model in v1 (urlencoded / multipart): record
  // the content type and stop. inferShape collapses a parse failure to
  // "unknown" for the whole merge, so these must be caught before it runs.
  if (bodies.length === 0 || !contentType || !isJsonContentType(contentType)) {
    return { bodyShape: null, bodyHints: {}, contentType: bodies.length === 0 ? null : contentType };
  }

  const bodyHints: Record<string, string> = {};
  let merged: JsonShape | null = null;
  for (const body of bodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { bodyShape: null, bodyHints: {}, contentType };
    }
    collectHints(parsed, "", bodyHints);
    const shape = shapeOf(parsed);
    merged = merged === null ? shape : mergeShapes(merged, shape);
  }

  return { bodyShape: merged ? scrubShape(merged) : null, bodyHints, contentType };
}
