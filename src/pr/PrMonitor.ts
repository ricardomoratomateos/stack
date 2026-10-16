import { exec } from 'node:child_process';
import { PrStatus } from '../types';
import type { ExecOptions, IProcessRunner } from '../ports/IProcessRunner';

interface PollEntry {
  branch: string;
  worktreeId: string;
  callback: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const defaultRunner: IProcessRunner = {
  exec(cmd: string, options?: ExecOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        cmd,
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

  constructor(private readonly runner: IProcessRunner = defaultRunner) {}

  startPolling(branch: string, worktreeId: string, callback: () => void): void {
    const running = this.polls.get(worktreeId);
    // Same branch, already polling: keep the schedule, take the new callback.
    // Every window load re-registers every worktree, and restarting would put
    // a `gh` call per worktree behind each one for an answer we already have.
    if (running?.branch === branch) {
      running.callback = callback;
      return;
    }
    // A different branch is a different question, and the old answer is not
    // one to keep showing for it.
    this.stopPolling(worktreeId);

    const entry: PollEntry = { branch, worktreeId, callback, timer: undefined };
    this.polls.set(worktreeId, entry);

    const poll = () => {
      this.fetchPrStatus(branch).then((status) => {
        // The entry is this poll's generation token. Stopped or restarted
        // while `gh` was running, the answer is for a poll nobody wants: it
        // used to land anyway — re-populating a cache stopPolling had just
        // cleared, and rescheduling itself onto whatever entry was current,
        // which left two chains running per restart, neither of them stoppable.
        if (this.polls.get(worktreeId) !== entry) return;
        const previous = this.cache.get(worktreeId);
        this.cache.set(worktreeId, status);
        // Fire callback if status changed
        if (JSON.stringify(previous) !== JSON.stringify(status)) {
          entry.callback();
        }
        entry.timer = setTimeout(poll, POLL_INTERVAL_MS);
      });
    };

    // Run immediately, then on interval
    poll();
  }

  getStatus(worktreeId: string): PrStatus | undefined {
    return this.cache.get(worktreeId);
  }

  /** Stops the poll and forgets its answer — a stopped worktree shows no PR. */
  stopPolling(worktreeId: string): void {
    this.cancel(worktreeId);
    this.cache.delete(worktreeId);
  }

  private cancel(worktreeId: string): void {
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

  private fetchPrStatus(branch: string): Promise<PrStatus> {
    return this.runner.exec(
      `gh pr list --head "${branch}" --json number,state,url`,
      { timeout: 15000 },
    ).then(
      (stdout) => parsePrListOutput(stdout),
      () => null,
    );
  }
}
