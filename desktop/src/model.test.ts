import { describe, expect, it } from 'vitest';
import type { SessionItem, StackState, WorktreeItem } from '@core/webview/types';
import { mruOrder, mruTouch, stepWrap, floatRows, buildView, liveAgentIndex, managerIndex, managerSession, pickSession, resolveShortcut, stepSessionIndex, sessionRows, shortcutOf, taskFromText, type KeyLike } from './model';
import type { Snapshot } from './stackd/api';

const session = (o: Partial<SessionItem> & { index: number }): SessionItem => ({ name: 'claude', kind: 'agent', provider: 'claude', state: 'idle', ...o });
const wt = (id: string, sessions: SessionItem[] = [], o: Partial<WorktreeItem> = {}): WorktreeItem => ({
  id, branch: id, path: `/r/${id}`, isMain: false, deleting: false, agent: 'idle', agentCount: 0, terminalCount: 0, sessions,
  git: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0 }, ...o,
});
const snap = (worktrees: WorktreeItem[], controlSession?: WorktreeItem): Snapshot => ({
  seq: 1, tmux: {}, repos: [{ repoRoot: '/home/me/shop', state: { worktrees, controlSession } as StackState }],
});
const key = (code: string, o: Partial<KeyLike> = {}): KeyLike => ({ metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, code, ...o });

