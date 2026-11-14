import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { GitStatus } from '../types';
import { gitEnv } from './gitEnv';

const execAsync = promisify(exec);

type ChangeHandler = (worktreePath: string, status: GitStatus) => void;

export const DEFAULT_STATUS: GitStatus = { hasChanges: false, staged: 0, unstaged: 0, untracked: 0 };

export function parseStatus(porcelainOutput: string): { staged: number; unstaged: number; untracked: number; hasChanges: boolean } {
  // Not trimmed: the first line's leading space is its status (' M' is unstaged, not staged).
  const lines = porcelainOutput.split('\n').filter(Boolean);
  const staged = lines.filter((l) => l[0] !== ' ' && l[0] !== '?').length;
  const unstaged = lines.filter((l) => l[1] !== ' ' && l[1] !== '?').length;
  const untracked = lines.filter((l) => l[0] === '?' && l[1] === '?').length;
  return { staged, unstaged, untracked, hasChanges: lines.length > 0 };
}

export function shouldIgnore(filename: string): boolean {
  return (
    filename.includes('node_modules') ||
    filename.includes('.git/objects') ||
    filename.includes('.git/lfs') ||
    filename.includes('.git/logs') ||
    // The main checkout's .git holds every linked worktree's own index and
    // HEAD under worktrees/<name>/. Staging in a worktree is that worktree's
    // news (its own gitdir watcher sees it), not a reason to re-read main.
    filename.startsWith('.git/worktrees/') ||
    filename.endsWith('FETCH_HEAD')
  );
}

/** Debounce for plain file edits — git status badges don't need sub-second updates. */
export const FILE_DEBOUNCE_MS = 10_000;
/** Debounce for index/HEAD changes — staging and committing should show a bit faster. */
export const INDEX_DEBOUNCE_MS = 3_000;
/**
 * Longest a refresh may be pushed back by a stream of events.
 *
 * The debounce is trailing-only, so anything that writes more often than every
 * ten seconds — a dev server's build output, a log, an agent editing file after
 * file — re-armed it forever and the badge never updated while the worktree was
 * busy, which is exactly when it is worth looking at.
 */
export const MAX_DEBOUNCE_WAIT_MS = 30_000;

export function isGitIndexChange(filename: string): boolean {
  return filename === '.git' || filename.startsWith('.git/index') || filename.startsWith('.git/HEAD');
}

export type FetchStatusFn = (worktreePath: string, baseBranch?: string) => Promise<GitStatus>;

/**
 * Where the branch left its base: the merge base of HEAD and `origin/<base>`,
 * else the local `<base>`. The remote ref first, because the local one is
 * usually stale — nobody checks out develop just to pull it.
 *
 * No fetch: this runs on a filesystem watch, and a network round trip behind
 * every save is not something to inflict on anyone. Undefined when neither ref
 * resolves here.
 */
export async function mergeBase(
  worktreePath: string,
  baseBranch: string,
  run: (cmd: string) => Promise<string> = async (cmd) =>
    (await execAsync(cmd, { cwd: worktreePath, env: gitEnv() })).stdout,
): Promise<string | undefined> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try {
      const sha = (await run(`git merge-base HEAD ${quoteRef(ref)}`)).trim();
      if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
    } catch {
      // Ref does not exist here — try the local branch, then give up.
    }
  }
  return undefined;
}

/** Sums `git diff --numstat`; binary files print "-" for both counts and add nothing. */
export function parseNumstat(output: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of output.split('\n')) {
    const [a, r] = line.split('\t');
    // `r` is absent on a blank line; test() reads that as the text "undefined", which is no number.
    if (/^\d+$/.test(a) && /^\d+$/.test(r)) {
      added += Number(a);
      removed += Number(r);
    }
  }
  return { added, removed };
}

/**
 * Lines added and removed since the branch left its base, uncommitted tracked
 * changes included — the "+40 −9" on a row. Measured from the merge base rather
 * than the base's tip, so commits the base gained since do not show up as work
 * this branch deleted. Without a base (the main checkout, or a base that does
 * not resolve) it is the working tree against HEAD. Untracked files are not
 * counted: git has no diff for them.
 *
 * `workingTree` false (a clean tree) compares commits only, `<merge base>
 * HEAD`: a diff against the working tree refreshes the index, even with
 * optional locks off, and a clean tree has nothing there to count.
 *
 * Undefined when there is nothing to count or git could not say; the sidebar
 * falls back to the number of files then.
 */
