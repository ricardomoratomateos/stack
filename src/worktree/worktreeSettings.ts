/**
 * The `.vscode/settings.json` Stack writes into a new worktree, or undefined
 * when it has nothing to say.
 *
 * Every worktree is a workspace folder of its own, so a dependency directory
 * is watched, listed and indexed once per worktree — ten worktrees of a PHP
 * app is ten copies of vendor/ for the file watcher and intelephense. The
 * excludes are there for that, and only for the ecosystems the worktree
 * actually has: they used to be written whole into every worktree, so a Go
 * repository got intelephense settings and a `vendor` exclude it never asked
 * for — and an untracked file it had not had before.
 *
 * `has` answers for a path relative to the worktree root. The manifest is what
 * is looked for, not the directory: at creation the setup script that installs
 * node_modules/ or vendor/ has not run yet.
 */
export function worktreeSettings(has: (relative: string) => boolean): Record<string, unknown> | undefined {
  const node = has('package.json');
  const php = has('composer.json');
  if (!node && !php) return undefined;

  const watcher: Record<string, true> = {};
  const hidden: Record<string, true> = {};
  if (node) {
    watcher['**/node_modules/**'] = true;
    hidden['**/node_modules'] = true;
  }
  if (php) {
    watcher['**/vendor/**'] = true;
    // Symfony's cache: rewritten on every request, worth nothing to a watcher.
    watcher['**/var/cache/**'] = true;
    hidden['**/vendor'] = true;
  }
  return {
    'files.watcherExclude': watcher,
    'files.exclude': hidden,
    ...(php ? { 'intelephense.files.exclude': Object.keys(watcher) } : {}),
  };
}
