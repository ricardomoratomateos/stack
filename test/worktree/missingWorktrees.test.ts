import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findMissingWorktrees, nodePathProbe, resolveReal, type PathProbe } from '../../src/worktree/missingWorktrees';
import type { Worktree } from '../../src/types';

function wt(id: string, p: string, repoRoot: string): Worktree {
  return { id, branch: id, path: p, repoRoot, debugPort: 0, dockerProjectName: id, createdAt: 0 };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-missingwt-')));
});

afterEach(() => {
  fs.chmodSync(tmp, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveReal', () => {
  it('resolves an existing path through its symlinks', () => {
    fs.mkdirSync(path.join(tmp, 'real'));
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'));
    expect(resolveReal(path.join(tmp, 'link'))).toBe(path.join(tmp, 'real'));
  });

  it('resolves a path that no longer exists through its deepest existing ancestor', () => {
    fs.mkdirSync(path.join(tmp, 'real'));
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'));
    expect(resolveReal(path.join(tmp, 'link', 'gone', 'deeper'))).toBe(path.join(tmp, 'real', 'gone', 'deeper'));
  });

  it('resolves macOS\'s tmpdir alias the same way on both sides', () => {
    // os.tmpdir() is under /var on macOS, which is a symlink to /private/var;
    // git prints the resolved form. Elsewhere both sides are simply equal.
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-alias-'));
    try {
      expect(resolveReal(path.join(raw, 'x'))).toBe(path.join(fs.realpathSync(raw), 'x'));
    } finally {
      fs.rmSync(raw, { recursive: true, force: true });
    }
  });

  it('ignores trailing separators', () => {
    expect(resolveReal(tmp + path.sep)).toBe(tmp);
  });

  it('falls back to the plain absolute path when nothing at all resolves', () => {
    const nothing: PathProbe = { realpath: () => { throw new Error('ENOENT'); }, isGone: () => true };
    expect(resolveReal('/a/b/', nothing)).toBe('/a/b');
  });
});

describe('nodePathProbe.isGone', () => {
  it('is false for a path that exists', () => {
    expect(nodePathProbe.isGone(tmp)).toBe(false);
  });

  it('is true for a path that does not exist (ENOENT)', () => {
    expect(nodePathProbe.isGone(path.join(tmp, 'nope'))).toBe(true);
  });

  it('is true for a path under a file (ENOTDIR)', () => {
    fs.writeFileSync(path.join(tmp, 'file'), '');
    expect(nodePathProbe.isGone(path.join(tmp, 'file', 'child'))).toBe(true);
  });

  it('is false for a dangling symlink: the link itself is there', () => {
    fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(tmp, 'dangling'));
    expect(nodePathProbe.isGone(path.join(tmp, 'dangling'))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('is false when it cannot look (EACCES): not knowing is not "gone"', () => {
    const locked = path.join(tmp, 'locked');
    fs.mkdirSync(path.join(locked, 'child'), { recursive: true });
    fs.chmodSync(locked, 0o000);
    try {
      expect(nodePathProbe.isGone(path.join(locked, 'child'))).toBe(false);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe('findMissingWorktrees', () => {
  it('reports nothing for nothing to check', () => {
    expect(findMissingWorktrees(tmp, [], [{ path: tmp, prunable: false }])).toEqual([]);
  });

  it('a detached worktree (no branch line) still counts as listed', () => {
    // listWorktrees drops it; listWorktreePaths does not, and this relies on that.
    const detached = path.join(tmp, 'detached');
    const candidates = [wt('d', detached, tmp)];
    expect(findMissingWorktrees(tmp, candidates, [{ path: tmp, prunable: false }, { path: detached, prunable: false }])).toEqual([]);
  });
});
