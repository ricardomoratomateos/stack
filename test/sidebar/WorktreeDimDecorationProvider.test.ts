import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WorktreeDimDecorationProvider,
  isDimmed,
  DIM_COLOR,
} from '../../src/sidebar/WorktreeDimDecorationProvider';
import { Uri, resetVscodeMock } from '../__mocks__/vscode';
import type { Worktree } from '../../src/types';

function wt(over: Partial<Worktree>): Worktree {
  return {
    id: 'x', branch: 'b', path: '/p', repoRoot: '/repo',
    xdebugPort: 0, dockerProjectName: 'd', createdAt: 0, ...over,
  };
}

const main = wt({ id: 'main', path: '/repo', branch: 'main', isMain: true });
const featA = wt({ id: 'a', path: '/repo/zer/feat-a', branch: 'feat/a' });
const featB = wt({ id: 'b', path: '/repo/zer/feat-b', branch: 'feat/b' });
const WORKTREES = [main, featA, featB];

beforeEach(() => resetVscodeMock());

// ── isDimmed (pure) ────────────────────────────────────────────────────────────

describe('isDimmed', () => {
  it('dims a file owned by a non-active feature worktree', () => {
    expect(isDimmed('/repo/zer/feat-b/src/x.ts', WORKTREES, 'a')).toBe(true);
  });

  it('does NOT dim files of the active worktree', () => {
    expect(isDimmed('/repo/zer/feat-a/src/x.ts', WORKTREES, 'a')).toBe(false);
  });

  it('dims the main worktree too when it is not the active one', () => {
    expect(isDimmed('/repo/src/x.ts', WORKTREES, 'a')).toBe(true);
    expect(isDimmed('/repo/package.json', WORKTREES, 'b')).toBe(true);
  });

  it('does not dim the main worktree when main is active', () => {
    expect(isDimmed('/repo/src/x.ts', WORKTREES, 'main')).toBe(false);
  });

  it('resolves ownership by longest path prefix (nested worktree wins over main)', () => {
    // /repo/zer/feat-b is under main's path, but belongs to feat-b
    expect(isDimmed('/repo/zer/feat-b/deep/nested/y.ts', WORKTREES, 'a')).toBe(true);
  });

  it('dims all feature worktrees when the main worktree is active', () => {
    expect(isDimmed('/repo/zer/feat-a/x.ts', WORKTREES, 'main')).toBe(true);
    expect(isDimmed('/repo/zer/feat-b/x.ts', WORKTREES, 'main')).toBe(true);
  });

  it('does not dim paths outside every worktree', () => {
    expect(isDimmed('/somewhere/else/x.ts', WORKTREES, 'a')).toBe(false);
  });

  it('handles worktree paths with a trailing slash', () => {
    const withSlash = [main, wt({ id: 'a', path: '/repo/zer/feat-a/', branch: 'feat/a' })];
    expect(isDimmed('/repo/zer/feat-a/x.ts', withSlash, 'main')).toBe(true);
    expect(isDimmed('/repo/zer/feat-a/x.ts', withSlash, 'a')).toBe(false);
  });

  it('dims every worktree (incl. main) when nothing is active', () => {
    expect(isDimmed('/repo/zer/feat-a/x.ts', WORKTREES, undefined)).toBe(true);
    expect(isDimmed('/repo/src/x.ts', WORKTREES, undefined)).toBe(true);
  });
});

// ── provider ───────────────────────────────────────────────────────────────────

describe('WorktreeDimDecorationProvider', () => {
  it('returns a dim decoration (ignored-resource color) for non-active worktree files', () => {
    const p = new WorktreeDimDecorationProvider();
    p.update(WORKTREES, 'a');
    const dec = p.provideFileDecoration(Uri.file('/repo/zer/feat-b/x.ts') as never);
    expect(dec).toBeDefined();
    expect((dec!.color as { id: string }).id).toBe(DIM_COLOR);
  });

  it('returns undefined for the active worktree, and dims main when it is not active', () => {
    const p = new WorktreeDimDecorationProvider();
    p.update(WORKTREES, 'a');
    expect(p.provideFileDecoration(Uri.file('/repo/zer/feat-a/x.ts') as never)).toBeUndefined();
    // main is not active → dimmed
    expect(p.provideFileDecoration(Uri.file('/repo/src/x.ts') as never)).toBeDefined();
  });

  it('ignores non-file schemes', () => {
    const p = new WorktreeDimDecorationProvider();
    p.update(WORKTREES, 'a');
    const uri = new Uri('git', '/repo/zer/feat-b/x.ts');
    expect(p.provideFileDecoration(uri as never)).toBeUndefined();
  });

  it('returns undefined before any update (no worktrees known)', () => {
    const p = new WorktreeDimDecorationProvider();
    expect(p.provideFileDecoration(Uri.file('/repo/zer/feat-b/x.ts') as never)).toBeUndefined();
  });

  it('fires onDidChangeFileDecorations on update so the explorer repaints', () => {
    const p = new WorktreeDimDecorationProvider();
    const fired = vi.fn();
    p.onDidChangeFileDecorations(fired);
    p.update(WORKTREES, 'a');
    expect(fired).toHaveBeenCalledTimes(1);
    // switching active repaints again
    p.update(WORKTREES, 'b');
    expect(fired).toHaveBeenCalledTimes(2);
  });

  it('reflects the new active worktree after update', () => {
    const p = new WorktreeDimDecorationProvider();
    p.update(WORKTREES, 'a');
    expect(p.provideFileDecoration(Uri.file('/repo/zer/feat-b/x.ts') as never)).toBeDefined();
    p.update(WORKTREES, 'b'); // now feat-b is active → no longer dimmed
    expect(p.provideFileDecoration(Uri.file('/repo/zer/feat-b/x.ts') as never)).toBeUndefined();
  });

  it('dispose tears down the emitter', () => {
    const p = new WorktreeDimDecorationProvider();
    const fired = vi.fn();
    p.onDidChangeFileDecorations(fired);
    p.dispose();
    p.update(WORKTREES, 'a');
    expect(fired).not.toHaveBeenCalled();
  });
});
