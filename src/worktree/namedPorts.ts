import type { StackConfig, Worktree } from '../types';
import { isEnvName } from '../shell/shellQuote';

/**
 * Per-worktree ports, keyed by the env var name from `stack.ports`. Each
 * worktree owns a contiguous block sized by `portStride`; the i-th configured
 * name gets `basePort + slot*stride + i`.
 *
 * The slot is derived from the worktree's debug port (a stable, unique value
 * already allocated per worktree), so no extra state or migration is needed.
 * DEBUG_PORT is special-cased to the worktree's own debug port so the value
 * matches the one already written to its launch.json.
 */
export function computeNamedPorts(worktree: Worktree, config: StackConfig): Record<string, number> {
  return namedPortsFor(worktree.debugPort, config);
}

/**
 * The same derivation keyed by the debug port alone, so a port can be
 * validated *before* there is a worktree to attach it to. This is the single
 * source of truth for the mapping — the allocator and the script env must
 * never drift apart on which ports a slot actually owns.
 */
export function namedPortsFor(debugPort: number, config: StackConfig): Record<string, number> {
  const { ports, basePort, portStride } = config;
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
 * the debug port itself, even when `stack.ports` is empty — the debugger's
 * listener binds it too, and it collides just as happily.
 */
export function portBlockFor(debugPort: number, config: StackConfig): number[] {
  const block = new Set<number>([debugPort]);
  for (const port of Object.values(namedPortsFor(debugPort, config))) block.add(port);
  return [...block];
}

/**
 * The named ports as env vars (string values) for a worktree's setup and
 * teardown scripts. Empty for the main checkout, which runs on its own ports.
 *
 * Names come from `stack.ports` and are typed into a terminal as `NAME=value`.
 * One that is not an identifier is not an assignment but a command —
 * `A;curl x|sh` — so it is dropped here, where every consumer gets the same
 * answer. No shell could have exported it.
 */
export function portEnv(worktree: Worktree, config: StackConfig): Record<string, string> {
  if (worktree.isMain) return {};
  const out: Record<string, string> = {};
  for (const [name, port] of Object.entries(computeNamedPorts(worktree, config))) {
    if (!isEnvName(name)) continue;
    out[name] = String(port);
  }
  return out;
}
