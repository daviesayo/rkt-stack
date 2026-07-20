/**
 * Recorder: owns a persistent Chrome context with HAR recording enabled and
 * executes navigation commands read as JSON lines on stdin.
 *
 * Usage: bun src/record.ts --site <site>
 *
 * Every executed command is appended to flows.jsonl so the repair path can
 * replay the session later.
 */
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { acquireLock } from "./lib/lock";
import { profileDir, recordingDir, sanitizeSite, storageStateFile, secretsDir } from "./lib/paths";
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

  const sanitizedSite = sanitizeSite(site);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const outDir = recordingDir(site, timestamp);
  await mkdir(outDir, { recursive: true });

  const release = await acquireLock(site);
  try {
    const flowsPath = `${outDir}/flows.jsonl`;
    await writeFile(flowsPath, "", { mode: 0o600 });

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
  respond({
    ok: true,
    event: "ready",
    site: sanitizedSite,
    recordingDir: outDir,
    commandFile: arg("commands") ?? null,
  });

    // Command source. A named pipe was the original design, but opening a FIFO
    // for read blocks until a writer appears, and every agent Bash call is a
    // separate shell, so the writer never persisted and the recorder appeared
    // to hang with an empty log. A polled append-only file has no such
    // semantics and survives across calls.
    const commandFile = arg("commands");
    async function* commandLines(): AsyncGenerator<string> {
      if (!commandFile) {
        for await (const line of console) yield line;
        return;
      }
      await writeFile(commandFile, "", { flag: "a" });
      let consumed = 0;
      for (;;) {
        const all = (await readFile(commandFile, "utf8")).split("\n").filter((l) => l.trim());
        while (consumed < all.length) yield all[consumed++];
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    try {
      for await (const line of commandLines()) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let snapshot: unknown = null;
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
            case "snapshot": {
              // Previously a no-op, which made the skill's "map the site" step
              // impossible: with no way to see the page, the agent fell back to
              // asking the user to paste URLs by hand.
              snapshot = await page.evaluate(() => {
                const seen = new Set<string>();
                const links = Array.from(document.querySelectorAll("a[href]"))
                  .map((a) => ({
                    text: (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
                    href: (a as HTMLAnchorElement).href,
                  }))
                  .filter((l) => {
                    if (!l.text || !l.href.startsWith("http") || seen.has(l.href)) return false;
                    seen.add(l.href);
                    return true;
                  })
                  .slice(0, 120);
                const headings = Array.from(document.querySelectorAll("h1,h2"))
                  .map((h) => (h.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80))
                  .filter(Boolean)
                  .slice(0, 20);
                return { headings, links };
              });
              break;
            }
          }

          // Human-shaped pacing between actions.
          await page.waitForTimeout(400 + Math.floor(Math.random() * 900));
          await appendFile(flowsPath, `${JSON.stringify(command)}\n`);
          respond({ ok: true, url: page.url(), title: await page.title(), ...(snapshot ? { snapshot } : {}) });
        } catch (err) {
          respond({ ok: false, error: (err as Error).message, url: page.url() });
        }
      }
    } finally {
      // Persist the browser session BEFORE closing. Cookies that prove an SSO
      // session are usually session-scoped, so closing the browser discards
      // them and the profile directory alone cannot re-authenticate later.
      try {
        await mkdir(secretsDir(), { recursive: true, mode: 0o700 });
        await context.storageState({ path: storageStateFile(sanitizedSite) });
        await chmod(storageStateFile(sanitizedSite), 0o600);
      } catch (err) {
        respond({ ok: false, error: `could not save browser session: ${(err as Error).message}` });
      }
      // The HAR is only written on close, so this must always run.
      await context.close();
      respond({ ok: true, event: "closed", site: sanitizedSite, recordingDir: outDir });
    }
  } finally {
    await release();
  }
}

main().catch(async (err) => {
  respond({ ok: false, error: (err as Error).message });
  process.exit(1);
});