export async function diffLines(
  worktreePath: string,
  baseBranch: string | undefined,
  workingTree = true,
  run: (cmd: string) => Promise<string> = async (cmd) =>
    (await execAsync(cmd, { cwd: worktreePath, env: gitEnv(), maxBuffer: 16 * 1024 * 1024 })).stdout,
): Promise<{ added: number; removed: number } | undefined> {
  try {
    const from = (baseBranch ? await mergeBase(worktreePath, baseBranch, run) : undefined) ?? 'HEAD';
    if (!workingTree && from === 'HEAD') return undefined;
    const lines = parseNumstat(await run(`git diff --numstat ${from}${workingTree ? '' : ' HEAD'}`));
    return lines.added + lines.removed > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refs reach here from a config file and a branch name, so they are quoted.
 *
 * Rejected outright rather than escaped when they contain anything git would not
 * accept in a ref anyway: the value ends up in a shell command, and "escape it
 * correctly" is a worse bet than "do not build the command at all".
 */
function quoteRef(ref: string): string {
  if (!/^[\w./-]+$/.test(ref)) throw new Error(`refusing to use "${ref}" as a git ref`);
  return `"${ref}"`;
}

export async function fetchStatus(worktreePath: string, baseBranch?: string): Promise<GitStatus> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: worktreePath, env: gitEnv() });
    const { staged, unstaged, untracked, hasChanges } = parseStatus(stdout);
    // A clean tree has nothing to count, unless it carries commits beyond a base.
    const lines = hasChanges || baseBranch ? await diffLines(worktreePath, baseBranch, hasChanges) : undefined;
    return { hasChanges, staged, unstaged, untracked, ...(lines ? { lines } : {}) };
  } catch {
    return DEFAULT_STATUS;
  }
}

export class GitWatcher {
  private watchers = new Map<string, fs.FSWatcher[]>();
  /** Pending refresh per path, and the latest it may fire (see MAX_DEBOUNCE_WAIT_MS). */
  private debounceTimers = new Map<string, { timer: NodeJS.Timeout; deadline: number }>();
  private handlers: ChangeHandler[] = [];
  private statusCache = new Map<string, GitStatus>();
  /**
   * Per-path token for in-flight reads. unwatch() drops it, so a status that
   * was being computed when the worktree stopped being watched is thrown away
   * instead of re-populating the cache it just cleared — the entry otherwise
   * outlived the worktree for the life of the window.
   */
  private readTokens = new Map<string, object>();

  /**
   * Base branch each worktree's lines are counted from, by path.
   *
   * Held here rather than passed to refresh() because refresh is also reached
   * from a debounced watcher callback that has nothing but the path.
   */
  private bases = new Map<string, string>();

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

