import type { CommandsFile } from "./commands-schema";
import type { ClientManifest } from "./manifest-schema";

export interface DriftReport {
  broken: { command: string; endpoint: string }[];
  newSurface: string[];
}

export function detectDrift(commands: CommandsFile, manifest: ClientManifest): DriftReport {
  const have = new Set(manifest.endpoints.map((e) => e.id));
  const referenced = new Set<string>();
  const broken: DriftReport["broken"] = [];

  const note = (command: string, endpoint: string) => {
    referenced.add(endpoint);
    if (!have.has(endpoint)) broken.push({ command, endpoint });
  };

  if (commands.identity) note("identity", commands.identity.endpoint);
  for (const c of commands.commands) {
    note(c.name, c.call.endpoint);
    for (const j of c.join ?? []) note(c.name, j.endpoint);
  }

  const newSurface = manifest.endpoints.map((e) => e.id).filter((id) => !referenced.has(id));
  return { broken, newSurface };
}
