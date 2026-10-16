import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  GitWatcher,
  parseStatus,
  parseAheadBehind,
  shouldIgnore,
  isGitIndexChange,
  fetchStatus,
  baseDrift,
  parseNumstat,
  diffLines,
  DEFAULT_STATUS,
  FILE_DEBOUNCE_MS,
  MAX_DEBOUNCE_WAIT_MS,
} from '../../src/git/GitWatcher';
import { EventEmitter } from 'node:events';
import type { GitStatus } from '../../src/types';

// Auto-spy on node:fs (keeps real implementations) so fs.watch calls/listeners
// can be inspected — vi.spyOn cannot patch a non-configurable ESM namespace.
vi.mock('node:fs', { spy: true });

const watchSpy = vi.mocked(fs.watch);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gitwatcher-'));
  tmpDirs.push(dir);
  return dir;
}

/** A directory whose `.git` is a plain directory — enough for `watch()` to accept it. */
function makeFakeRepo(): string {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8' });
}

function makeRealRepo(): string {
  const dir = makeTmpDir();
  git(dir, 'init --initial-branch=main');
  git(dir, 'config user.email test@foreman.local');
  git(dir, 'config user.name foreman-test');
  git(dir, 'config commit.gpgsign false');
  git(dir, 'commit --allow-empty -m init');
  return dir;
}

const STATUS_A: GitStatus = { hasChanges: true, staged: 1, unstaged: 2, untracked: 3, ahead: 4, behind: 5 };

const activeWatchers: GitWatcher[] = [];
function makeWatcher(fetchFn?: (worktreePath: string) => Promise<GitStatus>): GitWatcher {
  const w = fetchFn ? new GitWatcher(fetchFn) : new GitWatcher();
  activeWatchers.push(w);
  return w;
}

/**
 * A GitWatcher whose file watching emits ONLY what the test emits.
 *
 * These tests used to capture the listener from a real fs.watch over a temp
 * directory, then invoke it by hand — but that same listener kept receiving
 * genuine FSEvents, and each one re-armed the debounce. They failed in both
 * directions (one refresh too many, or the window pushed past the advanced
 * time) and only under load: `npm test` passed while `npm run test:coverage`
 * did not, because v8 instrumentation shifted the latency just enough. The
 * coverage gate was therefore never reached.
 */
function makeDebounceWatcher(fetchFn: (worktreePath: string) => Promise<GitStatus>) {
  const listeners: Array<(event: string, filename: string | null) => void> = [];
  const watchFn = ((_p: unknown, _o: unknown, listener: (e: string, f: string | null) => void) => {
    listeners.push(listener);
    return { close: () => {}, on: () => {} } as unknown as fs.FSWatcher;
  }) as unknown as typeof fs.watch;
  const w = new GitWatcher(fetchFn, watchFn);
  activeWatchers.push(w);
  return { w, listeners };
}

