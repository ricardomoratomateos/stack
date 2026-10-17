import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPidAlive, parseWindowFile, readWindows, resolveWindow } from '../../src/mcp/discovery';
import type { WindowFile } from '../../src/mcp/protocol';

const win = (over: Partial<WindowFile>): WindowFile => ({
  pid: 1, port: 1000, token: 't', repoRoots: [], workspaceFolders: [], worktreeIds: [], focusedAt: 0, ...over,
});

describe('isPidAlive', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is true for this process, false for nonsense pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-3)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it('reads ESRCH as dead and EPERM (someone else\'s process) as alive', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); });
    expect(isPidAlive(424242)).toBe(false);
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('x'), { code: 'EPERM' }); });
    expect(isPidAlive(424242)).toBe(true);
  });
});

describe('parseWindowFile', () => {
  it('reads a complete file', () => {
    const w = win({ pid: 5, repoRoots: ['/r'], workspaceFolders: ['/r'], worktreeIds: ['a'], focusedAt: 9 });
    expect(parseWindowFile(JSON.stringify(w))).toEqual(w);
  });

  it('defaults the optional lists and focus, and refuses what is not a window file', () => {
    expect(parseWindowFile(JSON.stringify({ pid: 5, port: 9, token: 'x', repoRoots: [1], focusedAt: 'x' }))).toEqual(
      win({ pid: 5, port: 9, token: 'x' }),
    );
    expect(parseWindowFile('not json')).toBeUndefined();
    expect(parseWindowFile('null')).toBeUndefined();
    expect(parseWindowFile('"str"')).toBeUndefined();
    expect(parseWindowFile(JSON.stringify({ pid: '5', port: 9, token: 'x' }))).toBeUndefined();
    expect(parseWindowFile(JSON.stringify({ pid: 5, port: '9', token: 'x' }))).toBeUndefined();
    expect(parseWindowFile(JSON.stringify({ pid: 5, port: 9, token: '' }))).toBeUndefined();
    expect(parseWindowFile(JSON.stringify({ pid: 5, port: 9 }))).toBeUndefined();
  });
});

describe('readWindows', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-win-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads live windows, sweeps dead ones, and skips anything else', () => {
    fs.writeFileSync(path.join(dir, '10.json'), JSON.stringify(win({ pid: 10 })));
    fs.writeFileSync(path.join(dir, '11.json'), JSON.stringify(win({ pid: 11 })));
    fs.writeFileSync(path.join(dir, '12.json'), 'garbage');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(dir, '13.json')); // unreadable as a file
    const windows = readWindows(dir, (pid) => pid === 10);
    expect(windows.map((w) => w.pid)).toEqual([10]);
    expect(fs.existsSync(path.join(dir, '11.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '12.json'))).toBe(true);
  });

  it('is empty when there is no directory, and survives a file it cannot remove', () => {
    expect(readWindows(path.join(dir, 'missing'))).toEqual([]);
    fs.writeFileSync(path.join(dir, '11.json'), JSON.stringify(win({ pid: 11 })));
    fs.chmodSync(dir, 0o500); // entries cannot be unlinked
    try {
      expect(readWindows(dir, () => false)).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('defaults to checking the pid for real', () => {
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(win({ pid: process.pid })));
    expect(readWindows(dir).map((w) => w.pid)).toEqual([process.pid]);
  });
});

describe('resolveWindow', () => {
  const repoA = win({ pid: 1, repoRoots: ['/code/a', '/code/a/.worktrees/x'], workspaceFolders: ['/code/a'], worktreeIds: ['ta'], focusedAt: 1 });
  const repoB = win({ pid: 2, repoRoots: ['/code/b'], workspaceFolders: ['/code/b', '/code/b-wt/y'], worktreeIds: ['tb'], focusedAt: 2 });
  const repoA2 = win({ pid: 3, repoRoots: ['/code/a'], workspaceFolders: ['/code/a'], worktreeIds: [], focusedAt: 5 });

  it('says to open Stack when no window is open at all', () => {
    expect(resolveWindow([], { paths: ['/code/a'] })).toEqual({ error: expect.stringContaining('Open Stack on /code/a in VS Code') });
    expect(resolveWindow([], { repo: '/code/z', paths: [] })).toEqual({ error: expect.stringContaining('on /code/z') });
    expect(resolveWindow([], { paths: [] })).toEqual({ error: expect.stringContaining('Open Stack on the repository') });
  });

  it('matches the repo argument first, the most specific folder winning', () => {
    expect(resolveWindow([repoA, repoB], { repo: '/code/b/src', taskId: 'ta', paths: ['/code/a'] })).toEqual({ window: repoB });
    expect(resolveWindow([repoA, repoB], { repo: '/code/b-wt/y/z', paths: [] })).toEqual({ window: repoB });
    const res = resolveWindow([repoA, repoB], { repo: '/code/zzz', paths: [] });
    expect(res).toEqual({ error: 'Open Stack on /code/zzz in VS Code. Open now: /code/a, /code/b.' });
  });

  it('then the window showing the task, wherever the agent runs', () => {
    expect(resolveWindow([repoA, repoB], { taskId: 'tb', paths: ['/code/a'] })).toEqual({ window: repoB });
    // An unknown task falls through to the paths.
    expect(resolveWindow([repoA, repoB], { taskId: 'zz', paths: ['/code/a'] })).toEqual({ window: repoA });
  });

  it('then the paths, in order; ties go to the most recently focused window', () => {
    expect(resolveWindow([repoA, repoB], { paths: ['/nowhere', '/code/b'] })).toEqual({ window: repoB });
    expect(resolveWindow([repoA, repoA2], { paths: ['/code/a/src'] })).toEqual({ window: repoA2 });
    // More specific beats more recent.
    expect(resolveWindow([repoA, repoA2], { paths: ['/code/a/.worktrees/x/src'] })).toEqual({ window: repoA });
    // A sibling with a shared prefix is not inside.
    expect(resolveWindow([repoA], { paths: ['/code/ab'] })).toEqual({ error: expect.any(String) });
  });

  it('never guesses: nothing matching lists what is open', () => {
    const blank = win({ pid: 9 });
    expect(resolveWindow([repoA, blank], { paths: ['/elsewhere'] })).toEqual({
      error: 'Open Stack on /elsewhere in VS Code, or pass "repo" with one of the open repositories: /code/a.',
    });
    expect(resolveWindow([blank], { paths: [] })).toEqual({
      error: 'Open Stack on this repository in VS Code, or pass "repo" with one of the open repositories: none.',
    });
    expect(resolveWindow([blank], { repo: '/x', paths: [] })).toEqual({ error: 'Open Stack on /x in VS Code. Open now: none.' });
  });

  it('accepts a folder given with a trailing separator, and the filesystem root', () => {
    const slash = win({ repoRoots: ['/code/s/'] });
    expect(resolveWindow([slash], { paths: ['/code/s/x'] })).toEqual({ window: slash });
    const root = win({ workspaceFolders: ['/'] });
    expect(resolveWindow([root], { paths: ['/anything'] })).toEqual({ window: root });
  });
});
