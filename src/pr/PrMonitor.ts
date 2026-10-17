import { execFile } from 'node:child_process';
import type { PrCi, PrStatus } from '../types';
import type { ExecOptions, IFileRunner } from '../ports/IProcessRunner';

interface PollEntry {
  branch: string;
  worktreeId: string;
  cwd: string;
  callback: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * How often to ask. A PR that is open is the one whose checks and review move
 * while you watch, and the badge is only worth its place if it keeps up; a
 * branch with no PR, or one already merged or closed, changes rarely.
 */
export const OPEN_POLL_INTERVAL_MS = 60 * 1000;
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** What `gh pr list --json` is asked for. */
const PR_FIELDS = 'number,state,url,isDraft,reviewDecision,statusCheckRollup';

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

interface GhPr {
  number: number;
  state: string;
  url: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: GhCheck[] | null;
}

/** One entry of statusCheckRollup: a check run (Actions) or a commit status (older CI). */
interface GhCheck {
  /** CheckRun: QUEUED, IN_PROGRESS, COMPLETED, WAITING, PENDING, REQUESTED. */
  status?: string;
  /** CheckRun, once completed: SUCCESS, FAILURE, NEUTRAL, SKIPPED, CANCELLED, TIMED_OUT, … */
  conclusion?: string | null;
  /** StatusContext: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED. */
  state?: string;
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);

/**
 * The checks in one word. A failure anywhere is a failure — that is the one
 * that needs a person — then anything still running is pending, and only a
 * board with every check finished and none failed passes. Neutral and skipped
 * count as passing, as GitHub's own merge box counts them.
 */
export function summarizeChecks(checks: GhCheck[] | null | undefined): PrCi | undefined {
  if (!checks || checks.length === 0) return undefined;
  let pending = false;
  for (const check of checks) {
    const outcome = check.state ?? (check.status === 'COMPLETED' ? check.conclusion ?? '' : undefined);
    if (outcome === undefined || outcome === 'PENDING' || outcome === 'EXPECTED') pending = true;
    else if (FAILED.has(outcome)) return 'fail';
  }
  return pending ? 'pending' : 'pass';
}

/**
 * The branch's PR, from `gh pr list --state all`.
 *
 * Every PR ever opened from the branch comes back, so one is picked: an open
 * one first — that is the live conversation — else the most recent, by number,
 * which GitHub hands out in order.
 */
export function parsePrListOutput(stdout: string): PrStatus {
  if (!stdout.trim()) return null;
  try {
    const prs = JSON.parse(stdout) as GhPr[];
    if (!prs.length) return null;
    const pr = [...prs].sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number)[0];
    const ci = summarizeChecks(pr.statusCheckRollup);
    const review = pr.reviewDecision ?? '';
    return {
      number: pr.number,
      state: pr.state as 'OPEN' | 'CLOSED' | 'MERGED',
      url: pr.url,
      ...(pr.isDraft ? { isDraft: true } : {}),
      ...(REVIEW_DECISIONS.has(review) ? { reviewDecision: review as NonNullable<PrStatus>['reviewDecision'] } : {}),
      ...(ci ? { ci } : {}),
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
    const running = this.polls.get(worktreeId);
    // Same branch in the same place, already polling: keep the schedule, take
    // the new callback. Every window load re-registers every worktree, and
    // restarting would put a `gh` call per worktree behind each one for an
    // answer we already have.
    if (running?.branch === branch && running.cwd === cwd) {
      running.callback = callback;
      return;
    }
    // A different branch is a different question, and the old answer is not
    // one to keep showing for it.
    this.stopPolling(worktreeId);

    const entry: PollEntry = { branch, worktreeId, cwd, callback, timer: undefined };
    this.polls.set(worktreeId, entry);

    const poll = () => {
      this.fetchPrStatus(branch, cwd).then((status) => {
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
        entry.timer = setTimeout(poll, status?.state === 'OPEN' ? OPEN_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
      });
    };

    // Run immediately, then every minute while the PR is open, five otherwise
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

  private fetchPrStatus(branch: string, cwd: string): Promise<PrStatus> {
    return this.runner.execFile(
      'gh',
      // --state all: without it gh lists open PRs only, so a merged PR did not
      // show as merged — the badge simply vanished at the moment it mattered.
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', PR_FIELDS],
      { cwd, timeout: 15000 },
    ).then(
      (stdout) => parsePrListOutput(stdout),
      () => null,
    );
  }
}
