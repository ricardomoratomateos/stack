import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where the docker CLI lives on machines where VS Code was launched from the
 * Dock rather than a shell — its PATH is then launchd's, which has none of these.
 * Homebrew and Docker Desktop's symlink are the classic two; Docker Desktop has
 * since moved to ~/.docker/bin when it is installed without admin rights, and
 * OrbStack and Rancher Desktop each ship their own bin dir. Missing any of them
 * made docker "not found" for exactly the people whose docker works fine in
 * their terminal.
 */
export function dockerSearchPath(base = process.env['PATH'] ?? '', home = os.homedir()): string {
  const extra = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.docker', 'bin'),
    path.join(home, '.orbstack', 'bin'),
    path.join(home, '.rd', 'bin'),
  ];
  return [base, ...extra].filter(Boolean).join(path.delimiter);
}

export interface DockerRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Kill the process after this long; a wedged daemon otherwise hangs the call forever. */
  timeoutMs: number;
  /** Every chunk of stdout/stderr as it arrives, for a live log. */
  onOutput?: (chunk: string) => void;
}

export interface DockerRunResult {
  /** Exit code; null when the process never ran or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The CLI could not be started at all (not on PATH). */
  notFound?: boolean;
}

/**
 * Runs the docker CLI with an argv array and resolves — never rejects — with
 * everything the caller needs to explain a failure.
 *
 * An argv rather than a shell string: paths with spaces or quotes in them
 * (worktree folders are named after branches) no longer need escaping, and
 * there is no shell to inject into. Resolving instead of rejecting is what
 * lets `up` report compose's own stderr rather than "Command failed".
 */
export interface IDockerRunner {
  run(args: string[], options: DockerRunOptions): Promise<DockerRunResult>;
}

/** Grace period between SIGTERM and SIGKILL when a call times out. */
const KILL_GRACE_MS = 2_000;

export function createDockerRunner(bin = 'docker'): IDockerRunner {
  return {
    run(args, options) {
      return new Promise((resolve) => {
        const searchPath = dockerSearchPath();
        // PATH is set on the child env, which is also what Node resolves the
        // binary against — so the extra dirs reach the lookup, not just compose.
        // COMPOSE_ANSI keeps colour codes out of the output channel and the
        // error text, both of which are plain text.
        const child = spawn(bin, args, {
          cwd: options.cwd,
          env: { ...process.env, PATH: searchPath, COMPOSE_ANSI: 'never', ...options.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let killer: NodeJS.Timeout | undefined;
        const finish = (result: DockerRunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        }, options.timeoutMs);

        child.stdout.on('data', (b: Buffer) => { const s = b.toString(); stdout += s; options.onOutput?.(s); });
        child.stderr.on('data', (b: Buffer) => { const s = b.toString(); stderr += s; options.onOutput?.(s); });
        child.on('error', (err: NodeJS.ErrnoException) => {
          finish({
            code: null,
            stdout,
            stderr: stderr || err.message,
            timedOut,
            notFound: err.code === 'ENOENT',
          });
        });
        child.on('close', (code) => finish({ code: timedOut ? null : code, stdout, stderr, timedOut }));
      });
    },
  };
}

/**
 * The few lines of compose's stderr that say what went wrong.
 *
 * Compose writes its progress ("Container x  Started") to stderr too, so the
 * raw tail of a failed `up` is mostly noise; the line that matters is the
 * "Error response from daemon: … port is already allocated" one.
 */
export function failureSummary(stderr: string, maxLines = 3): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorish = lines.filter((l) => /error|failed|denied|not found|no such|invalid|already|unable|cannot|refused/i.test(l));
  const picked = (errorish.length > 0 ? errorish : lines).slice(-maxLines).join(' · ');
  return picked.length > 400 ? `${picked.slice(0, 397)}…` : picked;
}
