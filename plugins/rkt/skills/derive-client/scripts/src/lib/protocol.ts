export type Command =
  | { kind: "goto"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "wait"; ms: number }
  | { kind: "snapshot" }
  | { kind: "done" };

const MAX_WAIT_MS = 30000;

export function parseCommand(line: string): Command {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`invalid command JSON: ${line.slice(0, 80)}`);
  }

  switch (raw?.kind) {
    case "goto": {
      if (typeof raw.url !== "string" || raw.url.length === 0) {
        throw new Error("goto requires a url");
      }
      if (!/^https?:\/\//i.test(raw.url)) {
        throw new Error("goto url must use http or https");
      }
      return { kind: "goto", url: raw.url };
    }
    case "click": {
      if (typeof raw.selector !== "string") throw new Error("click requires a selector");
      return { kind: "click", selector: raw.selector };
    }
    case "fill": {
      if (typeof raw.selector !== "string") throw new Error("fill requires a selector");
      if (typeof raw.value !== "string") throw new Error("fill requires a value");
      return { kind: "fill", selector: raw.selector, value: raw.value };
    }
    case "wait": {
      const ms = Number(raw.ms);
      if (!Number.isFinite(ms) || ms < 0) throw new Error("wait requires a non-negative ms");
      return { kind: "wait", ms: Math.min(ms, MAX_WAIT_MS) };
    }
    case "snapshot":
      return { kind: "snapshot" };
    case "done":
      return { kind: "done" };
    default:
      throw new Error(`unknown command kind: ${String(raw?.kind)}`);
  }
}