describe('buildView', () => {
  it('is null without a snapshot or repos', () => {
    expect(buildView(null)).toBeNull();
    expect(buildView({ seq: 0, tmux: {}, repos: [] })).toBeNull();
  });
  it('groups and counts worktrees, keeping the control session apart', () => {
    const v = buildView(snap(
      [
        wt('a', [session({ index: 1, state: 'permission', attention: 'Bash: rm -rf x' })]),
        wt('b', [session({ index: 1, state: 'active' })]),
        wt('c', [session({ index: 1, state: 'active' })]),
        wt('d'),
      ],
      wt('control-1', [session({ index: 1 })], { isControl: true }),
    ))!;
    expect(v.repoName).toBe('shop');
    expect(v.counts).toMatchObject({ needs: 1, working: 2, idle: 1, review: 0 });
    expect(v.items.map((d) => d.wt.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(v.items[0].line).toBe('$ rm -rf x');
    expect(v.control?.wt.id).toBe('control-1');
  });
  it('picks the requested repo', () => {
    const s: Snapshot = { seq: 1, tmux: {}, repos: [
      { repoRoot: '/x/one', state: { worktrees: [] } as unknown as StackState },
      { repoRoot: '/x/two', state: { worktrees: [wt('t')] } as unknown as StackState },
    ] };
    expect(buildView(s, '/x/two')?.items).toHaveLength(1);
    expect(buildView(s, '/nope')?.repoName).toBe('one');
  });
});

describe('sessionRows', () => {
  it('lists every session: agent title or state, shell command', () => {
    const rows = sessionRows(
      wt('a', [
        session({ index: 2, name: 'shell', kind: 'shell', state: 'idle' }),
        session({ index: 1, title: 'Fix the login test', state: 'active' }),
        session({ index: 3, provider: 'opencode', state: 'permission' }),
      ]),
      { 2: 'npm' },
    );
    expect(rows.map((r) => [r.index, r.name, r.detail])).toEqual([
      [1, 'claude', 'Fix the login test'],
      [2, 'shell', 'npm'],
      [3, 'opencode', 'needs you'],
    ]);
  });
  it('says "your turn" for an agent that took a turn and waits, "waiting" for a fresh one', () => {
    const rows = sessionRows(wt('a', [session({ index: 1, state: 'waiting', turned: true }), session({ index: 2, state: 'waiting' })]));
    expect(rows.map((r) => r.detail)).toEqual(['your turn', 'waiting']);
  });
  it('falls back to the window name for a shell with no known command', () => {
    expect(sessionRows(wt('a', [session({ index: 1, name: 'zsh', kind: 'shell' })]))[0].detail).toBe('zsh');
  });
});

describe('liveAgentIndex', () => {
  it('picks the agent the daemon sends review comments to', () => {
    expect(liveAgentIndex(wt('a', [session({ index: 1, state: 'active' }), session({ index: 2, state: 'permission' }), session({ index: 3, state: 'waiting' })]))).toBe(3);
    expect(liveAgentIndex(wt('b', [session({ index: 1, state: 'active' }), session({ index: 2, state: 'permission' })]))).toBe(2);
  });
  it('skips shells and exited agents', () => {
    expect(liveAgentIndex(wt('c', [session({ index: 1, kind: 'shell', name: 'shell' }), session({ index: 2, state: 'terminated' })]))).toBeUndefined();
  });
});

describe('pickSession / managerSession', () => {
  const w = wt('a', [session({ index: 1, state: 'idle' }), session({ index: 2, state: 'permission' }), session({ index: 3, kind: 'shell', name: 'shell' })]);
  it('prefers the remembered window, then the one asking', () => {
    expect(pickSession(w, 3)).toBe(3);
    expect(pickSession(w, 9)).toBe(2);
    expect(pickSession(w)).toBe(2);
  });
  it('falls back to the first window, or nothing', () => {
    expect(pickSession(wt('b', [session({ index: 4, kind: 'shell', name: 'shell' })]))).toBe(4);
    expect(pickSession(wt('c'))).toBeUndefined();
  });
  it('finds the manager window', () => {
    expect(managerSession(w)?.index).toBe(2);
    expect(managerSession(undefined)).toBeUndefined();
  });
  it('keeps the remembered manager tab while it exists', () => {
    expect(managerIndex(w, 3)).toBe(3);
    expect(managerIndex(w, 9)).toBe(2);
    expect(managerIndex(w)).toBe(2);
    expect(managerIndex(undefined, 1)).toBeUndefined();
  });
});

describe('taskFromText', () => {
  it('derives a branch from the text', () => {
    expect(taskFromText('  Add dark mode!  ', '/r')).toEqual({ repo: '/r', branch: 'add-dark-mode', title: 'Add dark mode!', description: 'Add dark mode!' });
    expect(taskFromText('   ', '/r')).toBeNull();
    expect(taskFromText('!!!', '/r')).toBeNull();
  });
});

describe('shortcutOf', () => {
  it('maps the documented keys', () => {
    expect(shortcutOf(key('Digit1'))).toEqual({ kind: 'worktree', n: 1 });
    expect(shortcutOf(key('Digit9'))).toEqual({ kind: 'worktree', n: 9 });
    expect(shortcutOf(key('Digit0'))).toEqual({ kind: 'focus-manager' });
    expect(shortcutOf(key('BracketLeft', { shiftKey: true }))).toEqual({ kind: 'prev' });
    expect(shortcutOf(key('BracketRight', { shiftKey: true }))).toEqual({ kind: 'next' });
    expect(shortcutOf(key('KeyJ', { shiftKey: true }))).toEqual({ kind: 'needs' });
    expect(shortcutOf({ ...key('Quote', { shiftKey: true }), key: '{' })).toEqual({ kind: 'prev' });
    expect(shortcutOf({ ...key('Equal', { shiftKey: true }), key: ']' })).toEqual({ kind: 'next' });
    expect(shortcutOf({ ...key('BracketLeft', { shiftKey: true, altKey: true }), key: '”' })).toEqual({ kind: 'prev' });
    expect(shortcutOf(key('Digit0', { shiftKey: true }))).toEqual({ kind: 'toggle-manager' });
  });
  it('ignores everything else, so the terminal keeps its keys', () => {
    expect(shortcutOf(key('Digit1', { metaKey: false }))).toBeNull();
    expect(shortcutOf(key('Digit1', { ctrlKey: true }))).toBeNull();
    expect(shortcutOf(key('Digit1', { altKey: true }))).toBeNull();
    expect(shortcutOf(key('Digit1', { shiftKey: true }))).toBeNull();
    expect(shortcutOf(key('KeyJ'))).toBeNull();
    expect(shortcutOf(key('KeyC'))).toBeNull();
    expect(shortcutOf(key('BracketLeft'))).toBeNull();
  });
});

describe('resolveShortcut', () => {
  const v = buildView(snap([
    wt('a', [session({ index: 1, state: 'idle' })]),
    wt('b', [session({ index: 1, state: 'permission' })], { since: 200 }),
    wt('c', [session({ index: 1, state: 'permission' })], { since: 100 }),
    wt('d', [session({ index: 1, state: 'active' })]),
  ]))!;
  const ids = v.items;
  it('selects the nth worktree, nothing past the end', () => {
    expect(resolveShortcut({ kind: 'worktree', n: 2 }, ids, 'a')).toEqual({ select: 'b' });
    expect(resolveShortcut({ kind: 'worktree', n: 9 }, ids, 'a')).toEqual({});
  });
  it('steps and wraps', () => {
    expect(resolveShortcut({ kind: 'next' }, ids, 'd')).toEqual({ select: 'a' });
    expect(resolveShortcut({ kind: 'prev' }, ids, 'a')).toEqual({ select: 'd' });
    expect(resolveShortcut({ kind: 'next' }, ids, 'a')).toEqual({ select: 'b' });
    expect(resolveShortcut({ kind: 'next' }, ids, undefined)).toEqual({ select: 'a' });
    expect(resolveShortcut({ kind: 'prev' }, ids, undefined)).toEqual({ select: 'd' });
    expect(resolveShortcut({ kind: 'next' }, [], undefined)).toEqual({});
  });
  it('jumps through the attention queue, oldest first', () => {
    expect(resolveShortcut({ kind: 'needs' }, ids, 'a')).toEqual({ select: 'c' });
    expect(resolveShortcut({ kind: 'needs' }, ids, 'c')).toEqual({ select: 'b' });
    expect(resolveShortcut({ kind: 'needs' }, ids, 'b')).toEqual({ select: 'c' });
    expect(resolveShortcut({ kind: 'needs' }, [ids[0], ids[3]], 'a')).toEqual({});
  });
  it('repeat: ⌘N on the selected worktree advances its tab, ⌘0 on a focused Manager too', () => {
    expect(resolveShortcut({ kind: 'worktree', n: 1 }, ids, 'a', 'centre')).toEqual({ tab: { pane: 'centre', dir: 1 } });
    expect(resolveShortcut({ kind: 'worktree', n: 1 }, ids, 'a', 'manager')).toEqual({ select: 'a', focusCentre: true });
    expect(resolveShortcut({ kind: 'worktree', n: 2 }, ids, 'a', 'centre')).toEqual({ select: 'b' });
    expect(resolveShortcut({ kind: 'focus-manager' }, ids, 'a', 'centre')).toEqual({ focusManager: true });
    expect(resolveShortcut({ kind: 'focus-manager' }, ids, 'a', 'manager')).toEqual({ tab: { pane: 'manager', dir: 1 } });
  });
  it('tab-prev/next act on the focused pane', () => {
    expect(resolveShortcut({ kind: 'tab-next' }, ids, 'a', 'manager')).toEqual({ tab: { pane: 'manager', dir: 1 } });
    expect(resolveShortcut({ kind: 'tab-prev' }, ids, 'a')).toEqual({ tab: { pane: 'centre', dir: -1 } });
  });
  it('flags the manager actions', () => {
    expect(resolveShortcut({ kind: 'focus-manager' }, ids, 'a')).toEqual({ focusManager: true });
    expect(resolveShortcut({ kind: 'toggle-manager' }, ids, 'a')).toEqual({ toggleManager: true });
  });
});

describe('mode shortcuts and the float list', () => {
  it('maps ⌘⇧F to cycling the mode', () => {
    expect(shortcutOf(key('KeyM', { shiftKey: true }))).toEqual({ kind: 'cycle-mode' });
    // ⌘F and ⇧⌘F are the code search, never the window mode.
    expect(shortcutOf(key('KeyF', { shiftKey: true }))).toEqual({ kind: 'code-search', inFile: false });
    expect(shortcutOf(key('KeyF'))).toEqual({ kind: 'code-search', inFile: true });
    expect(resolveShortcut({ kind: 'code-search', inFile: false }, [], undefined)).toEqual({ codeSearch: true });
    expect(shortcutOf(key('Enter', { shiftKey: true }))).toEqual({ kind: 'maximize' });
    expect(resolveShortcut({ kind: 'maximize' }, [], undefined)).toEqual({ maximize: true });
    expect(resolveShortcut({ kind: 'cycle-mode' }, [], undefined)).toEqual({ cycleMode: true });
  });
  it('one row per worktree, Allow on the session that asks', () => {
    const v = buildView(snap([
      wt('a', [session({ index: 1, state: 'permission', attention: 'Bash: ls' }), session({ index: 2, kind: 'shell', name: 'zsh' })]),
      wt('b', [session({ index: 1, state: 'active' })]),
    ]))!;
    const rows = floatRows(v.items);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0].asking).toEqual({ index: 1, label: 'Bash: ls', attention: 'Bash: ls' });
    expect(rows[0].sessions).toHaveLength(2);
    expect(rows[1].asking).toBeUndefined();
  });
});

