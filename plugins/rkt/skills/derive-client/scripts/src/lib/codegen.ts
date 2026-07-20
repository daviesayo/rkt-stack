import type { JsonShape } from "./synthesize";
import type { ManifestEndpoint } from "./manifest";

/**
 * Derive readable subcommand names from paths rather than raw endpoint ids.
 * Collisions are resolved by appending -2, -3 in manifest order, so the same
 * manifest always regenerates the same names.
 */
export function commandNames(endpoints: ManifestEndpoint[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Map<string, number>();

  for (const endpoint of endpoints) {
    const segments = endpoint.pathTemplate
      .split("/")
      .filter(Boolean)
      .filter((s) => !/^\{.*\}$/.test(s))
      .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
      .filter(Boolean);

    const method = endpoint.method.toUpperCase();
    const parts = method === "GET" ? segments : [method.toLowerCase(), ...segments];
    const base = parts.length > 0 ? parts.join("-") : method.toLowerCase();

    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    out.set(endpoint.id, seen === 0 ? base : `${base}-${seen + 1}`);
  }

  return out;
}

export function typeName(command: string): string {
  const pascal = command
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${pascal}Response`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** Render a shape as an inline type expression at the given indent depth. */
function typeExpr(shape: JsonShape, depth: number): string {
  const pad = "  ".repeat(depth);
  const padInner = "  ".repeat(depth + 1);

  switch (shape.type) {
    case "object": {
      const keys = Object.keys(shape.properties);
      if (keys.length === 0) return "Record<string, unknown>";
      const lines = keys.map((key) => {
        const optional = shape.required.includes(key) ? "" : "?";
        return `${padInner}${propKey(key)}${optional}: ${typeExpr(shape.properties[key], depth + 1)};`;
      });
      return `{\n${lines.join("\n")}\n${pad}}`;
    }
    case "array":
      return `Array<${typeExpr(shape.items, depth)}>`;
    case "string":
    case "number":
    case "boolean":
    case "null":
      return shape.type;
    default:
      return "unknown";
  }
}

/** Emit one exported type declaration for an endpoint's response shape. */
export function emitType(shape: JsonShape, name: string): string {
  return `export type ${name} = ${typeExpr(shape, 0)};\n`;
}
