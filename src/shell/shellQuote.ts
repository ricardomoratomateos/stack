/**
 * Quoting for the few command lines Stack still has to hand to a shell.
 *
 * Most commands no longer go through one at all — git and gh are run with an
 * argument array (execFile), where a value is a value however strange it is.
 * What is left is text typed into a terminal (`sendText`), which by definition
 * lands in whatever shell the user runs, so it cannot be avoided there.
 *
 * Double quotes are NOT quoting for this purpose: inside them `$(…)`, `${…}`
 * and backticks still expand. A branch is a perfectly valid git ref with
 * `$(curl x|sh)` in its name, and the worktree directory is named after the
 * branch — so a path wrapped in "…" ran whatever the branch name said. Single
 * quotes are the only form where nothing is special; the one character they
 * cannot contain, `'` itself, is closed, escaped and reopened (`'\''`), which
 * reads the same in sh, bash, zsh and fish.
 */
export function shellQuote(value: string): string {
  // Left bare when it is made only of characters no shell gives a meaning to,
  // so the common case (/repo/.worktrees/feat-x) stays readable in the terminal
  // the user is watching. Anything else is quoted, whether or not it needs it.
  // `=` and `%` stay out of the bare set on purpose: zsh expands a word that
  // starts with `=` into a command path, and fish and zsh both give `%` meaning.
  if (value !== '' && /^[\w@+:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether a name can stand on the left of `NAME=value` in a command prefix.
 *
 * Env var names reach the command line from config (`stack.docker.ports`), and
 * a name is not something quoting can fix — `'A;B'=1` is not an assignment, it
 * is a command. A name that is not an identifier is dropped instead; no shell
 * could have exported it anyway.
 */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** `A='x' B='y' ` — the env prefix for one command, invalid names dropped. */
export function envPrefix(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([name]) => isEnvName(name))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(' ');
}
