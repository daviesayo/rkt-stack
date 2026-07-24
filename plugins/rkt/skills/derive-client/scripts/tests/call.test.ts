import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDryRunPreview, parseParams } from "../src/call";
import { redact } from "../src/lib/secrets";

test("parses repeated --param pairs", () => {
  expect(parseParams(["--param", "id=4821", "--param", "week=2026-W30"])).toEqual({
    id: "4821",
    week: "2026-W30",
  });
});

test("keeps equals signs inside the value", () => {
  expect(parseParams(["--param", "q=a=b"])).toEqual({ q: "a=b" });
});

test("returns an empty object when no params are given", () => {
  expect(parseParams(["--endpoint", "x"])).toEqual({});
});

test("throws on a param without an equals sign", () => {
  expect(() => parseParams(["--param", "broken"])).toThrow(/expected k=v/i);
});

test("dry-run preview masks secrets that JSON would escape", () => {
  const secret = 'sid=va"lue\\tail';
  const preview = formatDryRunPreview(
    {
      method: "GET",
      url: "https://x.test/api/me",
      headers: { cookie: secret, accept: "application/json" },
    },
    secret,
  );
  expect(preview).not.toContain(secret);
  expect(preview).toContain("[REDACTED]");
});

test("success response body redacts echoed credentials", () => {
  const secret = "s3cr3tvalue";
  const body = JSON.stringify({ token: secret });
  expect(redact(body, secret)).not.toContain(secret);
  expect(redact(body, secret)).toContain("[REDACTED]");
});

test("call.ts refuses a write endpoint even with RKT_ALLOW_WRITES", async () => {
  const root = await mkdtemp(join(tmpdir(), "rkt-call-"));
  const manifestPath = join(root, "client.json");
  const manifest = {
    schemaVersion: 2,
    site: "example",
    baseUrl: "https://x.test",
    recordedAt: "2026-07-20T12:00:00.000Z",
    harSha256: "abc",
    userAgent: "Mozilla/5.0",
    clientHints: {},
    auth: null,
    authBundle: null,
    refresh: null,
    mode: "full",
    endpoints: [
      {
        id: "post.api.events",
        method: "POST",
        pathTemplate: "/api/events",
        params: [],
        responseShape: { type: "unknown" },
        source: "xhr",
        fragile: false,
        selectors: null,
        writeSemantics: { bodyShape: null, bodyHints: {}, contentType: "application/json" },
      },
    ],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const callTs = join(import.meta.dir, "../src/call.ts");
  const proc = Bun.spawn(
    ["bun", callTs, "--manifest", manifestPath, "--endpoint", "post.api.events"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test", RKT_CLIENTS_ROOT: root, RKT_ALLOW_WRITES: "1" },
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  await rm(root, { recursive: true, force: true });
  expect(exitCode).toBe(2);
  expect(stderr).toMatch(/read-only/i);
  expect(stdout).toBe("");
});
