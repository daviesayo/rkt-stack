/**
 * Emit a valid starter commands.json from a derived manifest.
 *
 * Usage: bun src/scaffold-commands.ts --manifest <path/to/client.json> --out <path/to/commands.json>
 *
 * This is the draft-mode backbone: it guarantees correct endpoint ids and a
 * schema-valid file the agent (or the user) then refines with joins, tables,
 * and redactions. It refuses to overwrite an existing commands.json.
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { commandNames } from "./lib/codegen";
import { validateManifest } from "./lib/manifest";
import type { ClientManifest, JsonShape, ManifestEndpoint, ParamSpec } from "./lib/manifest-schema";
import type { CommandsFile, IdentitySpec } from "./lib/commands-schema";

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Make an arg name unique within one command's body. `stubBody`'s `_`-joined
 * names can collide across branches (e.g. `a.b` and a top-level `a_b` both
 * flatten to "a_b"); a shared flag would silently write one value into two
 * unrelated body paths, so a collision is disambiguated with a numeric
 * suffix instead.
 */
function uniqueArgName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let i = 2;
  while (used.has(`${name}_${i}`)) i += 1;
  const disambiguated = `${name}_${i}`;
  used.add(disambiguated);
  return disambiguated;
}

/** Every scalar leaf becomes an editable hole; the curator prunes and pins. */
function stubBody(shape: JsonShape | null, prefix = "", used: Set<string> = new Set()): unknown {
  if (!shape) return undefined;
  if (shape.type !== "object") {
    // Array- or scalar-rooted bodies aren't modelled by this scaffolder. A
    // bare `@arg:` value AT THE ROOT would resolve fine (shapeTypeAt("") just
    // returns the shape's own type), so it can't be made to fail loudly the
    // way a nested hole can. Wrap it in a probe key instead: assertResolvable
    // walks into it, finds no matching property on a non-object shape, and
    // rejects -- forcing the curator to author the body by hand rather than
    // silently shipping a write with no body at all.
    return { __unsupported_root_shape__: "@arg:__unsupported_root_shape__" };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape.properties)) {
    if (k === "*") {
      // A scrubbed wildcard key has no real property name to author a
      // matching arg for. Emit an @arg: value anyway (rather than a plain
      // string) so it flows through argPaths/shapeTypeAt like every other
      // hole: the wildcard property never resolves in the modelled shape, so
      // assertResolvable rejects it instead of letting it ship unnoticed.
      const scrubName = uniqueArgName(prefix ? `${prefix}_scrubbed` : "scrubbed", used);
      out["__scrubbed__"] = `@arg:${scrubName}`;
      continue;
    }
    const path = prefix ? `${prefix}_${k}` : k;
    if (v.type === "object") {
      out[k] = stubBody(v, path, used);
    } else if (v.type === "array") {
      out[k] =
        v.items.type === "object"
          ? [stubBody(v.items, `${path}_0`, used)]
          : [`@arg:${uniqueArgName(`${path}_0`, used)}`];
    } else {
      out[k] = `@arg:${uniqueArgName(path, used)}`;
    }
  }
  return out;
}

const NAME_FIELDS = ["name", "full_name", "display_name", "first_name"];
const ID_FIELDS = ["api_id", "id", "uuid", "user_id", "username"];
const USER_PROP_NAMES = ["user", "profile", "account", "me", "viewer", "employee", "member"];

