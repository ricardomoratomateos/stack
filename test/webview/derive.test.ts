import { describe, it, expect } from 'vitest';
import {
  attentionOf, attentionQueue, countByGroup, describe as describeWt, describeAll, describeStack, formatAge,
  groupOf, nextInQueue, parseAttention, primaryAgent, sessionToOpen,
} from '../../src/webview/derive';
import type { AgentState, SessionItem, WorktreeItem } from '../../src/webview/types';

const session = (state: AgentState, over: Partial<SessionItem> = {}): SessionItem =>
  ({ name: 'claude', kind: 'agent', provider: 'claude', state, index: 1, ...over });

function wt(over: Partial<WorktreeItem> = {}): WorktreeItem {
  return {
    id: 'a', branch: 'feat/a', path: '/r/a', isMain: false, deleting: false, agent: 'idle',
    agentCount: 0, terminalCount: 0, sessions: [], ports: [], docker: [],
    git: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 },
    ...over,
  };
}

const dirty = { hasChanges: true, staged: 0, unstaged: 3, untracked: 1, ahead: 0, behind: 0 };

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

  it('ready for review: an agent at rest and something to look at', () => {
    expect(groupOf(wt({ sessions: [session('waiting')], git: dirty }))).toBe('review');
    expect(groupOf(wt({ sessions: [session('idle')], git: dirty }))).toBe('review');
    // Commits beyond the base count, as do unpushed ones and an open PR.
    const committed = { ...dirty, hasChanges: false, base: { ref: 'develop', ahead: 2, behind: 0 } };
    expect(groupOf(wt({ sessions: [session('waiting')], git: committed }))).toBe('review');
    expect(groupOf(wt({ sessions: [session('waiting')], git: { ...dirty, hasChanges: false, ahead: 1 } }))).toBe('review');
    expect(groupOf(wt({ sessions: [session('waiting')], pr: { number: 4, state: 'OPEN' } }))).toBe('review');
  });

  it('idle: no agent, a clean agent, a shell only, a merged PR or a dead agent', () => {
    expect(groupOf(wt())).toBe('idle');
    expect(groupOf(wt({ git: dirty }))).toBe('idle');
    expect(groupOf(wt({ sessions: [session('waiting')] }))).toBe('idle');
    expect(groupOf(wt({ sessions: [session('waiting')], pr: { number: 4, state: 'MERGED' } }))).toBe('idle');
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
    expect(describeWt(ask).line).toBe('ls');
    expect(describeWt(ask).attention).toEqual({ command: 'ls' });
    expect(describeWt(wt({ sessions: [session('permission', { attention: 'needs ok' })] })).line).toBe('needs ok');
    expect(describeWt(wt({ sessions: [session('permission', { title: 'Fix it' })] })).line).toBe('Fix it');
    expect(describeWt(wt({ sessions: [session('permission')] })).line).toBe('Wants your attention');
    expect(describeWt(wt({ sessions: [session('active', { title: 'Editing a.ts' })] })).line).toBe('Editing a.ts');
    expect(describeWt(wt({ sessions: [session('active')] })).line).toBe('Working…');
    expect(describeWt(wt({ sessions: [session('waiting', { title: 'CSV export' })], git: dirty })).line).toBe('Done · CSV export');
    expect(describeWt(wt({ sessions: [session('waiting')], git: dirty })).line).toBe('Done — ready for review');
    expect(describeWt(wt({ sessions: [session('waiting', { title: 'Hi' })] })).line).toBe('Hi');
    expect(describeWt(wt({ sessions: [session('waiting')] })).line).toBe('Waiting for a task');
    expect(describeWt(wt()).line).toBe('No agent running');
    expect(describeWt(wt({ missing: true })).line).toBe('Folder not found on disk');
    expect(describeWt(wt({ deleting: true })).line).toBe('Deleting…');
  });

  it('prefers the alias for the name and carries the provider', () => {
    const d = describeWt(wt({ alias: 'Export CSV', sessions: [session('active', { provider: 'codex' })] }));
    expect(d.name).toBe('Export CSV');
    expect(d.provider).toBe('codex');
    expect(describeWt(wt()).name).toBe('feat/a');
  });

  it('counts lines when git has them, files when it has not, and nothing when clean', () => {
    expect(describeWt(wt({ git: { ...dirty, lines: { added: 12, removed: 3 } } })).diff).toEqual({ added: 12, removed: 3 });
    expect(describeWt(wt({ git: dirty })).diff).toEqual({ files: 4 });
    expect(describeWt(wt({ git: { ...dirty, hasChanges: false, staged: 0, unstaged: 0, untracked: 0 } })).diff).toBeUndefined();
    expect(describeWt(wt()).diff).toBeUndefined();
  });

  it('reads drift against the base', () => {
    const base = (behind: number, ahead = 0) => describeWt(wt({ git: { ...dirty, base: { ref: 'origin/develop', ahead, behind } } })).base;
    expect(base(3)).toMatchObject({ text: '↓3 behind origin/develop', tone: 'warn' });
    expect(base(0)).toMatchObject({ text: 'up to date with origin/develop', tone: 'ok' });
    expect(base(1).title).toContain('1 commit behind');
    expect(base(2).title).toContain('2 commits behind');
    expect(describeWt(wt()).base).toMatchObject({ text: '—', tone: 'muted' });
    expect(describeWt(wt({ isMain: true })).base.text).toBe('main checkout');
  });

  it('names the ports the way the settings do, and the PR by state', () => {
    const d = describeWt(wt({
      ports: [{ name: 'HTTP_PORT', port: 8082, openable: true }, { name: 'DEBUG_PORT', port: 9902, openable: false }],
      pr: { number: 41, state: 'OPEN' },
    }));
    expect(d.ports).toEqual([
      { label: 'http', port: 8082, openable: true },
      { label: 'debug', port: 9902, openable: false },
    ]);
    expect(d.pr).toEqual({ number: 41, state: 'open' });
    expect(describeWt(wt({ pr: { number: 2, state: 'MERGED' } })).pr?.state).toBe('merged');
    expect(describeWt(wt({ pr: { number: 2, state: 'CLOSED' } })).pr?.state).toBe('closed');
    expect(describeWt(wt({ pr: null })).pr).toBeUndefined();
  });

  it('describes every worktree of a state, passing docker availability along', () => {
    const all = describeAll({ worktrees: [wt(), wt({ id: 'b' })], dockerUnavailable: 'daemon down' });
    expect(all.map((d) => d.wt.id)).toEqual(['a', 'b']);
    expect(all[0].stack.text).toBe('unknown');
  });
});

