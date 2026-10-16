import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitWorktreePath } from '../ports/IGitPort';
import type { Worktree } from '../types';
import { canonicalPath } from './worktreesInRepo';

/** The two filesystem questions the missing check asks, injectable for tests. */
export interface PathProbe {
  /** fs.realpathSync: throws when the path does not exist. */
  realpath(p: string): string;
  /**
   * True only when the path is positively absent. A permission error, a stale
   * NFS handle or anything else that is not ENOENT/ENOTDIR answers false: "I
   * could not look" must never be read as "it is not there".
   */
  isGone(p: string): boolean;
}

export const nodePathProbe: PathProbe = {
  realpath: (p) => fs.realpathSync(p),
  isGone: (p) => {
    try {
      fs.lstatSync(p);
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR';
    }
  },
};

/**
 * realpath for a path that may no longer exist: resolve the deepest ancestor
 * that does, then put the rest back.
 *
 * Both sides of the comparison need this. The worktree being judged is gone by
 * definition, and git keeps listing a deleted worktree until it is pruned — yet
 * the paths still have to be compared through symlinks, because they come from
 * different places: git prints `/private/var/...` for a worktree the store
 * recorded as `/var/...` (macOS's tmpdir), and a repo opened through a symlinked
 * folder is stored under the link.
 */
export function resolveReal(p: string, probe: PathProbe = nodePathProbe): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return canonicalPath(path.join(probe.realpath(head), ...tail));
    } catch {
      const parent = path.dirname(head);
      // The filesystem root itself did not resolve — nothing left to anchor to.
      if (parent === head) return canonicalPath(path.resolve(p));
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * The store entries of one repository whose worktree is gone — flagged for the
 * user, never removed.
 *
 * An earlier version of reconcile pruned the store against `git worktree list`
 * and deleted worktrees that were perfectly alive: the store is shared by every
 * repository the extension has seen, the parsed list drops any worktree with a
 * detached HEAD (every rebase in progress), and paths were compared as strings
 * across symlinks and trailing slashes. So this asks for every guard at once,
 * and a doubt on any of them answers "not missing":
 *
 *  - git answered at all (`undefined` is a failure, not an empty repo);
 *  - its answer is about this repository: the main worktree is in it;
 *  - the entry is not in it, by realpath, detached and bare blocks included —
 *    except a block git itself marks `prunable`, which is git saying the
 *    directory is gone;
 *  - and the directory is positively absent from disk.
 *
 * `candidates` must already be scoped to `repoRoot`; the main checkout is never
 * reported.
 */
export function findMissingWorktrees(
  repoRoot: string,
  candidates: readonly Worktree[],
  gitPaths: readonly GitWorktreePath[] | undefined,
  probe: PathProbe = nodePathProbe,
): Worktree[] {
  if (!gitPaths) return [];
  const root = resolveReal(repoRoot, probe);
  const listed = gitPaths.map((g) => ({ real: resolveReal(g.path, probe), prunable: g.prunable }));
  if (!listed.some((g) => g.real === root)) return [];
  const alive = new Set(listed.filter((g) => !g.prunable).map((g) => g.real));
  return candidates.filter((wt) => {
    const real = resolveReal(wt.path, probe);
    return real !== root && !alive.has(real) && probe.isGone(wt.path);
  });
}
