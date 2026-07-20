/**
 * Generate a standalone typed client from a derived manifest.
 *
 * Usage: bun src/generate.ts --manifest <path/to/client.json> --out <rkt-clients-root>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitCli, emitTypes } from "./lib/codegen";
import { validateManifest } from "./lib/manifest";

export interface GeneratedFiles {
  siteDir: string;
  written: string[];
}

/**
 * Runtime modules copied into the generated repo.
 *
 * manifest-schema.ts is self-contained (ParamSpec, JsonShape, RefreshSpec).
 * refresh.ts re-exports RefreshSpec and implements OIDC renewal without har.ts.
 * reauth.ts depends on paths.ts and playwright (dev-time only for browser tier).
 * transport.ts imports manifest-schema type-only; secrets.ts imports paths.ts.
 * Copying manifest.ts or refresh-detect.ts would drag in the derivation pipeline.
 *
 * If you add a file here, re-run the closure probe: generate into a temp dir,
 * bun install, and tsc --noEmit in the generated out.
 */
const RUNTIME_FILES = [
  "paths.ts",
  "manifest-schema.ts",
  "secrets.ts",
  "ratelimit.ts",
  "transport.ts",
  "refresh.ts",
  "reauth.ts",
];

const COPIED_HEADER = `// Copied from the rkt derive-client skill. Do not edit here.
// Edit the skill's src/lib/ and regenerate.
`;

const GITIGNORE = `# Credentials and recordings never belong in this repo.
secrets/
recordings/
node_modules/

# HAR files carry full session cookies wherever they land.
*.har
*.har.zip

# Serialized browser sessions (Playwright storageState) are credential material.
*.storage-state.json
`;

// devDependencies are required: tsconfig sets types: ["bun"], so a repo
// without @types/bun installed fails `tsc --noEmit` with TS2688.
const PACKAGE_JSON = `{
  "name": "rkt-clients",
  "private": true,
  "type": "module",
  "dependencies": {
    "playwright": "1.56.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "5.9.2"
  }
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
`;

const README = `# rkt-clients

Generated API clients derived from recorded browser sessions.

Each directory is one site. Run a client with:

    bun <site>/cli.ts <command> [--param value ...] [--dry-run]

Run any command with no arguments to list the available subcommands.

Credentials are NOT stored here. Each client reads its session credential from
\`~/.rkt-clients/secrets/<site>.json\` at runtime. Delete that file to revoke a
client's access.

\`lib/\` and every \`<site>/\` directory are generated. Do not edit them by hand:
re-run \`/derive-client\` and regenerate instead.
`;

async function write(path: string, contents: string, written: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  written.push(path);
}

export async function generateClient(
  manifestPath: string,
  outRoot: string,
): Promise<GeneratedFiles> {
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const written: string[] = [];

  // Repo scaffold. Written every run so the files stay correct; contents are
  // fixed, so this is idempotent.
  await write(join(outRoot, ".gitignore"), GITIGNORE, written);
  await write(join(outRoot, "package.json"), PACKAGE_JSON, written);
  await write(join(outRoot, "tsconfig.json"), TSCONFIG, written);
  await write(join(outRoot, "README.md"), README, written);

  // Shared runtime, copied from this skill's tested lib.
  const libSrc = join(dirname(fileURLToPath(import.meta.url)), "lib");
  for (const file of RUNTIME_FILES) {
    const contents = await readFile(join(libSrc, file), "utf8");
    await write(join(outRoot, "lib", file), `${COPIED_HEADER}\n${contents}`, written);
  }

  // Site directory.
  const siteDir = join(outRoot, manifest.site);
  await write(join(siteDir, "client.json"), `${JSON.stringify(manifest, null, 2)}\n`, written);
  await write(join(siteDir, "types.ts"), emitTypes(manifest), written);
  await write(join(siteDir, "cli.ts"), emitCli(manifest), written);

  return { siteDir, written };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const manifestPath = arg("manifest");
  const out = arg("out");
  if (!manifestPath || !out) {
    console.error("usage: bun src/generate.ts --manifest <path> --out <rkt-clients-root>");
    process.exit(1);
  }

  const { siteDir, written } = await generateClient(manifestPath, out);
  console.error(`Generated ${written.length} file(s).`);
  console.error(`Client: ${siteDir}`);
  console.error(`Run it: bun ${join(siteDir, "cli.ts")}`);
}

if (import.meta.main) {
  await main();
}
