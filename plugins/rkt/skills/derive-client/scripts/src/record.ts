/**
 * Recorder: owns a persistent Chrome context with HAR recording enabled and
 * executes navigation commands read as JSON lines on stdin.
 *
 * Usage: bun src/record.ts --site <site>
 *
 * Every executed command is appended to flows.json so the repair path can
 * replay the session later.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { acquireLock } from "./lib/lock";
import { profileDir, recordingDir } from "./lib/paths";
import { parseCommand } from "./lib/protocol";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function respond(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const site = arg("site");
  if (!site) {
    respond({ ok: false, error: "missing --site" });
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const outDir = recordingDir(site, timestamp);
  await mkdir(outDir, { recursive: true });

  const release = await acquireLock(site);
  const flowsPath = `${outDir}/flows.json`;
  await writeFile(flowsPath, "");

  const context = await chromium.launchPersistentContext(profileDir(site), {
    channel: "chrome",
    headless: false,
    serviceWorkers: "block",
    recordHar: {
      path: `${outDir}/session.har.zip`,
      content: "attach",
      mode: "full",
    },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  respond({ ok: true, event: "ready", recordingDir: outDir });

  try {
    for await (const line of console) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let command;
      try {
        command = parseCommand(trimmed);
      } catch (err) {
        respond({ ok: false, error: (err as Error).message });
        continue;
      }

      if (command.kind === "done") break;

      try {
        switch (command.kind) {
          case "goto":
            await page.goto(command.url, { waitUntil: "domcontentloaded" });
            break;
          case "click":
            await page.click(command.selector);
            break;
          case "fill":
            await page.fill(command.selector, command.value);
            break;
          case "wait":
            await page.waitForTimeout(command.ms);
            break;
          case "snapshot":
            break;
        }

        // Human-shaped pacing between actions.
        await page.waitForTimeout(400 + Math.floor(Math.random() * 900));
        await appendFile(flowsPath, `${JSON.stringify(command)}\n`);
        respond({ ok: true, url: page.url(), title: await page.title() });
      } catch (err) {
        respond({ ok: false, error: (err as Error).message, url: page.url() });
      }
    }
  } finally {
    // The HAR is only written on close, so this must always run.
    await context.close();
    await release();
    respond({ ok: true, event: "closed", recordingDir: outDir });
  }
}

main().catch(async (err) => {
  respond({ ok: false, error: (err as Error).message });
  process.exit(1);
});
