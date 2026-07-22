export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
}

export interface IProcessRunner {
  /** Resolves with trimmed stdout; rejects on non-zero exit. */
  exec(cmd: string, options?: ExecOptions): Promise<string>;
}
