import { describe, expect, it } from 'vitest';
import { graphOf, layout, loadCached, MAX_BRANCHES, mergeGraph, saveCached, type BootGraph } from './bootModel';
import type { Snapshot } from '../stackd/api';

const wt = (id: string, extra: Record<string, unknown> = {}) => ({
  id, branch: id, path: `/r/${id}`, isMain: false, deleting: false, agent: 'idle', agentCount: 0, terminalCount: 0,
  sessions: [], ports: [], pr: null, since: 0,
  git: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0 }, ...extra,
});
const snap = (worktrees: unknown[]): Snapshot => ({
  seq: 1, tmux: {}, repos: [{ repoRoot: '/Users/me/big-app', state: { worktrees } as never }],
});

describe('graphOf', () => {
  it('draws non-main tasks with their group, trunk named after the repo', () => {
    const g = graphOf(snap([wt('main', { isMain: true }), wt('a'), wt('b', { review: { summary: 'x' } })]));
    expect(g.trunk).toBe('big-app');
    expect(g.tasks.map((t) => [t.id, t.group])).toEqual([['a', 'idle'], ['b', 'review']]);
  });

  it('caps the branches and counts the rest', () => {
    const g = graphOf(snap(Array.from({ length: MAX_BRANCHES + 3 }, (_, i) => wt(`t${i}`))));
    expect(g.tasks).toHaveLength(MAX_BRANCHES);
    expect(g.more).toBe(3);
  });
});

describe('mergeGraph', () => {
  const cached: BootGraph = { trunk: 'repo', tasks: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], more: 0 };

  it('before stackd answers: the remembered tasks, unconfirmed', () => {
    expect(mergeGraph({ ...cached, tasks: [{ id: 'a', name: 'A', group: 'working' }] }, null).tasks).toEqual([{ id: 'a', name: 'A' }]);
    expect(mergeGraph(null, null)).toEqual({ trunk: 'main', tasks: [], more: 0 });
  });

  it('keeps remembered branches in place, drops gone ones, grows new ones at the end', () => {
    const live: BootGraph = { trunk: 'repo', tasks: [{ id: 'c', name: 'C', group: 'idle' }, { id: 'b', name: 'B', group: 'needs' }], more: 0 };
    expect(mergeGraph(cached, live).tasks.map((t) => `${t.id}:${t.group}`)).toEqual(['b:needs', 'c:idle']);
  });
});

describe('cache', () => {
  it('round-trips without groups and survives junk', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveCached({ trunk: 'r', tasks: [{ id: 'a', name: 'A', group: 'needs' }], more: 2 }, s);
    expect(loadCached(s)).toEqual({ trunk: 'r', tasks: [{ id: 'a', name: 'A' }], more: 2 });
    store.set('stack.boot.v1', '{nope');
    expect(loadCached(s)).toBeNull();
  });
});

describe('layout', () => {
  it('stacks tips in a column centred on the trunk, forks left to right', () => {
    const l = layout(3);
    expect(l.branches.map((b) => b.y)).toEqual([l.trunkY - 30, l.trunkY, l.trunkY + 30]);
    expect(l.branches[0].forkX).toBeLessThan(l.branches[2].forkX);
    expect(l.trunkEnd).toBe(l.branches[2].forkX);
    expect(layout(0).branches).toEqual([]);
  });
});
