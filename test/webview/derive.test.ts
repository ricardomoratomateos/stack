import { describe, it, expect } from 'vitest';
import {
  attentionOf, attentionQueue, countByGroup, describe as describeWt, describeAll, formatAge, formatElapsed,
  groupOf, nextInQueue, parseAttention, primaryAgent, sessionToOpen,
} from '../../src/webview/derive';
import type { AgentState, SessionItem, WorktreeItem } from '../../src/webview/types';

const session = (state: AgentState, over: Partial<SessionItem> = {}): SessionItem =>
  ({ name: 'claude', kind: 'agent', provider: 'claude', state, index: 1, ...over });

function wt(over: Partial<WorktreeItem> = {}): WorktreeItem {
  return {
    id: 'a', branch: 'feat/a', path: '/r/a', isMain: false, deleting: false, agent: 'idle',
    agentCount: 0, terminalCount: 0, sessions: [],
    git: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0 },
    ...over,
  };
}

const dirty = { hasChanges: true, staged: 0, unstaged: 3, untracked: 1 };

describe('groupOf', () => {
  it('puts a worktree whose folder is gone under missing, whatever else is true', () => {
    expect(groupOf(wt({ missing: true, sessions: [session('permission')] }))).toBe('missing');
  });

  it('needs you: any session is asking, even when others are busy', () => {
    expect(groupOf(wt({ sessions: [session('active'), session('permission', { index: 2 })] }))).toBe('needs');
    expect(groupOf(wt({ agent: 'permission' }))).toBe('needs');
  });

  it('working: any session is active, which outranks review', () => {
    expect(groupOf(wt({ sessions: [session('active')], git: dirty }))).toBe('working');
    expect(groupOf(wt({ agent: 'active' }))).toBe('working');
  });

  it('ready for review when the agent asked for it, with its summary as the line — unless it is busy again', () => {
    const asked = wt({ sessions: [session('waiting')], review: { summary: 'Added SSO login', at: 1 } });
    expect(groupOf(asked)).toBe('review');
    expect(describeWt(asked).line).toBe('Added SSO login');
    expect(groupOf(wt({ review: { summary: 's', at: 1 } }))).toBe('review');
    expect(groupOf(wt({ sessions: [session('active')], review: { summary: 's', at: 1 } }))).toBe('working');
    expect(groupOf(wt({ sessions: [session('permission')], review: { summary: 's', at: 1 } }))).toBe('needs');
    expect(describeWt(wt({ sessions: [session('waiting')], git: dirty, review: { summary: '', at: 1 } })).line).toBe('Done — ready for review');
  });

  it('ready for review: an agent at rest and something to look at', () => {
    expect(groupOf(wt({ sessions: [session('waiting')], git: dirty }))).toBe('review');
    expect(groupOf(wt({ sessions: [session('idle')], git: dirty }))).toBe('review');
    // Committed work counts too: lines the branch changed since its base.
    const committed = { ...dirty, hasChanges: false, staged: 0, unstaged: 0, untracked: 0, lines: { added: 5, removed: 1 } };
    expect(groupOf(wt({ sessions: [session('waiting')], git: committed }))).toBe('review');
    expect(groupOf(wt({ sessions: [session('waiting')], git: { ...committed, lines: { added: 0, removed: 0 } } }))).toBe('idle');
  });

  it('ready for review: an agent that answered and waits on you, with nothing changed yet', () => {
    expect(groupOf(wt({ sessions: [session('waiting', { turned: true })] }))).toBe('review');
    // A freshly launched agent waits too, but has not taken a prompt: still idle.
    expect(groupOf(wt({ sessions: [session('waiting')] }))).toBe('idle');
    // Busy again: working outranks it.
    expect(groupOf(wt({ sessions: [session('active', { turned: true })] }))).toBe('working');
  });

  it('idle: no agent, a clean agent, a shell only or a dead agent', () => {
    expect(groupOf(wt())).toBe('idle');
    expect(groupOf(wt({ git: dirty }))).toBe('idle');
    expect(groupOf(wt({ sessions: [session('waiting')] }))).toBe('idle');
    expect(groupOf(wt({ sessions: [{ ...session('waiting'), kind: 'shell' }], git: dirty }))).toBe('idle');
    expect(groupOf(wt({ sessions: [session('terminated')], git: dirty }))).toBe('idle');
  });
});

