export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
}

export interface IProcessRunner {
  /** Resolves with trimmed stdout; rejects on non-zero exit. */
  exec(cmd: string, options?: ExecOptions): Promise<string>;
}

/**
 * Runs a program with an argument array and NO shell in between.
 *
 * The one to reach for whenever a value that came from outside — a branch name,
 * a path, a file an agent created — has to reach a command. With `exec(string)`
 * such a value is shell text, and inside the double quotes it used to sit in,
 * `$(…)` and backticks still run.
 */
export interface IFileRunner {
  /** Resolves with trimmed stdout; rejects on non-zero exit. */
  execFile(file: string, args: readonly string[], options?: ExecOptions): Promise<string>;
}
