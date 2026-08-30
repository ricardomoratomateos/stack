import * as path from 'node:path';

/**
 * First workspace folder that is a git repository's main checkout.
 *
 * `.git` must be a *directory*: in a linked worktree it is a file pointing back
 * at the real one, and a worktree opened as its own folder is not the root we
 * want to hang worktrees off.
 *
 * Shared rather than duplicated because two callers need it at different times —
 * the application service on every reconcile, and ConfigManager before the
 * service exists, to find the repository whose `.foreman/config.json` it should
 * be reading. Two copies of this rule would be two chances to disagree about
 * what "the repo" means.
 */
export function findRepoRoot(
  folders: readonly string[],
  isDirectory: (p: string) => boolean,
): string | undefined {
  for (const folder of folders) {
    if (isDirectory(path.join(folder, '.git'))) return folder;
  }
  return undefined;
}