describe('primaryAgent / sessionToOpen', () => {
  it('prefers the one asking, then the busy one, and ignores shells and dead agents', () => {
    const sessions = [
      session('terminated', { index: 0 }),
      { ...session('active'), kind: 'shell' as const, index: 1 },
      session('idle', { index: 2 }),
      session('active', { index: 3 }),
      session('permission', { index: 4 }),
    ];
    expect(primaryAgent(wt({ sessions }))?.index).toBe(4);
    expect(sessionToOpen(wt({ sessions }))?.index).toBe(4);
    expect(primaryAgent(wt({ sessions: sessions.slice(0, 4) }))?.index).toBe(3);
    expect(sessionToOpen(wt({ sessions: sessions.slice(0, 4) }))?.index).toBe(3);
    expect(primaryAgent(wt())).toBeUndefined();
  });
});

describe('attention text', () => {
  it('shows a command as a command and anything else as text', () => {
    expect(parseAttention('Bash: composer test --filter=Webhook')).toEqual({ command: 'composer test --filter=Webhook' });
    expect(parseAttention('Claude needs your permission\nsecond line')).toEqual({ text: 'Claude needs your permission' });
    expect(parseAttention('  ')).toBeUndefined();
    expect(parseAttention(undefined)).toBeUndefined();
  });

  it('is read from the session that is asking', () => {
    const sessions = [session('waiting', { attention: 'stale', index: 0 }), session('permission', { attention: 'Bash: ls', index: 1 })];
    expect(attentionOf(wt({ sessions }))).toEqual({ command: 'ls' });
    expect(attentionOf(wt({ sessions: [session('permission')] }))).toBeUndefined();
  });
});

describe('formatAge', () => {
  it('reads minutes, hours and days, and nothing when unknown', () => {
    const now = 10 * 86_400_000;
    expect(formatAge(undefined, now)).toBe('');
    expect(formatAge(now - 20_000, now)).toBe('now');
    expect(formatAge(now + 5_000, now)).toBe('now');
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m');
    expect(formatAge(now - 3 * 3_600_000 - 1, now)).toBe('3h');
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d');
  });
});

