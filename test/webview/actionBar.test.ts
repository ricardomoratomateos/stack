import { describe, expect, it, vi } from 'vitest';
import type { WorktreeItem } from '../../src/webview/types';

const posted: unknown[] = [];
vi.mock('../../src/webview/vscode', () => ({ send: (m: unknown) => posted.push(m) }));

const { visibleCount, worktreeActions } = await import('../../src/webview/components/ActionBar');

const clean = { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 };
const wt = (over: Partial<WorktreeItem> = {}): WorktreeItem => ({
  id: 'a', branch: 'feat/a', path: '/r/a', isMain: false, deleting: false, agent: 'idle',
  agentCount: 0, terminalCount: 0, sessions: [], ports: [], docker: [], git: clean, pr: null,
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
    const ids = worktreeActions(wt({ git: { ...clean, base: { ref: 'origin/develop', ahead: 0, behind: 2 } } }), true).map((a) => a.id);
    expect(ids).toEqual(['terminal', 'diff', 'docker', 'setup', 'drift', 'rename', 'delete']);
  });

  it('leaves out what does not apply: no docker, no setup on main, no drift without a base', () => {
    expect(worktreeActions(wt({ isMain: true })).map((a) => a.id)).toEqual(['terminal', 'diff', 'rename', 'delete']);
  });

  it('offers stop for a running stack, and nothing to click while docker is busy', () => {
    const running = worktreeActions(wt({ docker: [{ name: 'web', state: 'running' }] }), true).find((a) => a.id === 'docker')!;
    expect(running.label).toBe('Stop containers');
    const busy = worktreeActions(wt({ dockerBusy: 'starting' }), true).find((a) => a.id === 'docker')!;
    expect(busy.disabled).toBe(true);
    expect(busy.label).toBe('Docker is starting the stack');
  });

  it('each action posts its message for this worktree', () => {
    posted.length = 0;
    for (const a of worktreeActions(wt({ git: { ...clean, base: { ref: 'b', ahead: 0, behind: 0 } } }), true)) a.run();
    expect(posted.map((m) => (m as { type: string }).type)).toEqual([
      'openTerminal', 'openDiff', 'dockerUp', 'initWorktree', 'refreshDrift', 'renameWorktree', 'deleteWorktree',
    ]);
    posted.length = 0;
    worktreeActions(wt({ docker: [{ name: 'web', state: 'running' }] }), true).find((a) => a.id === 'docker')!.run();
    expect(posted).toEqual([{ type: 'dockerDown', worktreeId: 'a' }]);
  });
});