describe('describeStack', () => {
  const c = (state: string, exitCode?: number) => ({ name: `n-${state}`, state, exitCode });

  it('says what docker is doing before anything else', () => {
    expect(describeStack(wt({ dockerBusy: 'starting', dockerError: 'x' }))).toMatchObject({ text: 'starting…', tone: 'warn' });
    expect(describeStack(wt({ dockerBusy: 'stopping' })).text).toBe('stopping…');
  });

  it('surfaces the error compose gave', () => {
    expect(describeStack(wt({ dockerError: 'port is already allocated' }))).toEqual({
      text: 'failed', tone: 'bad', title: 'port is already allocated',
    });
  });

  it('reads an empty stack as unknown when docker is not answering, stopped when ports exist, nothing otherwise', () => {
    expect(describeStack(wt(), 'daemon down')).toMatchObject({ text: 'unknown', tone: 'muted' });
    expect(describeStack(wt({ ports: [{ name: 'HTTP_PORT', port: 1, openable: true }] }))).toMatchObject({ text: 'stopped' });
    expect(describeStack(wt())).toMatchObject({ text: '—' });
  });

  it('counts running containers, and calls out a crash', () => {
    expect(describeStack(wt({ docker: [c('running'), c('running')] }))).toMatchObject({ text: '2/2 up', tone: 'ok' });
    expect(describeStack(wt({ docker: [c('running'), c('created')] }))).toMatchObject({ text: '1/2 up', tone: 'warn' });
    expect(describeStack(wt({ docker: [c('exited', 0)] }))).toMatchObject({ text: 'stopped', tone: 'muted' });
    expect(describeStack(wt({ docker: [c('exited', 0), c('exited')] })).title).toBe('2 containers, none running');
    expect(describeStack(wt({ docker: [c('exited')] })).title).toBe('1 container, none running');
    expect(describeStack(wt({ docker: [c('running'), c('exited', 137)] }))).toMatchObject({ text: '1 crashed', tone: 'bad' });
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
