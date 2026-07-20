import type { HarEntry } from "./har";

export interface ParamSpec {
  name: string;
  in: "path" | "query";
  type: "string" | "number";
}

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
      params.push({ name, in: "query", type: inferType(values) });
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

export type JsonShape =
  | { type: "object"; properties: Record<string, JsonShape>; required: string[] }
  | { type: "array"; items: JsonShape }
  | { type: "string" | "number" | "boolean" | "null" | "unknown" };

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
