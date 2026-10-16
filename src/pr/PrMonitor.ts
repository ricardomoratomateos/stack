import { execFile } from 'node:child_process';
import { PrStatus } from '../types';
import type { ExecOptions, IFileRunner } from '../ports/IProcessRunner';

interface PollEntry {
  branch: string;
  worktreeId: string;
  cwd: string;
  callback: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// No shell: the branch is an argv entry. It used to be pasted into a
// `gh pr list --head "<branch>"` string, where a branch named `x$(…)` — a valid
// git ref — ran its payload every five minutes.
export const defaultRunner: IFileRunner = {
  execFile(file: string, args: readonly string[], options?: ExecOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          timeout: options?.timeout,
        },
        (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout.trim());
        },
      );
    });
  },
};

export function parsePrListOutput(stdout: string): PrStatus {
  if (!stdout.trim()) return null;
  try {
    const prs = JSON.parse(stdout) as { number: number; state: string; url: string }[];
    if (!prs.length) return null;
    const pr = prs[0];
    return {
      number: pr.number,
      state: pr.state as 'OPEN' | 'CLOSED' | 'MERGED',
      url: pr.url,
    };
  } catch {
    return null;
  }
}

export class PrMonitor {
  private cache = new Map<string, PrStatus | undefined>();
  private polls = new Map<string, PollEntry>();

  constructor(private readonly runner: IFileRunner = defaultRunner) {}

  /**
   * `cwd` is the worktree (or repo) the branch lives in, and it is required:
   * gh finds the GitHub repository to ask from the git remote of the directory
   * it runs in. Without one it inherited the extension host's cwd — `/` when
   * VS Code was launched from the Dock — and every lookup failed quietly into
   * "no PR".
   */
  startPolling(branch: string, worktreeId: string, cwd: string, callback: () => void): void {
    // Stop any existing poll for this worktree
    this.stopPolling(worktreeId);

    const entry: PollEntry = { branch, worktreeId, cwd, callback, timer: undefined };
    this.polls.set(worktreeId, entry);

    const poll = () => {
      this.fetchPrStatus(branch, cwd).then((status) => {
        const previous = this.cache.get(worktreeId);
        this.cache.set(worktreeId, status);
        // Fire callback if status changed
        if (JSON.stringify(previous) !== JSON.stringify(status)) {
          callback();
        }
        // Schedule next poll
        const current = this.polls.get(worktreeId);
        if (current) {
          current.timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      });
    };

    // Run immediately, then on interval
    poll();
  }

  getStatus(worktreeId: string): PrStatus | undefined {
    return this.cache.get(worktreeId);
  }

  stopPolling(worktreeId: string): void {
    const entry = this.polls.get(worktreeId);
    if (entry?.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    this.polls.delete(worktreeId);
  }

  dispose(): void {
    for (const [worktreeId] of this.polls) {
      this.stopPolling(worktreeId);
    }
    this.cache.clear();
  }

  private fetchPrStatus(branch: string, cwd: string): Promise<PrStatus> {
    return this.runner.execFile(
      'gh',
      ['pr', 'list', '--head', branch, '--json', 'number,state,url'],
      { cwd, timeout: 15000 },
    ).then(
      (stdout) => parsePrListOutput(stdout),
      () => null,
    );
  }
}
