import type { JsonShape } from "./synthesize";

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
