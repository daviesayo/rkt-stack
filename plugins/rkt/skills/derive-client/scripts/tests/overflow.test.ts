import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, capText, footer, writeSpill } from "../src/lib/overflow";
import { outDir } from "../src/lib/paths";

let root: string;
const ORIG_ROOT = process.env.RKT_CLIENTS_ROOT;
const ORIG_NODE_ENV = process.env.NODE_ENV;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rkt-ovf-"));
  process.env.RKT_CLIENTS_ROOT = root;
  process.env.NODE_ENV = "test";
});
afterEach(async () => {
  if (ORIG_ROOT === undefined) delete process.env.RKT_CLIENTS_ROOT;
  else process.env.RKT_CLIENTS_ROOT = ORIG_ROOT;
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
  await rm(root, { recursive: true, force: true });
});

test("CliError carries hint and exit code, defaults to 1", () => {
  const e = new CliError("boom", "run: cli login", 4);
  expect(e.message).toBe("boom");
  expect(e.hint).toBe("run: cli login");
  expect(e.exitCode).toBe(4);
  expect(new CliError("x", "y").exitCode).toBe(1);
  expect(e).toBeInstanceOf(Error);
});

test("outDir lives under rktRoot", () => {
  expect(outDir("Ex Ample")).toBe(`${root}/out/ex-ample`);
});

test("writeSpill writes 0600 under out/<site> and returns the path", async () => {
  const p = await writeSpill("example", "shifts-today", "[1,2]", new Date("2026-07-22T10:00:00Z"));
  expect(p.startsWith(`${root}/out/example/`)).toBe(true);
  expect(p.endsWith("-shifts-today.json")).toBe(true);
  expect(await Bun.file(p).text()).toBe("[1,2]");
  const mode = (await stat(p)).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("writeSpill prunes to the newest 20 files", async () => {
  for (let i = 0; i < 25; i++) {
    await writeSpill("example", "cmd", "{}", new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
  }
  const files = await readdir(`${root}/out/example`);
  expect(files.length).toBe(20);
});

test("capText caps at the byte limit and reports capped", () => {
  const small = capText("abc", 50_000);
  expect(small).toEqual({ text: "abc", capped: false });
  const big = capText("x".repeat(60_000), 50_000);
  expect(big.capped).toBe(true);
  expect(Buffer.byteLength(big.text)).toBeLessThanOrEqual(50_000);
});

test("footer formats rows, bytes, and optional spill path", () => {
  const t0 = Date.now() - 1400;
  const f = footer({ exitCode: 0, startedAt: t0, size: { rows: 132 }, spillPath: "/tmp/x.json" });
  expect(f).toMatch(/^\[exit:0 \| \d+(\.\d)?s \| 132 rows \| full: \/tmp\/x\.json\]$/);
  const g = footer({ exitCode: 1, startedAt: Date.now(), size: { bytes: 42 } });
  expect(g).toMatch(/^\[exit:1 \| \d+(\.\d)?s \| 42 bytes\]$/);
});
