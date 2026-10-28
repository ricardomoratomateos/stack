import { createHash } from 'node:crypto';
import { Worktree } from '../types';
import { canonicalPath } from './worktreesInRepo';

/**
 * Stable id for a repository's control session — the standing agent that
 * manages every task via the Stack MCP tools, pinned above the task list.
 *
 * Fixed per repo root rather than random: tmux session names are global on
 * the machine, and the whole point of this session is that a window reload
 * reattaches to the same one instead of spawning a new agent beside it.
 */
export function controlSessionId(repoRoot: string): string {
  const hash = createHash('sha1').update(canonicalPath(repoRoot)).digest('hex').slice(0, 12);
  return `control-${hash}`;
}

/** The control session's Worktree-shaped descriptor — never added to the store, never a real git worktree. */
export function buildControlSession(repoRoot: string): Worktree {
  return {
    id: controlSessionId(repoRoot),
    branch: 'manager',
    path: repoRoot,
    repoRoot,
    debugPort: 0,
    dockerProjectName: '',
    createdAt: 0,
    isControl: true,
  };
}
