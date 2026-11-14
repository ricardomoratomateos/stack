import { describe, expect, it, vi } from 'vitest';
import type { WorktreeItem } from '../../src/webview/types';

const posted: unknown[] = [];
vi.mock('../../src/webview/vscode', () => ({ send: (m: unknown) => posted.push(m) }));

const { visibleCount, worktreeActions } = await import('../../src/webview/components/ActionBar');

const clean = { hasChanges: false, staged: 0, unstaged: 0, untracked: 0 };
const wt = (over: Partial<WorktreeItem> = {}): WorktreeItem => ({
  id: 'a', branch: 'feat/a', path: '/r/a', isMain: false, deleting: false, agent: 'idle',
  agentCount: 0, terminalCount: 0, sessions: [], git: clean,
  since: 0, ...over,
});

describe('visibleCount', () => {
  it('shows everything before the bar has been measured', () => {
    expect(visibleCount(undefined, 7)).toBe(7);
  });

  it('shows everything, with no "⋯", when it all fits', () => {
    // 7 icons: 7 × 28 + 6 gaps of 4 = 220px.
    expect(visibleCount(220, 7)).toBe(7);
  });

  it('keeps room for the "⋯" and shows as many as fit beside it', () => {
    // 6 icons + ⋯ would be 7 buttons = 220px; 5 icons + ⋯ = 188px fits in 219.
    expect(visibleCount(219, 7)).toBe(5);
  });

  it('never goes negative in a sliver of space', () => {
    expect(visibleCount(10, 7)).toBe(0);
  });
});

describe('worktreeActions', () => {
  it('lists the frequent actions first and delete last', () => {
    const ids = worktreeActions(wt({})).map((a) => a.id);
    expect(ids).toEqual(['terminal', 'diff', 'setup', 'rename', 'delete']);
  });

  it('leaves out what does not apply: no setup on main', () => {
    expect(worktreeActions(wt({ isMain: true })).map((a) => a.id)).toEqual(['terminal', 'diff', 'rename', 'delete']);
  });

  it('offers "Browse code" right after the review when the host has a code browser', () => {
    const actions = worktreeActions(wt({}), true);
    expect(actions.map((a) => a.id).slice(0, 3)).toEqual(['terminal', 'diff', 'code']);
    expect(actions[2]).toMatchObject({ icon: 'code', label: 'Browse code' });
    posted.length = 0;
    actions[2].run();
    expect(posted).toEqual([{ type: 'openCode', worktreeId: wt({}).id }]);
    expect(worktreeActions(wt({ isControl: true }), true).map((a) => a.id)).toEqual(['terminal', 'rename']);
  });

  it('each action posts its message for this worktree', () => {
    posted.length = 0;
    for (const a of worktreeActions(wt({}))) a.run();
    expect(posted.map((m) => (m as { type: string }).type)).toEqual([
      'openTerminal', 'openDiff', 'initWorktree', 'renameWorktree', 'deleteWorktree',
    ]);
  });
});