describe('describe', () => {
  it('says what a worktree is up to, per group', () => {
    const ask = wt({ sessions: [session('permission', { attention: 'Bash: ls' })] });
    expect(describeWt(ask).line).toBe('$ ls');
    expect(describeWt(ask).attention).toEqual({ command: 'ls' });
    expect(describeWt(wt({ sessions: [session('permission', { attention: 'needs ok' })] })).line).toBe('needs ok');
    expect(describeWt(wt({ sessions: [session('permission', { title: 'Fix it' })] })).line).toBe('Fix it');
    expect(describeWt(wt({ sessions: [session('permission')] })).line).toBe('Wants your attention');
    expect(describeWt(wt({ sessions: [session('active', { title: 'Editing a.ts' })] })).line).toBe('Editing a.ts');
    expect(describeWt(wt({ sessions: [session('active')] })).line).toBe('Working…');
    expect(describeWt(wt({ sessions: [session('waiting', { title: 'CSV export' })], git: dirty })).line).toBe('Done · CSV export');
    expect(describeWt(wt({ sessions: [session('waiting')], git: dirty })).line).toBe('Done — ready for review');
    // Its turn is over and it waits on you, perhaps with a question: your turn, not done.
    expect(describeWt(wt({ sessions: [session('waiting', { turned: true, title: 'CSV export' })] })).line).toBe('Your turn · CSV export');
    expect(describeWt(wt({ sessions: [session('waiting', { turned: true })], git: dirty })).line).toBe('Your turn');
    // An explicit review request keeps the review wording.
    expect(describeWt(wt({ sessions: [session('waiting', { turned: true, title: 'CSV export' })], review: { summary: '', at: 1 } })).line).toBe('Done · CSV export');
    expect(describeWt(wt({ sessions: [session('waiting', { title: 'Hi' })] })).line).toBe('Hi');
    expect(describeWt(wt({ sessions: [session('waiting')] })).line).toBe('Waiting for a task');
    expect(describeWt(wt()).line).toBe('No agent running');
    expect(describeWt(wt({ missing: true })).line).toBe('Folder not found on disk');
    expect(describeWt(wt({ deleting: true })).line).toBe('Deleting…');
  });

  it('prefers the alias for the name and carries the provider', () => {
    const d = describeWt(wt({ alias: 'Export CSV', sessions: [session('active', { provider: 'opencode' })] }));
    expect(d.name).toBe('Export CSV');
    expect(d.provider).toBe('opencode');
    expect(describeWt(wt()).name).toBe('feat/a');
  });

  it('counts lines when git has them, files when it has not, and nothing when clean', () => {
    expect(describeWt(wt({ git: { ...dirty, lines: { added: 12, removed: 3 } } })).diff).toEqual({ added: 12, removed: 3 });
    expect(describeWt(wt({ git: dirty })).diff).toEqual({ files: 4 });
    expect(describeWt(wt({ git: { ...dirty, hasChanges: false, staged: 0, unstaged: 0, untracked: 0 } })).diff).toBeUndefined();
    expect(describeWt(wt()).diff).toBeUndefined();
  });

  it('says the setup is running, or that it failed and why, before anything the agent says', () => {
    const agent = [session('waiting', { title: 'Ready' })];
    expect(describeWt(wt({ sessions: agent, setup: { state: 'running', startedAt: 1 } })).line).toBe('Preparing…');
    expect(describeWt(wt({ setup: { state: 'failed', startedAt: 1, error: 'exited with code 2' } })).line).toBe('Setup failed · exited with code 2');
    expect(describeWt(wt({ setup: { state: 'failed', startedAt: 1 } })).line).toBe('Setup failed · see the log');
    expect(describeWt(wt({ deleting: true, setup: { state: 'running', startedAt: 1 } })).line).toBe('Deleting…');
  });

  it('describes every worktree of a state', () => {
    const all = describeAll({ worktrees: [wt(), wt({ id: 'b' })] });
    expect(all.map((d) => d.wt.id)).toEqual(['a', 'b']);
  });
});

describe('the attention queue', () => {
  const item = (id: string, group: 'needs' | 'review' | 'working', since?: number) => ({ wt: wt({ id, since }), group });

  it('keeps the groups that wait on a person, oldest first, and ties in sidebar order', () => {
    const queue = attentionQueue([
      item('w', 'working', 1), item('late', 'review', 90), item('early', 'needs', 10),
      item('tie1', 'needs', 50), item('tie2', 'review', 50), item('unknown', 'needs'),
    ]);
    expect(queue.map((q) => q.wt.id)).toEqual(['early', 'tie1', 'tie2', 'late', 'unknown']);
  });

  it('steps to the entry after the current one, wrapping, or starts at the top', () => {
    const queue = [item('a', 'needs', 1), item('b', 'needs', 2), item('c', 'review', 3)];
    expect(nextInQueue(queue, 'a')?.wt.id).toBe('b');
    expect(nextInQueue(queue, 'c')?.wt.id).toBe('a');
    expect(nextInQueue(queue, 'zzz')?.wt.id).toBe('a');
    expect(nextInQueue(queue, undefined)?.wt.id).toBe('a');
    expect(nextInQueue([], 'a')).toBeUndefined();
  });
});

describe('countByGroup', () => {
  it('tallies every group, empty ones as zero', () => {
    const counts = countByGroup(describeAll({ worktrees: [wt(), wt({ id: 'b', missing: true }), wt({ id: 'c' })] }));
    expect(counts).toEqual({ needs: 0, review: 0, working: 0, idle: 2, missing: 1 });
  });
});

describe('formatElapsed', () => {
  it('reads as a clock: minutes and seconds, hours once there are any', () => {
    expect(formatElapsed(7_000)).toBe('0:07');
    expect(formatElapsed(102_400)).toBe('1:42');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});
