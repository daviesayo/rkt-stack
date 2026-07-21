export interface AuthStatusInput {
  identity: { name: string } | null;
  accessExpiry: string | null;
  refreshWindow: null;
  storageStateMtime: number | null;
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  // Drop a trailing "0m" so exactly-N-hour durations read "2h", matching the
  // spec's sample output, not "2h 0m".
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

export function formatAuthStatus(input: AuthStatusInput, now: number): string[] {
  const lines: string[] = [];

  lines.push(
    input.identity ? `Signed in as ${input.identity.name}` : "Signed in as unknown (run whoami)",
  );

  if (!input.accessExpiry) {
    lines.push("Access token     unknown");
  } else {
    const delta = Date.parse(input.accessExpiry) - now;
    lines.push(delta <= 0 ? "Access token     expired" : `Access token     expires in ${humanDuration(delta)}`);
  }

  lines.push("Refresh window   unknown");

  lines.push(
    input.storageStateMtime == null
      ? "Browser session  none saved"
      : `Browser session saved ${humanDuration(now - input.storageStateMtime)} ago`,
  );

  return lines;
}
