export interface TokenContext {
  resolveMe: () => Promise<string>;
  timezone?: string;
  /** Parsed --<name> flag values, for @arg: holes in a curated body. */
  args?: Record<string, string>;
}

export function isToken(value: string): boolean {
  return value.startsWith("@");
}

const TODAY = /^@today(?:([+-])(\d+)([dwmy]?))?$/;

function formatDate(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function applyOffset(base: Date, sign: string, n: number, unit: string): Date {
  const d = new Date(base);
  const k = sign === "-" ? -n : n;
  switch (unit || "d") {
    case "d":
      d.setUTCDate(d.getUTCDate() + k);
      break;
    case "w":
      d.setUTCDate(d.getUTCDate() + k * 7);
      break;
    case "m":
      d.setUTCMonth(d.getUTCMonth() + k);
      break;
    case "y":
      d.setUTCFullYear(d.getUTCFullYear() + k);
      break;
  }
  return d;
}

export async function resolveToken(value: string, ctx: TokenContext, now: Date): Promise<string> {
  if (!isToken(value)) return value;
  if (value.startsWith("@@")) return value.slice(1);

  if (value.startsWith("@arg:")) {
    const name = value.slice("@arg:".length);
    const supplied = ctx.args?.[name];
    if (supplied === undefined) {
      throw new Error(`missing required argument --${name} (body field wants ${value})`);
    }
    return supplied;
  }

  if (value === "@me") return ctx.resolveMe();

  const m = TODAY.exec(value);
  if (m) {
    const base = m[1] ? applyOffset(now, m[1], Number(m[2]), m[3]) : now;
    return formatDate(base, ctx.timezone ?? process.env.TZ);
  }

  throw new Error(
    `unresolvable param token ${value}: not one of @me, @today, @today±<n><d|w|m|y>, @arg:<name>`,
  );
}