describe('switcher MRU', () => {
  it('moves the touched id to the front without duplicates', () => {
    expect(mruTouch(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(mruTouch([], 'a')).toEqual(['a']);
    expect(mruTouch(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });
  it('orders by recency, dropping gone ids and appending never-selected ones', () => {
    expect(mruOrder(['a', 'b', 'c', 'manager'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b', 'manager']);
    expect(mruOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('steps with wrap', () => {
    expect(stepWrap(0, 3, 1)).toBe(1);
    expect(stepWrap(2, 3, 1)).toBe(0);
    expect(stepWrap(0, 3, -1)).toBe(2);
    expect(stepWrap(0, 0, 1)).toBe(0);
  });
});

describe('stepSessionIndex', () => {
  const w = wt('a', [session({ index: 3 }), session({ index: 1 }), session({ index: 2 })]);
  const item = buildView(snap([w]))!.items[0].wt;
  it('steps through tab order and wraps', () => {
    expect(stepSessionIndex(item, 1, 1)).toBe(2);
    expect(stepSessionIndex(item, 3, 1)).toBe(1);
    expect(stepSessionIndex(item, 1, -1)).toBe(3);
    expect(stepSessionIndex(item, 99, 1)).toBe(1);
    expect(stepSessionIndex(undefined, 1, 1)).toBeUndefined();
  });
});

describe('alt-arrow shortcuts', () => {
  it('maps ⌥⌘←/→ to tab-prev/next', () => {
    expect(shortcutOf(key('ArrowLeft', { altKey: true }))).toEqual({ kind: 'tab-prev' });
    expect(shortcutOf(key('ArrowRight', { altKey: true }))).toEqual({ kind: 'tab-next' });
    expect(shortcutOf(key('ArrowRight'))).toBeNull();
  });
});
