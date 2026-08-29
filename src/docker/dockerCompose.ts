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
 * The slot is derived from the worktree's debug port (a stable, unique value
 * already allocated per worktree), so no extra state or migration is needed.
 * DEBUG_PORT is special-cased to the worktree's own debug port so the value
 * matches the one already written to its launch.json.
 */
export function computeDockerPorts(worktree: Worktree, config: UnmessConfig): Record<string, number> {
  return dockerPortsFor(worktree.debugPort, config);
}

/**
 * The same derivation keyed by the debug port alone, so a port can be
 * validated *before* there is a worktree to attach it to. This is the single
 * source of truth for the mapping — the allocator and the compose env must
 * never drift apart on which ports a slot actually owns.
 */
export function dockerPortsFor(debugPort: number, config: UnmessConfig): Record<string, number> {
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
 * the debug port itself, even when `unmess.docker.ports` is empty — VSCode's
 * debug listener binds it too, and it collides just as happily.
 */
export function portBlockFor(debugPort: number, config: UnmessConfig): number[] {
  const block = new Set<number>([debugPort]);
  for (const port of Object.values(dockerPortsFor(debugPort, config))) block.add(port);
  return [...block];
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
