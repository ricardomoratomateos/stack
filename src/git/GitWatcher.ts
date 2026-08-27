import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { GitStatus } from '../types';

const execAsync = promisify(exec);

type ChangeHandler = (worktreePath: string, status: GitStatus) => void;

export const DEFAULT_STATUS: GitStatus = { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 };

export function parseStatus(porcelainOutput: string): { staged: number; unstaged: number; untracked: number; hasChanges: boolean } {
  const lines = porcelainOutput.trim().split('\n').filter(Boolean);
  const staged = lines.filter((l) => l[0] !== ' ' && l[0] !== '?').length;
  const unstaged = lines.filter((l) => l[1] !== ' ' && l[1] !== '?').length;
  const untracked = lines.filter((l) => l[0] === '?' && l[1] === '?').length;
  return { staged, unstaged, untracked, hasChanges: lines.length > 0 };
}

export function parseAheadBehind(revListOutput: string): { ahead: number; behind: number } {
  const [a, b] = revListOutput.trim().split('\t').map(Number);
  // `a` can never be undefined: String.split() always yields >= 1 element, so index 0 exists (possibly NaN, which `??` keeps)
  return { ahead: a ?? /* v8 ignore next */ 0, behind: b ?? 0 };
}

export function shouldIgnore(filename: string): boolean {
  return (
    filename.includes('node_modules') ||
    filename.includes('.git/objects') ||
    filename.includes('.git/lfs') ||
    filename.includes('.git/logs') ||
    filename.endsWith('FETCH_HEAD')
  );
}

export function isGitIndexChange(filename: string): boolean {
  return filename === '.git' || filename.startsWith('.git/index') || filename.startsWith('.git/HEAD');
}

export type FetchStatusFn = (worktreePath: string) => Promise<GitStatus>;

export async function fetchStatus(worktreePath: string): Promise<GitStatus> {
  try {
    const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: worktreePath });
    const { staged, unstaged, untracked, hasChanges } = parseStatus(statusOutput);

    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: revOutput } = await execAsync(
        'git rev-list --left-right --count HEAD...@{upstream}',
        { cwd: worktreePath },
      );
      ({ ahead, behind } = parseAheadBehind(revOutput));
    } catch {
      // no upstream or detached HEAD
    }

    return { hasChanges, staged, unstaged, untracked, ahead, behind };
  } catch {
    return DEFAULT_STATUS;
  }
}

export class GitWatcher {
  private watchers = new Map<string, fs.FSWatcher[]>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private handlers: ChangeHandler[] = [];
  private statusCache = new Map<string, GitStatus>();

  constructor(
    private readonly fetchStatusFn: FetchStatusFn = fetchStatus,
    /**
     * Injected so tests can drive the debounce without a real watcher.
     *
     * The debounce tests used to install a genuine fs.watch over a temp repo and
     * invoke the captured listener by hand — but the same listener kept
     * receiving real FSEvents, each one re-arming the timer. That made them fail
     * in both directions (a refresh too many, or the window pushed past the
     * advanced time), and only under load: `npm test` passed while
     * `npm run test:coverage` did not, because v8 instrumentation moved the
     * latency just enough. The coverage gate therefore never got evaluated.
     */
    private readonly watchFn: typeof fs.watch = fs.watch,
  ) {}

  watch(worktreePath: string): void {
    if (this.watchers.has(worktreePath)) return;

    const gitEntry = path.join(worktreePath, '.git');
    if (!fs.existsSync(gitEntry)) return;

    const fsWatchers: fs.FSWatcher[] = [];

    const wtWatcher = this.watchFn(worktreePath, { recursive: true }, (_, filename) => {
      if (!filename || shouldIgnore(filename)) return;
      // File changes: debounce 10s — git status badges don't need sub-second updates
      // Git index changes: debounce 3s — staging/committing should reflect a bit faster
      this.scheduleRefresh(worktreePath, isGitIndexChange(filename) ? 3000 : 10000);
    });
    fsWatchers.push(wtWatcher);

    const stat = fs.statSync(gitEntry);
    if (stat.isFile()) {
      const content = fs.readFileSync(gitEntry, 'utf8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match?.[1]) {
        const realGitDir = match[1].trim();
        if (fs.existsSync(realGitDir)) {
          const gitDirWatcher = this.watchFn(realGitDir, { recursive: true }, (_, filename) => {
            if (!filename || shouldIgnore(filename)) return;
            this.scheduleRefresh(worktreePath, 3000);
          });
          fsWatchers.push(gitDirWatcher);
        }
      }
    }

    this.watchers.set(worktreePath, fsWatchers);
    this.refresh(worktreePath);
  }

  unwatch(worktreePath: string): void {
    const watchers = this.watchers.get(worktreePath);
    if (watchers) {
      watchers.forEach((w) => w.close());
      this.watchers.delete(worktreePath);
    }
    const timer = this.debounceTimers.get(worktreePath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(worktreePath);
    }
    this.statusCache.delete(worktreePath);
  }

  onChange(handler: ChangeHandler): void {
    this.handlers.push(handler);
  }

  /** Synchronous cache read — never blocks the event loop. */
  getStatus(worktreePath: string): GitStatus {
    return this.statusCache.get(worktreePath) ?? DEFAULT_STATUS;
  }

  dispose(): void {
    for (const watchers of this.watchers.values()) watchers.forEach((w) => w.close());
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.debounceTimers.clear();
    this.statusCache.clear();
  }

  private scheduleRefresh(worktreePath: string, delay: number): void {
    const existing = this.debounceTimers.get(worktreePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(worktreePath);
      this.refresh(worktreePath);
    }, delay);
    this.debounceTimers.set(worktreePath, timer);
  }

  private refresh(worktreePath: string): void {
    this.fetchStatusFn(worktreePath).then((status) => {
      this.statusCache.set(worktreePath, status);
      for (const handler of this.handlers) handler(worktreePath, status);
    }).catch(() => {});
  }
}