function objProps(shape: JsonShape | undefined): Record<string, JsonShape> | null {
  return shape && shape.type === "object" ? shape.properties : null;
}
function firstPresent(props: Record<string, JsonShape>, names: string[]): string | null {
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const hit = lower.get(n);
    if (hit) return hit;
  }
  return null;
}
function findUserObject(shape: JsonShape): { userPath: string; props: Record<string, JsonShape> } | null {
  const root = objProps(shape);
  if (!root) return null;
  const has = (props: Record<string, JsonShape>) =>
    (firstPresent(props, NAME_FIELDS) || firstPresent(props, ["email"])) && firstPresent(props, ID_FIELDS);
  if (has(root)) return { userPath: "", props: root };
  for (const name of USER_PROP_NAMES) {
    const key = firstPresent(root, [name]);
    if (!key) continue;
    const sub = objProps(root[key]);
    if (sub && has(sub)) return { userPath: `${key}.`, props: sub };
  }
  return null;
}
function score(e: ManifestEndpoint, rootLevel: boolean): number {
  const p = e.pathTemplate;
  let s = 0;
  if (/(^|\/)(me|self|current|viewer|whoami)(\/|$)/.test(p)) s += 3;
  if (/(^|\/)(user|profile|account|employee|member)(\/|$)/.test(p)) s += 1;
  if (!e.params.some((x) => x.required)) s += 2;
  if (rootLevel) s += 1;
  return s;
}
function detectIdentity(manifest: ClientManifest): IdentitySpec | undefined {
  const cands = manifest.endpoints
    .map((e) => ({ e, u: findUserObject(e.responseShape) }))
    .filter((c): c is { e: ManifestEndpoint; u: { userPath: string; props: Record<string, JsonShape> } } => c.u !== null)
    .map((c) => ({ ...c, s: score(c.e, c.u.userPath === "") }));
  if (!cands.length) return undefined;
  const reqCount = (e: ManifestEndpoint) => e.params.filter((p) => p.required).length;
  cands.sort(
    (a, b) => b.s - a.s || reqCount(a.e) - reqCount(b.e) || manifest.endpoints.indexOf(a.e) - manifest.endpoints.indexOf(b.e),
  );
  const w = cands[0];
  const idKey = firstPresent(w.u.props, ID_FIELDS)!;
  const nameKey = firstPresent(w.u.props, NAME_FIELDS);
  const emailKey = firstPresent(w.u.props, ["email"]);
  const display = [nameKey, emailKey].filter((k): k is string => k !== null).map((k) => `${w.u.userPath}${k}`);
  const params: Record<string, string> = {};
  for (const p of w.e.params as ParamSpec[]) if (p.required) params[p.name] = p.example ?? "";
  return {
    endpoint: w.e.id,
    idField: `${w.u.userPath}${idKey}`,
    display,
    params: Object.keys(params).length ? params : undefined,
  };
}

export function scaffoldCommands(manifest: ClientManifest): CommandsFile {
  const allowWrites = manifest.mode === "full";
  const names = commandNames(manifest.endpoints, { allowWrites });
  const identity = detectIdentity(manifest);
  const commands = manifest.endpoints
    .filter((e) => e.id !== identity?.endpoint)
    .map((e) => {
      const isWrite = !READ_METHODS.has(e.method.toUpperCase());
      const body = isWrite ? stubBody(e.writeSemantics?.bodyShape ?? null) : undefined;
      return {
        name: names.get(e.id)!,
        summary: `${e.method} ${e.pathTemplate}`,
        call: {
          endpoint: e.id,
          params: {} as Record<string, string>,
          ...(body === undefined ? {} : { body }),
        },
        output: { kind: "json" as const },
        redact: [] as string[],
        ...(isWrite ? { write: true } : {}),
      };
    });

  return { schemaVersion: 1, site: manifest.site, identity, commands };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const manifestPath = arg("manifest");
  const out = arg("out");
  if (!manifestPath || !out) {
    console.error("usage: bun src/scaffold-commands.ts --manifest <path> --out <commands.json path>");
    process.exit(1);
  }
  if (await access(out).then(() => true).catch(() => false)) {
    console.error(`refusing to overwrite existing ${out}; commands.json is yours to edit`);
    process.exit(1);
  }
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const commands = scaffoldCommands(manifest);
  await writeFile(out, `${JSON.stringify(commands, null, 2)}\n`);
  console.error(`Wrote a draft commands.json with ${commands.commands.length} command(s) to ${out}`);
  console.error("Edit it to add joins, table output, and redactions, then run generate.ts.");
}

if (import.meta.main) {
  await main();
}
