import * as fs from 'node:fs';
import * as path from 'node:path';

/** A path the code browser may not read. */
export class PathRefused extends Error {}

/** What a task's code browser may read. */
export interface ReadScope {
  /** The task's worktree: everything under it. */
  root: string;
  /**
   * Read-only places outside the worktree that "go to definition" legitimately lands in: the main checkout's
   * dependencies (a worktree's `node_modules` is usually a symlink to them) and a language server's stubs.
   */
  extras?: readonly string[];
}

const real = (p: string): string | undefined => {
  try { return fs.realpathSync(p); } catch { return undefined; }
};

const within = (dir: string, p: string): boolean => p === dir || p.startsWith(dir + path.sep);

/**
 * The real path of `p` when the scope allows reading it. Symlinks are resolved first, so a link that points
 * out of the worktree is judged by where it leads, not by where it sits.
 */
export function resolveReadable(scope: ReadScope, p: unknown): string {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new PathRefused('An absolute path is required.');
  const target = real(p);
  if (!target) throw new PathRefused('No such file.');
  const root = real(scope.root);
  if (root && within(root, target)) return target;
  for (const extra of scope.extras ?? []) {
    const dir = real(extra);
    if (dir && within(dir, target)) return target;
  }
  throw new PathRefused('Outside the task\'s worktree.');
}

/** Like {@link resolveReadable}, for a path that must be inside the worktree itself (listing, linting, navigation). */
export function resolveInWorktree(scope: ReadScope, p: unknown): string {
  return resolveReadable({ root: scope.root }, p);
}

/**
 * The dependency directories of the main checkout a worktree's code refers to: `vendor/` and every
 * `node_modules` reachable from the symlinks the worktree has (so only what the worktree already points at).
 */
export function dependencyRoots(worktree: string, repoRoot: string): string[] {
  const out = new Set<string>();
  const repo = real(repoRoot);
  if (!repo) return [];
  const vendor = real(path.join(repo, 'vendor'));
  if (vendor) out.add(vendor);
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name === 'node_modules' || e.name === 'vendor') {
        const target = real(full);
        // Only a link that leads into the main checkout: anything else stays unreadable.
        if (target && e.isSymbolicLink() && within(repo, target)) out.add(target);
        continue;
      }
      if (e.isDirectory() && depth < 3) visit(full, depth + 1);
    }
  };
  visit(worktree, 0);
  return [...out];
}
