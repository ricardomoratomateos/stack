import * as path from 'node:path';
import type { UnmessConfig, Worktree } from '../types';

/**
 * The docker compose project name for a worktree = its directory basename,
 * matching what `docker compose` uses by default when run in that directory
 * (and what the main repo's own stack already runs under). Passed explicitly as
 * `-p` to every command so the compose template living in `.unmess/` doesn't
 * make every worktree collide under the "unmess" project, and so `docker
 * compose ps` finds the same containers Unmess started.
 */
export function composeProject(worktree: Worktree): string {
  return path.basename(worktree.path).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/**
 * Auto-generated docker ports for a worktree, keyed by the env var name from
 * `unmess.docker.ports`. Each worktree owns a contiguous block sized by
 * `portStride`; the i-th configured name gets `basePort + slot*stride + i`.
 *
 * The slot is derived from the worktree's Xdebug port (a stable, unique value
 * already allocated per worktree), so no extra state or migration is needed.
 * XDEBUG_PORT is special-cased to the worktree's own Xdebug port so the value
 * matches the one already written to its launch.json.
 */
export function computeDockerPorts(worktree: Worktree, config: UnmessConfig): Record<string, number> {
  const { ports, basePort, portStride } = config.docker;
  const slot = Math.max(0, worktree.xdebugPort - config.xdebugBasePort - 1);
  const result: Record<string, number> = {};
  let i = 0;
  for (const name of ports) {
    if (name === 'XDEBUG_PORT') result[name] = worktree.xdebugPort;
    else result[name] = basePort + slot * portStride + i++;
  }
  return result;
}

/**
 * `docker compose` args for a worktree, given resolved absolute compose paths.
 * Worktrees run `composePath` (a self-contained per-worktree stack) plus the
 * optional `overridePath`. The main repo always uses its plain stack.
 * Absolute paths let the compose template live in the main repo's `.unmess/`
 * (shared across worktrees) while the command runs from the worktree dir.
 */
export function buildComposeArgs(
  worktree: Worktree,
  composePath: string,
  overridePath: string | undefined,
  subcommand: string,
): string {
  if (worktree.isMain) return subcommand;
  const files = overridePath ? `-f "${composePath}" -f "${overridePath}"` : `-f "${composePath}"`;
  return `-p "${composeProject(worktree)}" ${files} ${subcommand}`;
}

/** Env vars (string values) to inject when running compose for a worktree. */
export function dockerEnv(worktree: Worktree, config: UnmessConfig): Record<string, string> {
  if (worktree.isMain) return {};
  const out: Record<string, string> = {};
  for (const [name, port] of Object.entries(computeDockerPorts(worktree, config))) {
    out[name] = String(port);
  }
  return out;
}