  /**
   * @param baseBranch Branch the worktree's lines are counted from. Omit for
   * the main worktree, or when the worktree is itself on the base: its lines
   * are then its uncommitted changes.
   */
  watch(worktreePath: string, baseBranch?: string): void {
    // Recorded before the early return: an already-watched worktree may have
    // been reconciled with a different base since, and dropping it here would
    // leave its lines counted from the old one until the next reload.
    if (baseBranch) this.bases.set(worktreePath, baseBranch);
    else this.bases.delete(worktreePath);

    if (this.watchers.has(worktreePath)) return;

    const gitEntry = path.join(worktreePath, '.git');
    if (!fs.existsSync(gitEntry)) return;

    const fsWatchers: fs.FSWatcher[] = [];
    try {
      const wtWatcher = this.watchFn(worktreePath, { recursive: true }, (_, filename) => {
        if (!filename || shouldIgnore(filename)) return;
        if (this.belongsToNestedWorktree(worktreePath, filename)) return;
        this.scheduleRefresh(worktreePath, isGitIndexChange(filename) ? INDEX_DEBOUNCE_MS : FILE_DEBOUNCE_MS);
      });
      fsWatchers.push(this.guard(worktreePath, wtWatcher));

      const stat = fs.statSync(gitEntry);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitEntry, 'utf8');
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match?.[1]) {
          const realGitDir = match[1].trim();
          if (fs.existsSync(realGitDir)) {
            const gitDirWatcher = this.watchFn(realGitDir, { recursive: true }, (_, filename) => {
              if (!filename || shouldIgnore(filename)) return;
              this.scheduleRefresh(worktreePath, INDEX_DEBOUNCE_MS);
            });
            fsWatchers.push(this.guard(worktreePath, gitDirWatcher));
          }
        }
      }
    } catch (e) {
      // EMFILE, ENOSPC (inotify's watch limit), a directory vanishing between
      // the existsSync and the watch… The caller is a loop over every worktree,
      // and the throw used to abort it: one unwatchable worktree left all the
      // ones after it unwatched and unpolled. Skip this one, say why.
      for (const w of fsWatchers) w.close();
      console.error(`[stack] cannot watch ${worktreePath}; its git status will not update:`, e);
      return;
    }

    this.watchers.set(worktreePath, fsWatchers);
    this.refresh(worktreePath);
  }

  /**
   * An FSWatcher with no 'error' listener throws its error out of the event
   * loop — a watched directory deleted from under it is enough. On error the
   * worktree's watchers are closed and forgotten, so a later watch() can retry.
   */
  private guard(worktreePath: string, watcher: fs.FSWatcher): fs.FSWatcher {
    watcher.on('error', (e) => {
      console.error(`[stack] watcher for ${worktreePath} failed; no longer watching it:`, e);
      const owned = this.watchers.get(worktreePath);
      if (!owned?.includes(watcher)) return;
      for (const w of owned) w.close();
      this.watchers.delete(worktreePath);
    });
    return watcher;
  }

  /**
   * Whether a change seen by `root`'s recursive watcher is inside another
   * watched worktree nested under it.
   *
   * Worktrees usually live inside the main checkout (`.worktrees/`, `zer/`), so
   * its watcher saw every save in every worktree and re-ran `git status` on
   * main for each — three git processes for a change main's status cannot
   * reflect, since git ignores nested worktrees. The nested worktree's own
   * watcher reports it.
   */
  private belongsToNestedWorktree(root: string, filename: string): boolean {
    if (this.watchers.size < 2) return false;
    const full = path.join(root, filename);
    for (const other of this.watchers.keys()) {
      if (other !== root && full.startsWith(other + path.sep) && other.startsWith(root + path.sep)) return true;
    }
    return false;
  }

  unwatch(worktreePath: string): void {
    const watchers = this.watchers.get(worktreePath);
    if (watchers) {
      watchers.forEach((w) => w.close());
      this.watchers.delete(worktreePath);
    }
    const pending = this.debounceTimers.get(worktreePath);
    if (pending) {
      clearTimeout(pending.timer);
      this.debounceTimers.delete(worktreePath);
    }
    this.statusCache.delete(worktreePath);
    this.bases.delete(worktreePath);
    this.readTokens.delete(worktreePath);
  }

  /**
   * Subscribe to status changes. Returns the way back out: the sidebar view
   * re-subscribes every time VS Code re-resolves it, and with no way to leave,
   * each resolve added a listener that re-rendered the whole sidebar.
   */
  onChange(handler: ChangeHandler): { dispose(): void } {
    this.handlers.push(handler);
    return {
      dispose: () => {
        this.handlers = this.handlers.filter((h) => h !== handler);
      },
    };
  }

  /** Synchronous cache read — never blocks the event loop. */
  getStatus(worktreePath: string): GitStatus {
    return this.statusCache.get(worktreePath) ?? DEFAULT_STATUS;
  }

  /** Whether a status has been read for this path yet — getStatus's zeros are otherwise a placeholder. */
  hasStatus(worktreePath: string): boolean {
    return this.statusCache.has(worktreePath);
  }

  dispose(): void {
    for (const watchers of this.watchers.values()) watchers.forEach((w) => w.close());
    for (const pending of this.debounceTimers.values()) clearTimeout(pending.timer);
    this.watchers.clear();
    this.debounceTimers.clear();
    this.statusCache.clear();
    this.bases.clear();
    this.readTokens.clear();
  }

  /**
   * Trailing debounce with a ceiling: each event pushes the refresh back by
   * `delay`, but never past MAX_DEBOUNCE_WAIT_MS after the first event of the
   * burst.
   */
  private scheduleRefresh(worktreePath: string, delay: number): void {
    const now = Date.now();
    const existing = this.debounceTimers.get(worktreePath);
    if (existing) clearTimeout(existing.timer);
    const deadline = existing?.deadline ?? now + MAX_DEBOUNCE_WAIT_MS;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(worktreePath);
      this.refresh(worktreePath);
    }, Math.max(0, Math.min(delay, deadline - now)));
    this.debounceTimers.set(worktreePath, { timer, deadline });
  }

  /**
   * Recomputes now and resolves when the cache holds the answer.
   *
   * The awaitable half of refresh(), for a caller that needs the new numbers
   * now rather than on the next filesystem event (stackd's `refreshGit`).
   *
   * Handlers hear about it only when the status actually changed: each one
   * rebuilds and re-sends the whole sidebar, and most refreshes — a save that
   * leaves a file as modified as it already was — change nothing.
   */
  async refreshNow(worktreePath: string): Promise<void> {
    const token = this.readTokens.get(worktreePath) ?? {};
    this.readTokens.set(worktreePath, token);
    const status = await this.fetchStatusFn(worktreePath, this.bases.get(worktreePath)).catch(() => undefined);
    if (!status || this.readTokens.get(worktreePath) !== token) return;
    const previous = this.statusCache.get(worktreePath);
    this.statusCache.set(worktreePath, status);
    if (previous && JSON.stringify(previous) === JSON.stringify(status)) return;
    for (const handler of this.handlers) handler(worktreePath, status);
  }

  private refresh(worktreePath: string): void {
    void this.refreshNow(worktreePath);
  }
}