afterEach(() => {
  for (const w of activeWatchers.splice(0)) w.dispose();
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pure functions
// ---------------------------------------------------------------------------

describe('parseStatus', () => {
  it('counts staged / unstaged / untracked correctly', () => {
    const out = [
      'M  staged-only.txt', //  staged
      'MM both.txt', //          staged + unstaged
      'A  added.txt', //         staged
      ' M unstaged.txt', //      unstaged (not first line — see quirk test)
      '?? new.txt', //           untracked
      '?? other.txt', //         untracked
    ].join('\n') + '\n';
    expect(parseStatus(out)).toEqual({ staged: 3, unstaged: 2, untracked: 2, hasChanges: true });
  });

  it('returns zeros on empty output', () => {
    expect(parseStatus('')).toEqual({ staged: 0, unstaged: 0, untracked: 0, hasChanges: false });
    expect(parseStatus('\n')).toEqual({ staged: 0, unstaged: 0, untracked: 0, hasChanges: false });
  });

  it('quirk: trim() strips the leading space of the FIRST line, misclassifying a leading unstaged-only entry as staged', () => {
    // real behavior of the original code: ' M a.txt\n'.trim() → 'M a.txt'
    expect(parseStatus(' M a.txt\n')).toEqual({ staged: 1, unstaged: 0, untracked: 0, hasChanges: true });
  });
});

describe('parseAheadBehind', () => {
  it('parses "N\\tM" left-right counts', () => {
    expect(parseAheadBehind('2\t3\n')).toEqual({ ahead: 2, behind: 3 });
    expect(parseAheadBehind('0\t0')).toEqual({ ahead: 0, behind: 0 });
  });

  it('returns zeros on empty output and defaults a missing right count to 0', () => {
    expect(parseAheadBehind('')).toEqual({ ahead: 0, behind: 0 }); // Number('') === 0
    expect(parseAheadBehind('5')).toEqual({ ahead: 5, behind: 0 });
  });

  it('quirk: non-numeric tokens yield NaN (original code did not guard against this)', () => {
    expect(parseAheadBehind('foo\tbar')).toEqual({ ahead: NaN, behind: NaN });
  });
});

describe('shouldIgnore', () => {
  it('ignores node_modules, .git/objects, .git/lfs, .git/logs, FETCH_HEAD', () => {
    expect(shouldIgnore('node_modules/lodash/index.js')).toBe(true);
    expect(shouldIgnore('packages/app/node_modules/x.js')).toBe(true);
    expect(shouldIgnore('.git/objects/ab/cdef')).toBe(true);
    expect(shouldIgnore('.git/lfs/objects/x')).toBe(true);
    expect(shouldIgnore('.git/logs/HEAD')).toBe(true);
    expect(shouldIgnore('.git/FETCH_HEAD')).toBe(true);
    expect(shouldIgnore('FETCH_HEAD')).toBe(true);
  });

  it('does not ignore normal source files', () => {
    expect(shouldIgnore('src/extension.ts')).toBe(false);
    expect(shouldIgnore('.git/index')).toBe(false);
    expect(shouldIgnore('.git/HEAD')).toBe(false);
    expect(shouldIgnore('README.md')).toBe(false);
  });
});

describe('isGitIndexChange', () => {
  it('classifies .git, .git/index* and .git/HEAD* as git index changes', () => {
    expect(isGitIndexChange('.git')).toBe(true);
    expect(isGitIndexChange('.git/index')).toBe(true);
    expect(isGitIndexChange('.git/index.lock')).toBe(true);
    expect(isGitIndexChange('.git/HEAD')).toBe(true);
    expect(isGitIndexChange('.git/HEAD.lock')).toBe(true);
  });

  it('classifies everything else as a plain file change', () => {
    expect(isGitIndexChange('src/a.ts')).toBe(false);
    expect(isGitIndexChange('.gitignore')).toBe(false);
    expect(isGitIndexChange('.git/config')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchStatus — integration with real temp git repos
// ---------------------------------------------------------------------------

describe('fetchStatus (real git repos)', () => {
  it('returns all-zeros DEFAULT status when the path is not a git repo', async () => {
    const dir = makeTmpDir();
    expect(await fetchStatus(dir)).toEqual({
      hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0,
    });
  });

  it('returns zeros with hasChanges=false for a clean repo without upstream', async () => {
    const repo = makeRealRepo();
    expect(await fetchStatus(repo)).toEqual({
      hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0,
    });
  });

  it('counts staged / unstaged / untracked from a dirty repo', async () => {
    const repo = makeRealRepo();
    // tracked file we will modify (name sorts last so the trim quirk is not hit)
    fs.writeFileSync(path.join(repo, 'zzz.txt'), 'one\n');
    git(repo, 'add zzz.txt');
    git(repo, 'commit -m tracked');
    // staged
    fs.writeFileSync(path.join(repo, 'aaa.txt'), 'staged\n');
    git(repo, 'add aaa.txt');
    // unstaged modification
    fs.writeFileSync(path.join(repo, 'zzz.txt'), 'two\n');
    // untracked
    fs.writeFileSync(path.join(repo, 'mmm.txt'), 'untracked\n');

    const status = await fetchStatus(repo);
    expect(status).toEqual({
      hasChanges: true, staged: 1, unstaged: 1, untracked: 1, ahead: 0, behind: 0,
      // The staged file (1 line, new to HEAD) and the edit to zzz.txt (1 in, 1 out).
      lines: { added: 2, removed: 1 },
    });
  });

  it('computes ahead/behind against @{upstream} when one exists', async () => {
    const repo = makeRealRepo();
    git(repo, 'branch up');
    git(repo, 'branch --set-upstream-to=up main');
    git(repo, 'commit --allow-empty -m ahead-1');
    expect(await fetchStatus(repo)).toMatchObject({ ahead: 1, behind: 0 });

    git(repo, 'branch -f up HEAD');
    git(repo, 'reset --hard HEAD~1');
    expect(await fetchStatus(repo)).toMatchObject({ ahead: 0, behind: 1 });
  });

  it('falls back to ahead/behind zeros on detached HEAD', async () => {
    const repo = makeRealRepo();
    git(repo, 'branch up');
    git(repo, 'branch --set-upstream-to=up main');
    git(repo, 'checkout --detach');
    expect(await fetchStatus(repo)).toMatchObject({ ahead: 0, behind: 0 });
  });
});

// ---------------------------------------------------------------------------
// debounce (fake timers + captured fs.watch listeners)
// ---------------------------------------------------------------------------

type WatchListener = (event: string, filename: string | null) => void;

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watchSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid file events into one refresh (~10s)', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1); // immediate refresh on watch()
    const listener = listeners[0];

    listener('change', 'src/a.ts');
    listener('change', 'src/b.ts');
    listener('change', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchFn).toHaveBeenCalledTimes(1); // still debouncing
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2); // single coalesced refresh at 10s
  });

  it('resets the pending window on every event (trailing debounce)', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    const listener = listeners[0];

    listener('change', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(9000);
    listener('change', 'src/b.ts'); // resets to a fresh 10s
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('git index changes (.git, .git/index*, .git/HEAD*) refresh faster (~3s)', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    const listener = listeners[0];

    for (const name of ['.git', '.git/index', '.git/index.lock', '.git/HEAD']) {
      fetchFn.mockClear();
      listener('change', name);
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchFn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it('a git index event supersedes a pending 10s file timer with the 3s window', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    fetchFn.mockClear();
    const listener = listeners[0];

    listener('change', 'src/a.ts'); // 10s timer
    await vi.advanceTimersByTimeAsync(5000);
    listener('change', '.git/index'); // replaced with 3s timer
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchFn).toHaveBeenCalledTimes(1); // fired at t=8s, before the 10s would have
  });

  it('ignored and falsy filenames never schedule a refresh', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    fetchFn.mockClear();
    const listener = listeners[0];

    listener('change', 'node_modules/x.js');
    listener('change', '.git/objects/ab/cd');
    listener('change', '.git/FETCH_HEAD');
    listener('change', null);
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refresh notifies onChange handlers and populates the cache', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    const seen: Array<[string, GitStatus]> = [];
    w.onChange((p, s) => seen.push([p, s]));
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([[repo, STATUS_A]]);
    expect(w.getStatus(repo)).toEqual(STATUS_A);
  });

  it('a rejected fetch is swallowed: no handler call, cache untouched', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    const handler = vi.fn();
    w.onChange(handler);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).not.toHaveBeenCalled();
    expect(w.getStatus(repo)).toEqual(DEFAULT_STATUS);
  });
});

// ---------------------------------------------------------------------------
// linked worktrees (.git as a FILE with a gitdir: pointer)
// ---------------------------------------------------------------------------

describe('linked worktrees', () => {
  beforeEach(() => {
    watchSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('when .git is a FILE, parses gitdir: and also watches the real git dir (3s debounce)', async () => {
    const repo = makeRealRepo();
    const wtPath = path.join(makeTmpDir(), 'wt');
    git(repo, `worktree add ${JSON.stringify(wtPath)} -b feat`);

    const gitFile = path.join(wtPath, '.git');
    expect(fs.statSync(gitFile).isFile()).toBe(true);
    const realGitDir = fs.readFileSync(gitFile, 'utf8').match(/^gitdir:\s*(.+)$/m)![1].trim();

    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => STATUS_A);
    const w = makeWatcher(fetchFn);
    w.watch(wtPath);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1); // immediate refresh

    // one watcher on the worktree, one on the real git dir
    expect(watchSpy).toHaveBeenCalledTimes(2);
    expect(watchSpy.mock.calls[0][0]).toBe(wtPath);
    expect(watchSpy.mock.calls[1][0]).toBe(realGitDir);

    // events in the real git dir refresh with the fast 3s window
    const gitDirListener = watchSpy.mock.calls[1][2] as unknown as (e: string, f: string | null) => void;
    fetchFn.mockClear();
    gitDirListener('change', 'HEAD');
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // ignored / falsy filenames in the real git dir do nothing
    fetchFn.mockClear();
    gitDirListener('change', 'FETCH_HEAD');
    gitDirListener('change', null);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a .git file without a gitdir: line results in a single watcher', async () => {
    vi.useFakeTimers();
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, '.git'), 'not a gitdir pointer\n');
    const fetchFn = vi.fn(async () => STATUS_A);
    const w = makeWatcher(fetchFn);
    w.watch(dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSpy).toHaveBeenCalledTimes(1);
  });

  it('a gitdir: pointer to a missing directory results in a single watcher', async () => {
    vi.useFakeTimers();
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent/foreman-test-gitdir\n');
    const fetchFn = vi.fn(async () => STATUS_A);
    const w = makeWatcher(fetchFn);
    w.watch(dir);
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watchSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('watch() is idempotent, refreshes immediately, skips paths without .git', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const w = makeWatcher(fetchFn);

    // skips a path without .git entirely
    const noGit = makeTmpDir();
    w.watch(noGit);
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSpy).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();

    // first watch installs one fs watcher and refreshes immediately
    const repo = makeFakeRepo();
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSpy).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // second watch of the same path is a no-op
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    expect(watchSpy).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('unwatch() closes watchers, clears pending timer and cached status', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const w = makeWatcher(fetchFn);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.getStatus(repo)).toEqual(STATUS_A);

    const fsWatcher = watchSpy.mock.results[0].value as fs.FSWatcher;
    const closeSpy = vi.spyOn(fsWatcher, 'close');

    // leave a refresh pending, then unwatch
    const listener = watchSpy.mock.calls[0][2] as unknown as (e: string, f: string | null) => void;
    listener('change', 'src/a.ts');
    fetchFn.mockClear();
    w.unwatch(repo);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(w.getStatus(repo)).toEqual(DEFAULT_STATUS); // cache cleared
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchFn).not.toHaveBeenCalled(); // pending timer cleared
  });

  it('unwatch() of an unknown path is a safe no-op', () => {
    const w = makeWatcher(vi.fn(async () => STATUS_A));
    expect(() => w.unwatch('/never/watched')).not.toThrow();
  });

  it('getStatus is a synchronous cache read (DEFAULT all-zeros when unknown)', () => {
    const w = makeWatcher(vi.fn(async () => STATUS_A));
    expect(w.getStatus('/unknown')).toEqual({
      hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0,
    });
  });

  it('dispose() closes every watcher, cancels timers and empties the cache', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repoA = makeFakeRepo();
    const repoB = makeFakeRepo();
    const w = makeWatcher(fetchFn);
    w.watch(repoA);
    w.watch(repoB);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.getStatus(repoA)).toEqual(STATUS_A);

    const closeSpies = watchSpy.mock.results.map((r) => vi.spyOn(r.value as fs.FSWatcher, 'close'));
    const listenerA = watchSpy.mock.calls[0][2] as unknown as (e: string, f: string | null) => void;
    listenerA('change', 'src/a.ts'); // pending timer
    fetchFn.mockClear();

    w.dispose();
    for (const spy of closeSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(w.getStatus(repoA)).toEqual(DEFAULT_STATUS);
    expect(w.getStatus(repoB)).toEqual(DEFAULT_STATUS);
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('default constructor uses the real fetchStatus (compatible with existing callers)', async () => {
    vi.useRealTimers();
    const repo = makeRealRepo();
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');
    const w = makeWatcher(); // no injection — real git
    const statuses: GitStatus[] = [];
    await new Promise<void>((resolve) => {
      w.onChange((_p, s) => { statuses.push(s); resolve(); });
      w.watch(repo);
    });
    expect(statuses[0]).toMatchObject({ hasChanges: true, untracked: 1 });
    expect(w.getStatus(repo)).toEqual(statuses[0]);
  });
});

