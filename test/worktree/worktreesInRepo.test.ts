import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { worktreesInRepo } from '../../src/worktree/worktreesInRepo';

const wt = (id: string, repoRoot: string) => ({ id, repoRoot });

describe('worktreesInRepo', () => {
  const mine = wt('a', '/repo');
  const also = wt('b', '/repo');
  const other = wt('z', '/other');

  it('keeps only the worktrees of the given repository', () => {
    expect(worktreesInRepo([mine, other, also], '/repo')).toEqual([mine, also]);
  });

  it('returns nothing when there is no repository', () => {
    // Not everything: a window with nothing git-shaped open must not end up in
    // charge of every project the extension has ever seen, which is the failure
    // this exists to prevent rather than a safe fallback from it.
    expect(worktreesInRepo([mine, other], undefined)).toEqual([]);
    expect(worktreesInRepo([mine, other], '')).toEqual([]);
  });

  it('normalises both sides, so a trailing slash or a "." still matches', () => {
    expect(worktreesInRepo([wt('a', '/repo/')], '/repo')).toHaveLength(1);
    expect(worktreesInRepo([wt('a', '/repo')], '/repo/./')).toHaveLength(1);
    expect(worktreesInRepo([wt('a', '/repo/sub/..')], '/repo')).toHaveLength(1);
  });

  it('does not match a repository that merely shares a prefix', () => {
    // "/repository" starts with "/repo"; a prefix test rather than an equality
    // one would put someone else's project in this window.
    expect(worktreesInRepo([wt('a', '/repository')], '/repo')).toEqual([]);
  });

  it('preserves order and returns a new array', () => {
    const input = [mine, other, also];
    const out = worktreesInRepo(input, '/repo');
    expect(out).not.toBe(input);
    expect(out.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('handles an empty store', () => {
    expect(worktreesInRepo([], '/repo')).toEqual([]);
  });

  it('is the same rule the service and the extension both use', () => {
    // One definition on purpose: the sidebar filters with it, and extension.ts
    // needs it before the service exists, to scope the tab and breakpoint
    // managers. Two copies would be two chances to disagree.
    const root = path.join('/repo');
    expect(worktreesInRepo([mine, other], root).map((w) => w.id)).toEqual(['a']);
  });
});
