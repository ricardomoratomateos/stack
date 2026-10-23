/**
 * The environment for every git command Stack runs.
 *
 * `git status` and `git diff` refresh the index as a side effect, and take
 * `.git/index.lock` to write it. Stack runs them in the background on every
 * worktree — and its own watcher saw that index write and ran status again — so
 * the lock was held every few seconds, and the user's own `git commit` or
 * `checkout` failed with "index.lock: File exists". GIT_OPTIONAL_LOCKS=0 makes
 * git skip those optional writes; locks a command really needs are still
 * taken. VS Code's own git extension runs with the same setting.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
}
