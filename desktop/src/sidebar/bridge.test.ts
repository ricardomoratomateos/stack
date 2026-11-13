import { describe, expect, it } from 'vitest';
import { describeCounts, installHint, toSidebarState, translate, type Context } from './bridge';
import { sampleState } from './fixtures';
import type { Snapshot } from '../stackd/api';

const state = sampleState(1_000_000);
const snapshot: Snapshot = { seq: 1, tmux: {}, repos: [{ repoRoot: '/r', state }, { repoRoot: '/s', state: { worktrees: [] } }] };
const ctx: Context = { repoRoot: '/r', worktrees: [...state.worktrees, state.controlSession!] };

describe('toSidebarState', () => {
  it('is the repo state with the app selection', () => {
    const s = toSidebarState(snapshot, { repoRoot: '/r', activeWorktreeId: 'rev' })!;
    expect(s.worktrees).toBe(state.worktrees);
    expect(s.controlSession).toBe(state.controlSession);
    expect(s.activeWorktreeId).toBe('rev');
  });
  it('picks the repo asked for, else the first, else nothing', () => {
    expect(toSidebarState(snapshot, { repoRoot: '/s' })!.worktrees).toEqual([]);
    expect(toSidebarState(snapshot, { repoRoot: '/nope' })!.worktrees).toBe(state.worktrees);
    expect(toSidebarState(null, {})).toBeNull();
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
  it('resuming a task is a stackd command that then shows its agent', () => {
    expect(translate({ type: 'resumeAgent', worktreeId: 'rev' }, ctx)).toEqual({ kind: 'command', name: 'resumeAgent', body: { worktreeId: 'rev' }, selectNew: 'rev' });
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
    const msg = { type: 'refreshDrift', worktreeId: 'ask' } as const;
    expect(translate(msg, ctx)).toEqual({ kind: 'command', name: 'message', body: { message: msg, repo: '/r' } });
    expect(translate({ type: 'reorderWorktrees', orderedIds: ['a'] }, ctx)).toMatchObject({ name: 'message' });
    expect(translate({ type: 'forgetWorktree', worktreeId: 'gone' }, ctx)).toMatchObject({ name: 'message' });
  });
  it('new task opens the form; createWorktree is createTask in the repo', () => {
    expect(translate({ type: 'openNewTask' }, ctx)).toEqual({ kind: 'newTask' });
    expect(translate({ type: 'createWorktree', branch: 'b', title: 't' }, ctx)).toMatchObject({ kind: 'command', name: 'createTask', body: { repo: '/r', branch: 'b', title: 't' } });
  });
  it('openDiff opens the review of that worktree', () => {
    expect(translate({ type: 'openDiff', worktreeId: 'rev' }, ctx)).toEqual({ kind: 'review', worktreeId: 'rev' });
    expect(translate({ type: 'openDiff', worktreeId: 'nope' }, ctx).kind).toBe('none');
  });
  it('openCode opens the Code tab of that worktree', () => {
    expect(translate({ type: 'openCode', worktreeId: 'rev' }, ctx)).toEqual({ kind: 'code', worktreeId: 'rev' });
    expect(translate({ type: 'openCode', worktreeId: 'nope' }, ctx).kind).toBe('none');
  });
  it('PR, ticket and port links open in the browser, https and localhost only', () => {
    const withLinks: Context = {
      repoRoot: '/r',
      worktrees: [
        { ...state.worktrees[0], id: 'l', pr: { number: 1, state: 'OPEN', url: 'https://github.com/a/b/pull/1' }, ticket: { source: 'jira', key: 'A-1', url: 'https://x.atlassian.net/browse/A-1' } },
        { ...state.worktrees[0], id: 'bad', pr: { number: 2, state: 'OPEN', url: 'file:///etc/passwd' }, ticket: { source: 'jira', key: 'A-2', url: 'javascript:alert(1)' } },
      ],
    };
    expect(translate({ type: 'openPr', worktreeId: 'l' }, withLinks)).toEqual({ kind: 'open', url: 'https://github.com/a/b/pull/1' });
    expect(translate({ type: 'openTicket', worktreeId: 'l' }, withLinks)).toEqual({ kind: 'open', url: 'https://x.atlassian.net/browse/A-1' });
    expect(translate({ type: 'openPr', worktreeId: 'bad' }, withLinks)).toEqual({ kind: 'none' });
    expect(translate({ type: 'openTicket', worktreeId: 'bad' }, withLinks)).toEqual({ kind: 'none' });
    expect(translate({ type: 'openPr', worktreeId: 'nope' }, withLinks)).toEqual({ kind: 'none' });
    expect(translate({ type: 'openPort', port: 3000 }, ctx)).toEqual({ kind: 'open', url: 'http://localhost:3000' });
    expect(translate({ type: 'openPort', port: 0 }, ctx)).toEqual({ kind: 'none' });
    expect(translate({ type: 'openPort', port: 70000 }, ctx)).toEqual({ kind: 'none' });
  });
  it('default-provider picker offers every agent; the install hint is the extension\'s', () => {
    expect(translate({ type: 'pickDefaultProvider' }, ctx)).toEqual({ kind: 'pickProvider', choices: ['claude', 'codex', 'opencode'] });
    expect(translate({ type: 'showProviderInstall', provider: 'codex' }, ctx)).toEqual({ kind: 'install', provider: 'codex' });
    expect(installHint('codex')).toEqual({ title: 'Codex CLI is not on your PATH', detail: 'Install it with:\n\nnpm i -g @openai/codex', command: 'npm i -g @openai/codex' });
  });
  it('a chosen default provider overrides the snapshot\'s in the sidebar state', () => {
    expect(toSidebarState(snapshot, { repoRoot: '/r', defaultProvider: 'codex' })!.defaultProvider).toBe('codex');
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
