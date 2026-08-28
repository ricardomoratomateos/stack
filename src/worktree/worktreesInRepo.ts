import * as path from 'node:path';
import type { Worktree } from '../types';

/**
 * The worktrees belonging to one repository.
 *
 * The worktree store is global to the extension, shared by every window it runs
 * in, so anything that answers "what is in front of the user" has to filter it.
 * Shared rather than written twice: the application service needs it for the
 * sidebar, and extension.ts needs it before the service exists, to hand the tab
 * and breakpoint managers a list they can attribute open files against.
 *
 * No repository means no worktrees, deliberately. Returning everything would put
 * a window with nothing git-shaped open in charge of every project the extension
 * has ever seen, which is the failure this exists to prevent rather than a safe
 * fallback from it.
 */
export function worktreesInRepo<T extends Pick<Worktree, 'repoRoot'>>(
  worktrees: readonly T[],
  repoRoot: string | undefined,
): T[] {
  if (!repoRoot) return [];
  const wanted = canonicalPath(repoRoot);
  return worktrees.filter((w) => canonicalPath(w.repoRoot) === wanted);
}

/**
 * Comparable form of a path. Exported because every path comparison in this
 * codebase needs the same one.
 *
 * normalize() alone is not enough: it keeps a trailing separator, so "/repo/"
 * and "/repo" compare unequal — and these paths come from three sources that
 * disagree about it (git's output, the workspace folder list, and a hand-written
 * config file), for a comparison whose failure mode is a window silently
 * showing nothing.
 */
export function canonicalPath(p: string): string {
  const normalized = path.normalize(p);
  return normalized.length > 1 && normalized.endsWith(path.sep)
    ? normalized.slice(0, -1)
    : normalized;
}
