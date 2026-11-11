import { describe, expect, it } from 'vitest';
import { describeCounts, parseJsonc, sidebarStyleFromSettings, toSidebarState, translate, type Context } from './bridge';
import { sampleState } from './fixtures';
import type { Snapshot } from '../stackd/api';

const state = sampleState(1_000_000);
const snapshot: Snapshot = { seq: 1, tmux: {}, repos: [{ repoRoot: '/r', state }, { repoRoot: '/s', state: { worktrees: [] } }] };
const ctx: Context = { repoRoot: '/r', worktrees: [...state.worktrees, state.controlSession!] };

describe('toSidebarState', () => {
  it('is the repo state with the app selection and the style', () => {
    const s = toSidebarState(snapshot, { repoRoot: '/r', activeWorktreeId: 'rev', sidebarStyle: 'claude' })!;
    expect(s.worktrees).toBe(state.worktrees);
    expect(s.controlSession).toBe(state.controlSession);
    expect(s.activeWorktreeId).toBe('rev');
    expect(s.sidebarStyle).toBe('claude');
  });
  it('picks the repo asked for, else the first, else nothing', () => {
    expect(toSidebarState(snapshot, { repoRoot: '/s' })!.worktrees).toEqual([]);
    expect(toSidebarState(snapshot, { repoRoot: '/nope' })!.worktrees).toBe(state.worktrees);
    expect(toSidebarState(null, {})).toBeNull();
  });
  it('falls back to aside for a style it does not know', () => {
    expect(toSidebarState(snapshot, { sidebarStyle: 'weird' as never })!.sidebarStyle).toBe('aside');
  });
});

describe('translate', () => {
  it('selecting worktrees and sessions shows them in the centre', () => {
    expect(translate({ type: 'selectWorktree', worktreeId: 'rev' }, ctx)).toEqual({ kind: 'select', worktreeId: 'rev' });
    expect(translate({ type: 'focusTerminal', worktreeId: 'rev' }, ctx)).toEqual({ kind: 'select', worktreeId: 'rev' });
    expect(translate({ type: 'focusSession', worktreeId: 'rev', kind: 'shell', index: 2 }, ctx)).toEqual({ kind: 'select', worktreeId: 'rev', index: 2 });
  });
  it('launching an agent or a shell are stackd commands that then show the new window', () => {
    expect(translate({ type: 'launchAgent', worktreeId: 'rev', provider: 'codex' }, ctx)).toEqual({ kind: 'command', name: 'spawnAgent', body: { worktreeId: 'rev', provider: 'codex' }, selectNew: 'rev' });
    expect(translate({ type: 'launchAgent', worktreeId: 'rev' }, ctx)).toMatchObject({ body: { worktreeId: 'rev' } });
    expect(translate({ type: 'openTerminal', worktreeId: 'rev' }, ctx)).toEqual({ kind: 'command', name: 'spawnShell', body: { worktreeId: 'rev' }, selectNew: 'rev' });
  });
  it('killSession names the window', () => {
    expect(translate({ type: 'killSession', worktreeId: 'rev', index: 2 }, ctx)).toEqual({ kind: 'command', name: 'killWindow', body: { worktreeId: 'rev', windowIndex: 2 } });
  });
  it('renames ask first, starting from the current alias', () => {
    const a = translate({ type: 'renameWorktree', worktreeId: 'ask' }, ctx);
    expect(a).toMatchObject({ kind: 'ask', initial: 'fix-payments', then: { name: 'renameTask', body: { worktreeId: 'ask' }, field: 'alias' } });
    expect(translate({ type: 'renameSession', worktreeId: 'rev', index: 1 }, ctx)).toMatchObject({ kind: 'ask', initial: '', then: { name: 'renameSession', body: { worktreeId: 'rev', windowIndex: 1 }, field: 'name' } });
  });
  it('delete confirms with the extension\'s own plan, then deletes (keeping the branch when chosen)', () => {
    const a = translate({ type: 'deleteWorktree', worktreeId: 'ask' }, ctx);
    if (a.kind !== 'confirm') throw new Error('expected confirm');
    expect(a.detail).toContain('Uncommitted changes');
    expect(a.then(0)).toMatchObject({ name: 'deleteTask', body: { worktreeId: 'ask' } });
    expect(translate({ type: 'deleteWorktree', worktreeId: 'zzz' }, ctx)).toEqual({ kind: 'none' });
  });
  it('messages stackd runs itself go through the `message` command', () => {
    const msg = { type: 'dockerUp', worktreeId: 'ask' } as const;
    expect(translate(msg, ctx)).toEqual({ kind: 'command', name: 'message', body: { message: msg, repo: '/r' } });
    expect(translate({ type: 'reorderWorktrees', orderedIds: ['a'] }, ctx)).toMatchObject({ name: 'message' });
    expect(translate({ type: 'forgetWorktree', worktreeId: 'gone' }, ctx)).toMatchObject({ name: 'message' });
  });
  it('new task opens the form; createWorktree is createTask in the repo', () => {
    expect(translate({ type: 'openNewTask' }, ctx)).toEqual({ kind: 'newTask' });
    expect(translate({ type: 'createWorktree', branch: 'b', title: 't' }, ctx)).toMatchObject({ kind: 'command', name: 'createTask', body: { repo: '/r', branch: 'b', title: 't' } });
  });
  it('review, links and provider choice are not in the desktop app yet', () => {
    for (const msg of [
      { type: 'openDiff', worktreeId: 'a' }, { type: 'openPr', worktreeId: 'a' }, { type: 'openTicket', worktreeId: 'a' },
      { type: 'openPort', port: 1 }, { type: 'pickDefaultProvider' }, { type: 'showProviderInstall', provider: 'codex' },
    ] as const) expect(translate(msg, ctx).kind).toBe('unsupported');
  });
  it('ready and listBranches need nothing', () => {
    expect(translate({ type: 'ready' }, ctx)).toEqual({ kind: 'none' });
    expect(translate({ type: 'listBranches' }, ctx)).toEqual({ kind: 'none' });
  });
});

describe('describeCounts', () => {
  it('matches the view header text of the extension', () => {
    expect(describeCounts(state)).toBe('1 thinking · 1 needs you');
    expect(describeCounts({ worktrees: [] })).toBe('');
  });
});

describe('sidebar style from settings.json', () => {
  it('reads stack.sidebarStyle through comments and trailing commas', () => {
    expect(sidebarStyleFromSettings('{\n // c\n "a": "x//y", /* b */\n "stack.sidebarStyle": "mission",\n}')).toBe('mission');
  });
  it('is aside when absent, unknown, unreadable or missing', () => {
    expect(sidebarStyleFromSettings('{"editor.fontSize": 12}')).toBe('aside');
    expect(sidebarStyleFromSettings('{"stack.sidebarStyle": "neon"}')).toBe('aside');
    expect(sidebarStyleFromSettings('{ nope')).toBe('aside');
    expect(sidebarStyleFromSettings(null)).toBe('aside');
  });
  it('parseJsonc keeps strings that look like comments', () => {
    expect(parseJsonc('{"u": "http://x"}')).toEqual({ u: 'http://x' });
  });
});
