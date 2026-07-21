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
import type { ClientManifest } from "./lib/manifest-schema";
import type { CommandsFile } from "./lib/commands-schema";

export function scaffoldCommands(manifest: ClientManifest): CommandsFile {
  const names = commandNames(manifest.endpoints);
  const identityEp = manifest.endpoints.find(
    (e) => /\.me$/.test(e.id) && e.params.every((p) => p.in !== "path"),
  );
  const commands = manifest.endpoints
    .filter((e) => e.id !== identityEp?.id)
    .map((e) => ({
      name: names.get(e.id)!,
      summary: `${e.method} ${e.pathTemplate}`,
      call: { endpoint: e.id, params: {} as Record<string, string> },
      output: { kind: "json" as const },
      redact: [] as string[],
    }));

  return {
    schemaVersion: 1,
    site: manifest.site,
    identity: identityEp ? { endpoint: identityEp.id, idField: "id", display: [] } : undefined,
    commands,
  };
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
