import { expandPortSpec } from './containers';

/** One host port the resolved compose model will publish. */
export interface PublishedPort {
  service: string;
  port: number;
}

interface RawPort {
  published?: string | number;
}

/**
 * Every host port in `docker compose config --format json` output.
 *
 * Read off the RESOLVED model on purpose: Compose concatenates `ports` from
 * the base file and the override instead of replacing them, so the only way to
 * know what a worktree will actually publish is to ask compose to do the merge.
 * `published` is a string on newer compose and a number on older, and may be a
 * range; an entry without one gets an ephemeral port and cannot collide.
 */
export function publishedPorts(configJson: string): PublishedPort[] {
  let model: { services?: Record<string, { ports?: RawPort[] }> };
  try { model = JSON.parse(configJson) as typeof model; } catch { return []; }
  const out: PublishedPort[] = [];
  const seen = new Set<number>();
  for (const [service, def] of Object.entries(model.services ?? {})) {
    for (const entry of def.ports ?? []) {
      if (entry.published === undefined || entry.published === '') continue;
      for (const port of expandPortSpec(String(entry.published))) {
        if (seen.has(port)) continue;
        seen.add(port);
        out.push({ service, port });
      }
    }
  }
  return out;
}

export interface PortConflict extends PublishedPort {
  /** The env var Stack generated it from; absent for a port hard-coded in a compose file. */
  generatedVar?: string;
  /** The compose project already publishing it, when it is another compose stack the extension can see. */
  heldBy?: string;
}

/**
 * Turns a set of busy ports into the one message that tells the user what to
 * change. The hard-coded case gets the compose syntax spelled out, because the
 * merge behaviour behind it is the surprising part.
 */
export function conflictMessage(conflicts: PortConflict[], composeFile: string): string {
  const describe = (c: PortConflict) =>
    `${c.port} (${c.service}${c.heldBy ? `, held by "${c.heldBy}"` : ''})`;
  const fixed = conflicts.filter((c) => !c.generatedVar);
  const generated = conflicts.filter((c) => c.generatedVar);
  const parts: string[] = [];
  if (fixed.length > 0) {
    parts.push(
      `Port ${fixed.map(describe).join(', ')} is hard-coded and already in use. ` +
        `Compose adds the override's \`ports\` to the ones in ${composeFile} instead of replacing them, ` +
        'so every worktree tries to publish it. Use a variable there (e.g. "${DB_PORT:-27017}:27017" ' +
        'and add DB_PORT to the generated ports), or replace the list in the override with `ports: !override` ' +
        '(`ports: !reset []` to publish nothing).',
    );
  }
  if (generated.length > 0) {
    parts.push(
      `Port ${generated.map((c) => `${describe(c)} from ${c.generatedVar}`).join(', ')} is already in use by something else.`,
    );
  }
  return parts.join(' ');
}
