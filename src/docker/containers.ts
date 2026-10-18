import type { DockerContainer } from '../types';

/** Compose's own labels, which is how a container is tied back to its stack. */
export const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';

/** One container as listed, with the compose project it belongs to. */
export interface ListedContainer extends DockerContainer {
  project: string;
}

/**
 * Parses container listings from either CLI that produces them:
 *
 * - `docker ps -a --format '{{json .}}'` — what the monitor polls: one JSON
 *   object per line, labels as one "k=v,k=v" string, ports as "0.0.0.0:80->80/tcp".
 * - `docker compose ps -a --format json` — a JSON array on Compose ≥ 2.21 and
 *   NDJSON before it, with Project/Service/ExitCode/Publishers as real fields.
 *
 * Containers without a compose project are dropped: nothing Stack shows
 * comes from outside compose.
 */
export function parseContainerList(output: string): ListedContainer[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let rows: unknown[];
  if (trimmed.startsWith('[')) {
    try { rows = JSON.parse(trimmed) as unknown[]; } catch { return []; }
  } else {
    rows = trimmed.split('\n').flatMap((line) => {
      try { return [JSON.parse(line) as unknown]; } catch { return []; }
    });
  }
  return rows.flatMap((row) => {
    const c = toContainer(row as RawRow);
    return c ? [c] : [];
  });
}

interface RawRow {
  Name?: string;
  Names?: string;
  State?: string;
  Status?: string;
  Labels?: string | Record<string, string>;
  Project?: string;
  Service?: string;
  ExitCode?: number;
  Ports?: string;
  Publishers?: Array<{ PublishedPort?: number }>;
}

function toContainer(row: RawRow): ListedContainer | undefined {
  const labels = typeof row.Labels === 'string' ? parseLabels(row.Labels) : row.Labels ?? {};
  const project = row.Project ?? labels[PROJECT_LABEL];
  if (!project) return undefined;
  // `docker ps` reports "Names" (comma-joined aliases), compose ps "Name".
  const name = row.Name ?? row.Names?.split(',')[0] ?? 'unknown';
  // Lowercased: old engines said "Running" where new ones say "running", and
  // the card compares against the lowercase spelling.
  const state = (row.State ?? 'unknown').toLowerCase();
  const exitCode = state === 'exited' ? row.ExitCode ?? exitCodeFromStatus(row.Status) : undefined;
  const ports = row.Publishers
    ? row.Publishers.map((p) => p.PublishedPort ?? 0).filter((p) => p > 0)
    : parsePublishedPorts(row.Ports ?? '');
  const out: ListedContainer = { project, name, state, ports: [...new Set(ports)] };
  const service = row.Service ?? labels[SERVICE_LABEL];
  if (service) out.service = service;
  if (exitCode !== undefined) out.exitCode = exitCode;
  if (row.Status) out.status = row.Status;
  return out;
}

/**
 * `docker ps` flattens labels into one comma-joined string — and the
 * config_files label is itself a comma-joined list of paths. A segment with no
 * `key=` in front is therefore the continuation of the previous value, not a
 * label of its own.
 */
export function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last: string | undefined;
  for (const segment of raw.split(',')) {
    const m = /^([A-Za-z0-9_.\-/]+)=(.*)$/s.exec(segment);
    if (m) {
      last = m[1];
      out[last] = m[2];
    } else if (last !== undefined) {
      out[last] += `,${segment}`;
    }
  }
  return out;
}

function exitCodeFromStatus(status: string | undefined): number | undefined {
  const m = /^Exited \((-?\d+)\)/.exec(status ?? '');
  return m ? Number(m[1]) : undefined;
}

/** Ranges wider than this are not expanded — nobody publishes that many, and a typo should not allocate. */
const MAX_RANGE = 1000;

/**
 * Host ports out of `docker ps`'s Ports column:
 * "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 127.0.0.1:9000-9001->9000-9001/tcp".
 * Unpublished entries ("5432/tcp") carry no host port and are skipped.
 */
export function parsePublishedPorts(raw: string): number[] {
  const out = new Set<number>();
  for (const entry of raw.split(',')) {
    const arrow = entry.indexOf('->');
    if (arrow === -1) continue;
    const host = entry.slice(0, arrow).trim();
    const spec = host.slice(host.lastIndexOf(':') + 1);
    for (const p of expandPortSpec(spec)) out.add(p);
  }
  return [...out];
}

/** "8080" → [8080]; "8000-8002" → [8000, 8001, 8002]; anything else → []. */
export function expandPortSpec(spec: string): number[] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (!m) return [];
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from <= 0 || to < from || to - from > MAX_RANGE) return [];
  const out: number[] = [];
  for (let p = from; p <= to; p++) out.push(p);
  return out;
}
