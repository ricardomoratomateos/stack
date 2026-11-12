import { describe, expect, it } from 'vitest';
import { needsOf, trayModel } from './tray';
import type { Snapshot } from '../stackd/api';
import type { WorktreeItem } from '@core/webview/types';

const wt = (id: string, over: Partial<WorktreeItem> = {}): WorktreeItem => ({
  id, branch: id, path: `/r/${id}`, isMain: false, deleting: false, agent: 'idle', agentCount: 1, terminalCount: 0, sessions: [],
  git: {} as WorktreeItem['git'], ports: [], ...over,
});
const snap = (worktrees: WorktreeItem[]): Snapshot => ({ seq: 1, tmux: {}, repos: [{ repoRoot: '/x/stack', state: { worktrees } as never }] });
const asking = (id: string, since: number) => wt(id, {
  agent: 'permission', since,
  sessions: [{ name: 'claude', kind: 'agent', state: 'permission', attention: 'Bash: npm test', index: 2 }],
});

describe('tray', () => {
  it('counts needs and review and offers Allow for permission prompts', () => {
    const s = snap([asking('a', 2), wt('b', { review: { summary: 'x', at: 1 }, sessions: [{ name: 'claude', kind: 'agent', state: 'waiting', index: 0 }] }), wt('c')]);
    const m = trayModel(s, false);
    expect(m.title).toBe('◆ 1  ◇ 1');
    expect(m.needs).toEqual([{ worktreeId: 'a', label: 'stack · a', allow: 2, ask: 'Bash: npm test' }]);
    expect(m.review.map((r) => r.worktreeId)).toEqual(['b']);
  });

  it('needsOf carries "<repo> · <worktree>" and the command, oldest first', () => {
    expect(needsOf(snap([asking('new', 9), asking('old', 1)]))).toEqual([
      { id: 'old', title: 'stack · old', body: 'npm test' },
      { id: 'new', title: 'stack · new', body: 'npm test' },
    ]);
  });

  it('is empty without a snapshot', () => {
    expect(trayModel(null, true)).toEqual({ title: '◆ 0  ◇ 0', needs: [], review: [], dnd: true });
  });
});