// ---------------------------------------------------------------------------
// baseDrift — how far a branch has slid behind the one it was cut from
// ---------------------------------------------------------------------------

describe('baseDrift', () => {
  /** Records the commands and answers from a table, throwing for absent refs. */
  const runner = (answers: Record<string, string>) => {
    const seen: string[] = [];
    const run = async (cmd: string): Promise<string> => {
      seen.push(cmd);
      const answer = answers[cmd];
      if (answer === undefined) throw new Error(`fatal: bad revision (${cmd})`);
      return answer;
    };
    return { run, seen };
  };

  it('prefers the remote ref over the local branch', async () => {
    // The local develop is usually the stale one — nobody checks it out just to
    // pull it — so origin's is the honest comparison.
    const { run, seen } = runner({
      'git rev-list --left-right --count HEAD..."origin/develop"': '3\t12\n',
      'git rev-list --left-right --count HEAD..."develop"': '3\t0\n',
    });

    await expect(baseDrift('/wt', 'develop', run)).resolves.toEqual({
      ref: 'origin/develop',
      ahead: 3,
      behind: 12,
    });
    expect(seen).toHaveLength(1); // the local branch was never asked
  });

  it('falls back to the local branch when there is no remote ref', async () => {
    const { run } = runner({ 'git rev-list --left-right --count HEAD..."develop"': '1\t4\n' });

    await expect(baseDrift('/wt', 'develop', run)).resolves.toEqual({
      ref: 'develop',
      ahead: 1,
      behind: 4,
    });
  });

  it('gives up when neither ref exists', async () => {
    const { run } = runner({});
    await expect(baseDrift('/wt', 'gone', run)).resolves.toBeUndefined();
  });

  it('treats unparseable counts as no answer rather than NaN on the card', async () => {
    const { run } = runner({
      'git rev-list --left-right --count HEAD..."origin/develop"': 'not numbers\n',
      'git rev-list --left-right --count HEAD..."develop"': '0\t7\n',
    });

    // Moves on to the local branch instead of reporting NaN behind.
    await expect(baseDrift('/wt', 'develop', run)).resolves.toEqual({
      ref: 'develop',
      ahead: 0,
      behind: 7,
    });
  });

  it('reports zero drift rather than hiding it', async () => {
    // "up to date with origin/develop" is an answer worth showing; the caller
    // decides not to ask at all when the worktree IS the base.
    const { run } = runner({ 'git rev-list --left-right --count HEAD..."origin/main"': '0\t0\n' });
    await expect(baseDrift('/wt', 'main', run)).resolves.toEqual({ ref: 'origin/main', ahead: 0, behind: 0 });
  });

  it('refuses a base branch that is not ref-shaped', async () => {
    // The name arrives from .foreman/config.json, which is a file in the repo, and
    // it ends up in a shell command. Refused for both candidate refs, so the
    // result is no drift rather than an executed injection.
    const { run, seen } = runner({});
    await expect(baseDrift('/wt', 'main; touch /tmp/pwned', run)).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('measures real drift in real repos', async () => {
    const repo = makeRealRepo();
    git(repo, 'branch develop');
    git(repo, 'checkout -b feature');
    git(repo, 'commit --allow-empty -m mine');
    git(repo, 'commit --allow-empty -m mine-2');
    git(repo, 'checkout develop');
    git(repo, 'commit --allow-empty -m theirs');
    git(repo, 'checkout feature');

    await expect(baseDrift(repo, 'develop')).resolves.toEqual({
      ref: 'develop',
      ahead: 2,
      behind: 1,
    });
  });

  it('is folded into fetchStatus only when a base is given', async () => {
    const repo = makeRealRepo();
    git(repo, 'branch develop');
    git(repo, 'checkout -b feature');
    git(repo, 'commit --allow-empty -m mine');

    expect((await fetchStatus(repo)).base).toBeUndefined();
    expect((await fetchStatus(repo, 'develop')).base).toEqual({ ref: 'develop', ahead: 1, behind: 0 });
  });
});

// ---------------------------------------------------------------------------
// base branch plumbing on the watcher
// ---------------------------------------------------------------------------

describe('GitWatcher base branch', () => {
  /** Records the (path, base) pairs fetchStatus was called with. */
  const recorder = () => {
    const calls: Array<[string, string | undefined]> = [];
    const fetchFn = async (p: string, base?: string): Promise<GitStatus> => {
      calls.push([p, base]);
      return STATUS_A;
    };
    return { calls, fetchFn };
  };

  it('passes the base it was given to every refresh', async () => {
    const repo = makeFakeRepo();
    const { calls, fetchFn } = recorder();
    const w = makeWatcher(fetchFn);

    w.watch(repo, 'develop');
    await w.refreshNow(repo);

    expect(calls).toContainEqual([repo, 'develop']);
  });

  it('updates the base of an already-watched worktree', async () => {
    // watch() returns early when the path is already watched, so recording the
    // base after that check would pin the drift to whatever base the worktree
    // was first seen with — through every reconcile, until a window reload.
    const repo = makeFakeRepo();
    const { calls, fetchFn } = recorder();
    const w = makeWatcher(fetchFn);

    w.watch(repo, 'develop');
    w.watch(repo, 'release/3.2');
    await w.refreshNow(repo);

    expect(calls.at(-1)).toEqual([repo, 'release/3.2']);
  });

  it('clears the base when a later watch omits it', async () => {
    const repo = makeFakeRepo();
    const { calls, fetchFn } = recorder();
    const w = makeWatcher(fetchFn);

    w.watch(repo, 'develop');
    w.watch(repo);
    await w.refreshNow(repo);

    expect(calls.at(-1)).toEqual([repo, undefined]);
  });

  it('forgets the base on unwatch', async () => {
    const repo = makeFakeRepo();
    const { calls, fetchFn } = recorder();
    const w = makeWatcher(fetchFn);

    w.watch(repo, 'develop');
    w.unwatch(repo);
    w.watch(repo);
    await w.refreshNow(repo);

    expect(calls.at(-1)).toEqual([repo, undefined]);
  });

  it('refreshNow publishes to the cache and the handlers', async () => {
    const repo = makeFakeRepo();
    const { fetchFn } = recorder();
    const w = makeWatcher(fetchFn);
    const seen: GitStatus[] = [];
    w.onChange((_p, status) => seen.push(status));

    await w.refreshNow(repo);

    expect(w.getStatus(repo)).toEqual(STATUS_A);
    expect(seen).toEqual([STATUS_A]);
  });

  it('refreshNow keeps the last good status when the read fails', async () => {
    // A failed git call must not blank the card; the previous answer is stale
    // but it is not wrong the way all-zeros would be.
    const repo = makeFakeRepo();
    let attempt = 0;
    const w = makeWatcher(async () => {
      attempt += 1;
      if (attempt === 1) return STATUS_A;
      throw new Error('git exploded');
    });

    await w.refreshNow(repo);
    await expect(w.refreshNow(repo)).resolves.toBeUndefined();

    expect(w.getStatus(repo)).toEqual(STATUS_A);
  });
});

// ---------------------------------------------------------------------------
// leaks and runaway refreshes
// ---------------------------------------------------------------------------

/** An FSWatcher stand-in that can emit 'error' and reports whether it was closed. */
function makeEmittingWatcher() {
  const emitter = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  emitter.close = vi.fn();
  return emitter;
}

describe('GitWatcher leaks', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a stream of edits still refreshes every 30s instead of never', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    fetchFn.mockClear();

    // A write every 5s, for a minute: a pure trailing 10s debounce never fires.
    for (let t = 0; t < 60_000; t += 5_000) {
      listeners[0]('change', 'dist/bundle.js');
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(fetchFn).toHaveBeenCalledTimes(2); // at 30s and at 60s
    expect(MAX_DEBOUNCE_WAIT_MS).toBe(30_000);
  });

  it('a quiet spell after a refresh starts a fresh window', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const repo = makeFakeRepo();
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(repo);
    await vi.advanceTimersByTimeAsync(0);
    fetchFn.mockClear();

    listeners[0]('change', 'a.ts');
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    listeners[0]('change', 'a.ts');
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS - 1);
    expect(fetchFn).toHaveBeenCalledTimes(1); // full debounce again, not the old deadline
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a watch that throws (EMFILE, ENOSPC) is logged and skipped, never thrown at the caller', async () => {
    const good = makeFakeRepo();
    const bad = makeFakeRepo();
    const fetchFn = vi.fn(async () => STATUS_A);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const watchFn = vi.fn((p: fs.PathLike) => {
      if (p === bad) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      return makeEmittingWatcher() as unknown as fs.FSWatcher;
    });
    const w = new GitWatcher(fetchFn, watchFn as unknown as typeof fs.watch);
    activeWatchers.push(w);

    expect(() => { w.watch(bad); w.watch(good); }).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(error).toHaveBeenCalledWith(expect.stringContaining(`cannot watch ${bad}`), expect.any(Error));
    expect(fetchFn).toHaveBeenCalledWith(good, undefined);
    expect(fetchFn).not.toHaveBeenCalledWith(bad, undefined);
    // Nothing recorded for the bad one, so a later attempt can retry.
    watchFn.mockImplementation(() => makeEmittingWatcher() as unknown as fs.FSWatcher);
    w.watch(bad);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledWith(bad, undefined);
    error.mockRestore();
  });

  it('closes what it had opened when the second watch of a linked worktree throws', () => {
    // A linked worktree: `.git` is a file pointing at a git dir that exists.
    const linked = makeTmpDir();
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${makeTmpDir()}\n`);
    const first = makeEmittingWatcher();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const watchFn = vi.fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    const w = new GitWatcher(vi.fn(async () => STATUS_A), watchFn as unknown as typeof fs.watch);
    activeWatchers.push(w);

    w.watch(linked);

    expect(first.close).toHaveBeenCalled();
    error.mockRestore();
  });

  it('a watcher error closes that worktree\'s watchers instead of crashing, and allows a retry', async () => {
    const repo = makeFakeRepo();
    const watchers: ReturnType<typeof makeEmittingWatcher>[] = [];
    const watchFn = vi.fn(() => { const x = makeEmittingWatcher(); watchers.push(x); return x; });
    const fetchFn = vi.fn(async () => STATUS_A);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = new GitWatcher(fetchFn, watchFn as unknown as typeof fs.watch);
    activeWatchers.push(w);
    w.watch(repo);

    expect(() => watchers[0].emit('error', new Error('EPERM'))).not.toThrow();
    expect(watchers[0].close).toHaveBeenCalled();

    w.watch(repo); // not "already watched" any more
    expect(watchFn).toHaveBeenCalledTimes(2);
    // An error from the replaced watcher is old news and touches nothing.
    watchers[0].emit('error', new Error('late'));
    expect(watchers[1].close).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('a read in flight when the worktree is unwatched does not refill the cache', async () => {
    const repo = makeFakeRepo();
    let answer!: (s: GitStatus) => void;
    const { w } = makeDebounceWatcher(() => new Promise<GitStatus>((r) => { answer = r; }));
    const handler = vi.fn();
    w.onChange(handler);
    w.watch(repo); // starts a read

    w.unwatch(repo);
    answer(STATUS_A);
    await vi.advanceTimersByTimeAsync(0);

    expect(w.getStatus(repo)).toEqual(DEFAULT_STATUS);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a read in flight at dispose is dropped too', async () => {
    const repo = makeFakeRepo();
    let answer!: (s: GitStatus) => void;
    const { w } = makeDebounceWatcher(() => new Promise<GitStatus>((r) => { answer = r; }));
    w.watch(repo);

    w.dispose();
    answer(STATUS_A);
    await vi.advanceTimersByTimeAsync(0);

    expect(w.getStatus(repo)).toEqual(DEFAULT_STATUS);
  });

  it('notifies only when the status actually changed', async () => {
    const repo = makeFakeRepo();
    let next: GitStatus = STATUS_A;
    const w = makeWatcher(async () => next);
    const handler = vi.fn();
    w.onChange(handler);

    await w.refreshNow(repo);
    await w.refreshNow(repo);
    expect(handler).toHaveBeenCalledTimes(1);

    next = { ...STATUS_A, untracked: 9 };
    await w.refreshNow(repo);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('onChange returns a way to unsubscribe', async () => {
    const repo = makeFakeRepo();
    const w = makeWatcher(async () => STATUS_A);
    const kept = vi.fn();
    const dropped = vi.fn();
    w.onChange(kept);
    const sub = w.onChange(dropped);

    sub.dispose();
    await w.refreshNow(repo);

    expect(kept).toHaveBeenCalledOnce();
    expect(dropped).not.toHaveBeenCalled();
  });

  it('the main checkout ignores changes inside a worktree nested under it', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const root = makeFakeRepo();
    const nested = path.join(root, '.worktrees', 'feat-x');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(root);
    w.watch(nested);
    await vi.advanceTimersByTimeAsync(0);
    fetchFn.mockClear();

    listeners[0]('change', '.worktrees/feat-x/src/a.ts'); // the root's watcher
    await vi.advanceTimersByTimeAsync(MAX_DEBOUNCE_WAIT_MS);
    expect(fetchFn).not.toHaveBeenCalled();

    listeners[0]('change', '.worktrees/notes.md'); // the root's own file
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS);
    expect(fetchFn).toHaveBeenCalledWith(root, undefined);
  });

  it('a watched parent of a worktree is not mistaken for a nested one', async () => {
    const fetchFn = vi.fn(async () => STATUS_A);
    const parent = makeFakeRepo();
    const child = path.join(parent, 'zer', 'feat-y');
    fs.mkdirSync(path.join(child, '.git'), { recursive: true });
    const { w, listeners } = makeDebounceWatcher(fetchFn);
    w.watch(child);
    w.watch(parent);
    await vi.advanceTimersByTimeAsync(0);
    fetchFn.mockClear();

    listeners[0]('change', 'src/b.ts'); // the child's own watcher
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS);
    expect(fetchFn).toHaveBeenCalledWith(child, undefined);
  });

  it('ignores linked worktrees\' admin files under the main .git', () => {
    expect(shouldIgnore('.git/worktrees/feat-x/index')).toBe(true);
    expect(shouldIgnore('.git/worktrees/feat-x/HEAD')).toBe(true);
  });
});



// ---------------------------------------------------------------------------
// diffLines — the "+40 −9" on a row
// ---------------------------------------------------------------------------

describe('parseNumstat', () => {
  it('sums added and removed lines over every file', () => {
    expect(parseNumstat('3\t1\ta.ts\n10\t0\tb/c.ts\n')).toEqual({ added: 13, removed: 1 });
  });

  it('skips binary files, which print dashes instead of counts', () => {
    expect(parseNumstat('-\t-\timg.png\n2\t2\ta.ts\n')).toEqual({ added: 2, removed: 2 });
  });

  it('reads nothing as zero', () => {
    expect(parseNumstat('')).toEqual({ added: 0, removed: 0 });
  });
});

describe('diffLines', () => {
  const SHA = 'a'.repeat(40);

  it('measures from the merge base when there is a base, not from the base tip', async () => {
    const seen: string[] = [];
    const run = async (cmd: string) => {
      seen.push(cmd);
      return cmd.startsWith('git merge-base') ? `${SHA}\n` : '4\t2\tx.ts\n';
    };
    await expect(diffLines('/wt', { ref: 'origin/develop', ahead: 1, behind: 9 }, run)).resolves.toEqual({ added: 4, removed: 2 });
    expect(seen).toEqual(['git merge-base HEAD "origin/develop"', `git diff --numstat ${SHA}`]);
  });

  it('diffs against HEAD in the main checkout, which has no base', async () => {
    const seen: string[] = [];
    await diffLines('/wt', undefined, async (cmd) => { seen.push(cmd); return '1\t0\tx.ts\n'; });
    expect(seen).toEqual(['git diff --numstat HEAD']);
  });

  it('answers nothing when there is nothing to count, or git cannot say', async () => {
    await expect(diffLines('/wt', undefined, async () => '')).resolves.toBeUndefined();
    await expect(diffLines('/wt', undefined, async () => { throw new Error('bad revision'); })).resolves.toBeUndefined();
    // A merge base that is not a hash (an error message on stdout, say) is not trusted.
    await expect(diffLines('/wt', { ref: 'develop', ahead: 0, behind: 0 }, async () => 'fatal: nope')).resolves.toBeUndefined();
    // And a base ref that is not ref-shaped never reaches a shell.
    await expect(diffLines('/wt', { ref: 'x; rm -rf', ahead: 0, behind: 0 }, async () => SHA)).resolves.toBeUndefined();
  });

  it('counts a branch\'s committed and uncommitted work together in a real repo', async () => {
    const repo = makeRealRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, 'add a.txt');
    git(repo, 'commit -m base');
    git(repo, 'branch develop');
    git(repo, 'checkout -b feature');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'x\ny\nz\n');
    git(repo, 'add b.txt');
    git(repo, 'commit -m mine');
    // The base moves on: this must not read as work the branch deleted.
    git(repo, 'checkout develop');
    fs.writeFileSync(path.join(repo, 'c.txt'), '1\n2\n3\n4\n');
    git(repo, 'add c.txt');
    git(repo, 'commit -m theirs');
    git(repo, 'checkout feature');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');

    const status = await fetchStatus(repo, 'develop');
    expect(status.lines).toEqual({ added: 3, removed: 1 });
  });

  it('is left out of the status when the tree is clean', async () => {
    const repo = makeRealRepo();
    expect('lines' in (await fetchStatus(repo))).toBe(false);
  });
});
