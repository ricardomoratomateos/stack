import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { StackConfig, Worktree } from '../types';
import { isEnvName } from '../shell/shellQuote';

/**
 * Compose's own project-name normalisation (compose-go `NormalizeProjectName`):
 * lowercase, drop every character outside [a-z0-9_-], then strip leading `_`
 * and `-` — a name may not start with either. Mirrored exactly so the name
 * Stack computes for the main checkout is the one a plain `docker compose up`
 * in it really runs under.
 */
export function normalizeProjectName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '');
}

/** Six hex chars of the repo root: stable across reloads, short enough to read. */
function repoTag(repoRoot: string): string {
  return createHash('sha1').update(path.resolve(repoRoot)).digest('hex').slice(0, 6);
}

/**
 * The docker compose project name for a worktree: its directory basename plus
 * a short hash of the repository it belongs to, e.g. `feat-login-3fa2c1`.
 *
 * The basename alone was not unique: two repositories with a worktree for the
 * same branch shared one project, so `down` in one silently removed the other's
 * containers. Passed explicitly as `-p` to every command (and exported as
 * COMPOSE_PROJECT_NAME to scripts) so the compose template living in
 * `.stack/` doesn't make every worktree collide under the "stack" project.
 *
 * The main checkout keeps compose's default — its directory name — because
 * Stack runs its stack plain, exactly as the user would by hand.
 */
export function composeProject(worktree: Worktree): string {
  const base = normalizeProjectName(path.basename(worktree.path));
  if (worktree.isMain) return base;
  return `${base || 'worktree'}-${repoTag(worktree.repoRoot)}`;
}

/**
 * Names this worktree's stack may still be running under from before the
 * project name carried the repo hash: Stack's old sanitisation (invalid
 * characters became `-`) and compose's own default for a plain `docker compose
 * up` in the worktree. Looked up so a stack started by an older version is
 * still shown, still stopped, and never orphaned holding its ports.
 */
export function legacyComposeProjects(worktree: Worktree): string[] {
  if (worktree.isMain) return [];
  const basename = path.basename(worktree.path);
  const names = [
    basename.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
    normalizeProjectName(basename),
  ];
  return [...new Set(names)].filter((n) => n && n !== composeProject(worktree));
}

/** Docker orchestration is on when at least one port is configured — the same gate as the card's button. */
export function dockerConfigured(config: StackConfig): boolean {
  return config.docker.ports.length > 0;
}

/**
 * Auto-generated docker ports for a worktree, keyed by the env var name from
 * `stack.docker.ports`. Each worktree owns a contiguous block sized by
 * `portStride`; the i-th configured name gets `basePort + slot*stride + i`.
 *
 * The slot is derived from the worktree's debug port (a stable, unique value
 * already allocated per worktree), so no extra state or migration is needed.
 * DEBUG_PORT is special-cased to the worktree's own debug port so the value
 * matches the one already written to its launch.json.
 */
export function computeDockerPorts(worktree: Worktree, config: StackConfig): Record<string, number> {
  return dockerPortsFor(worktree.debugPort, config);
}

/**
 * The same derivation keyed by the debug port alone, so a port can be
 * validated *before* there is a worktree to attach it to. This is the single
 * source of truth for the mapping — the allocator and the compose env must
 * never drift apart on which ports a slot actually owns.
 */
export function dockerPortsFor(debugPort: number, config: StackConfig): Record<string, number> {
  const { ports, basePort, portStride } = config.docker;
  const slot = Math.max(0, debugPort - config.debugBasePort - 1);
  const result: Record<string, number> = {};
  let i = 0;
  for (const name of ports) {
    if (name === 'DEBUG_PORT') result[name] = debugPort;
    else result[name] = basePort + slot * portStride + i++;
  }
  return result;
}

/**
 * Every distinct port a worktree on this slot will try to bind. Always includes
 * the debug port itself, even when `stack.docker.ports` is empty — VSCode's
 * debug listener binds it too, and it collides just as happily.
 */
export function portBlockFor(debugPort: number, config: StackConfig): number[] {
  const block = new Set<number>([debugPort]);
  for (const port of Object.values(dockerPortsFor(debugPort, config))) block.add(port);
  return [...block];
}

/** Compose files resolved for one worktree; `override` absent when not configured or not found. */
export interface ComposeFiles {
  base: string;
  override?: string;
}

/**
 * `docker compose` argv for a worktree, given resolved absolute compose paths.
 * Worktrees run the base file plus the optional override under their own
 * project; the main repo always uses its plain stack.
 *
 * `--project-directory` is the worktree, always. Without it compose takes the
 * directory of the FIRST file as the project dir — and when the compose file
 * only exists in the main checkout that is main, so `build: .`, `./` volumes
 * and env_file in a worktree's stack all quietly resolved against main's code.
 *
 * `files` is left out only for `down` when the compose file is gone: compose
 * can still remove a stack by project name alone. `project` overrides the name
 * only to address a stack still running under a legacy one.
 */
export function composeArgv(
  worktree: Worktree,
  files: ComposeFiles | undefined,
  subcommand: string[],
  project = composeProject(worktree),
): string[] {
  if (worktree.isMain) return ['compose', ...subcommand];
  const fileArgs = files ? ['-f', files.base, ...(files.override ? ['-f', files.override] : [])] : [];
  return ['compose', '-p', project, '--project-directory', worktree.path, ...fileArgs, ...subcommand];
}

/** Env vars (string values) to inject when running compose for a worktree. */
export function dockerEnv(worktree: Worktree, config: StackConfig): Record<string, string> {
  if (worktree.isMain) return {};
  const out: Record<string, string> = {};
  for (const [name, port] of Object.entries(computeDockerPorts(worktree, config))) {
    // Names come from `stack.docker.ports` and are typed into a terminal as
    // `NAME=value` (dockerUp). One that is not an identifier is not an
    // assignment but a command — `A;curl x|sh` — so it is dropped here, where
    // every consumer gets the same answer. No shell could have exported it.
    if (!isEnvName(name)) continue;
    out[name] = String(port);
  }
  return out;
}

/**
 * What a setup/teardown script needs to run compose by hand and land on the
 * SAME compose stack the extension monitors and stops.
 *
 * Without COMPOSE_PROJECT_NAME a plain `docker compose up` in the script ran
 * under compose's default name: Stack never saw it, `down` never removed it,
 * and its containers kept holding the ports. COMPOSE_FILE uses the platform's
 * path separator, which is what compose splits it on by default.
 */
export function composeScriptEnv(
  worktree: Worktree,
  config: StackConfig,
  files: ComposeFiles,
  project = composeProject(worktree),
): Record<string, string> {
  if (worktree.isMain || !dockerConfigured(config)) return {};
  return {
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: [files.base, ...(files.override ? [files.override] : [])].join(path.delimiter),
    ...dockerEnv(worktree, config),
  };
}
