import { describe, it, expect, vi } from 'vitest';
import { Emitter } from '../../src/core/Emitter';
import { sseParser } from '../../src/daemon/client/DaemonClient';
import { explicitUserSettings, stackKeys } from '../../src/daemon/client/settings';
import { RemoteService, type RemoteServiceDeps } from '../../src/daemon/client/RemoteService';
import type { Snapshot } from '../../src/daemon/StackDaemon';
import type { WorktreeItem, StackState } from '../../src/webview/types';
import { DiffError } from '../../src/ports/IGitPort';

const git = { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 };
const item = (over: Partial<WorktreeItem> & { id: string }): WorktreeItem => ({
  branch: over.id, path: `/repo/.worktrees/${over.id}`, isMain: false, deleting: false, agent: 'idle', agentCount: 0, terminalCount: 0,
  sessions: [], git, docker: [], ports: [], ...over,
});
const snap = (worktrees: WorktreeItem[], control?: WorktreeItem): Snapshot => ({
  seq: 1, tmux: {}, repos: [{ repoRoot: '/repo', state: { worktrees, controlSession: control } as StackState }],
});

function harness(initial: Snapshot) {
  const snapshots = new Emitter<Snapshot>();
  const client = {
    snapshot: initial as Snapshot | undefined,
    onSnapshot: snapshots.event,
    command: vi.fn((_name: string, _body?: Record<string, unknown>): Promise<unknown> => Promise.resolve({})),
  };
  const tab = { show: vi.fn() };
  const terminals = {
    claim: vi.fn(() => Promise.resolve()), pruneViews: vi.fn(() => Promise.resolve()),
    closeTabsExcept: vi.fn(() => Promise.resolve()), openTab: vi.fn(() => Promise.resolve(tab)),
    openViewer: vi.fn(() => tab), openViewerBeside: vi.fn(() => tab), closeViewer: vi.fn(() => Promise.resolve()),
    closeTab: vi.fn(() => Promise.resolve()), current: vi.fn(() => undefined as typeof tab | undefined),
    lastFocusedWindow: vi.fn(() => undefined), focusedWindow: vi.fn(() => undefined), targetOf: vi.fn(() => undefined),
    disposeAll: vi.fn(),
  };
  const notify = {
    showError: vi.fn(), showWarning: vi.fn(), showInfo: vi.fn(),
    confirm: vi.fn((..._a: unknown[]): Promise<string | undefined> => Promise.resolve(undefined)),
    withProgress: vi.fn(<T>(_t: string, task: (r: (m: string) => void) => Promise<T>) => task(() => {})),
  };
  const host = {
    workspaceFolderPaths: vi.fn(() => ['/repo']), addWorkspaceFolders: vi.fn(), removeWorkspaceFolder: vi.fn(), renameWorkspaceFolder: vi.fn(),
    showInputBox: vi.fn((): Promise<string | undefined> => Promise.resolve(undefined)), showQuickPick: vi.fn(), writeClipboard: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve()), openFileInEditor: vi.fn(() => Promise.resolve()), activeTerminal: vi.fn(),
  };
  const mem = new Map<string, unknown>();
  const ui = { pushWebview: vi.fn(), syncDecorations: vi.fn(), openDiffPanel: vi.fn(), openNewTask: vi.fn() };
  const service = new RemoteService({
    client, repoRoot: () => '/repo', terminals: terminals as never, notify, host: host as never,
    config: { get: () => ({ sessionTabs: 'perSession', sidebarStyle: 'classic', defaultProvider: 'claude' }) as never, setDefaultProvider: vi.fn(() => Promise.resolve()) },
    installedProviders: () => ['claude'],
    workspaceState: { get: <T>(k: string) => mem.get(k) as T | undefined, update: (k, v) => { mem.set(k, v); } },
    tabGraceMs: 0,
  } as RemoteServiceDeps);
  service.setUi(ui);
  return { service, client, snapshots, terminals, notify, host, ui, mem, tab };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('sseParser', () => {
  it('reads state events across chunk boundaries and ignores comments', () => {
    const got: number[] = [];
    const feed = sseParser((s) => got.push(s.seq));
    const frame = `event: state\ndata: ${JSON.stringify({ seq: 7, repos: [] })}\n\n`;
    feed(': keep-alive\n\n');
    feed(frame.slice(0, 10));
    feed(frame.slice(10) + frame);
    feed('event: state\ndata: {torn\n\n');
    expect(got).toEqual([7, 7]);
  });
});

describe('settings handed to the daemon', () => {
  it('takes only explicit values, narrowest scope first', () => {
    const values = explicitUserSettings((key) => ({
      claudeCommand: { globalValue: 'a', workspaceValue: 'b' },
      focusMode: { globalValue: false },
      sessionTabs: { globalValue: undefined },
    } as Record<string, object>)[key]);
    expect(values).toEqual({ claudeCommand: 'b', focusMode: false });
  });

  it('exports only stack.* keys of a Memento', () => {
    const data: Record<string, unknown> = { 'stack.a': 1, other: 2, 'stack.b': undefined };
    expect(stackKeys({ keys: () => Object.keys(data), get: <T>(k: string) => data[k] as T })).toEqual({ 'stack.a': 1 });
  });
});

describe('RemoteService', () => {
  it('renders this repo\'s state with the window\'s own selection and settings', () => {
    const h = harness(snap([item({ id: 'a' }), item({ id: 'b' })]));
    expect(h.service.buildState().worktrees.map((w) => w.id)).toEqual(['a', 'b']);
    expect(h.service.buildState().activeWorktreeId).toBeUndefined();
    expect(h.service.buildState().installedProviders).toEqual(['claude']);
    expect(h.service.windowWorktrees()).toHaveLength(2);
    // Another window's repo is not this one's.
    h.client.snapshot = { ...h.client.snapshot!, repos: [{ repoRoot: '/other', state: { worktrees: [item({ id: 'z' })] } as StackState }] };
    expect(h.service.buildState().worktrees).toEqual([]);
  });

  it('selects a worktree, remembers it, and shows its session', async () => {
    const h = harness(snap([item({ id: 'a', agentCount: 1, sessions: [{ index: 1, name: 'claude', kind: 'agent', state: 'idle' }] })]));
    await h.service.handleMessage({ type: 'selectWorktree', worktreeId: 'a' });
    expect(h.service.buildState().activeWorktreeId).toBe('a');
    expect(h.mem.get('stack.activeWorktreeId')).toBe('a');
    expect(h.terminals.openTab).toHaveBeenCalledOnce();
    expect(h.tab.show).toHaveBeenCalled();
  });

  it('sends commands for what the daemon owns, and prompts here', async () => {
    const h = harness(snap([item({ id: 'a' })]));
    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'a' });
    expect(h.client.command).toHaveBeenCalledWith('message', { message: { type: 'dockerUp', worktreeId: 'a' } });
    await h.service.handleMessage({ type: 'reorderWorktrees', orderedIds: ['a'] });
    expect(h.client.command).toHaveBeenLastCalledWith('message', { repo: '/repo', message: { type: 'reorderWorktrees', orderedIds: ['a'] } });
    h.host.showInputBox.mockResolvedValueOnce('Nice name');
    await h.service.renameWorktree({ id: 'a' });
    expect(h.client.command).toHaveBeenLastCalledWith('renameTask', { worktreeId: 'a', alias: 'Nice name' });
    expect(h.host.renameWorkspaceFolder).not.toHaveBeenCalled(); // folder not open here
  });

  it('asks before deleting, in the old words, and deletes through the daemon', async () => {
    const h = harness(snap([item({ id: 'a', git: { ...git, hasChanges: true, unstaged: 2 } })]));
    h.notify.confirm.mockResolvedValueOnce('Delete');
    await h.service.deleteWorktree({ id: 'a' });
    const [, detail] = h.notify.confirm.mock.calls[0];
    expect(detail).toContain('Uncommitted changes (2 unstaged)');
    expect(h.client.command).toHaveBeenCalledWith('deleteTask', { worktreeId: 'a', deleteBranch: false });
    expect(h.terminals.disposeAll).toHaveBeenCalledWith('a');

    h.client.command.mockClear();
    h.notify.confirm.mockResolvedValueOnce(undefined);
    await h.service.deleteWorktree({ id: 'a' });
    expect(h.client.command).not.toHaveBeenCalledWith('deleteTask', expect.anything());
  });

  it('refuses the main worktree and reports a failed create', async () => {
    const h = harness(snap([item({ id: 'm', isMain: true })]));
    await h.service.deleteWorktree({ id: 'm' });
    expect(h.notify.showWarning).toHaveBeenCalledWith('Cannot delete the main worktree.');
    h.client.command.mockImplementation((name: string) => (name === 'createTask' ? Promise.reject(new Error('branch exists')) : Promise.resolve({})));
    expect(await h.service.createWorktree({ branch: 'x', silent: true })).toEqual({ ok: false, error: 'branch exists' });
  });

  it('creates a task through the daemon, adding the repo first, and selects it', async () => {
    const h = harness(snap([]));
    h.client.command.mockImplementation((name: string) => {
      if (name === 'createTask') {
        h.client.snapshot = snap([item({ id: 'n' })]);
        return Promise.resolve({ worktree: { id: 'n' } });
      }
      return Promise.resolve({});
    });
    const r = await h.service.createWorktree({ branch: 'n', title: 'T', description: 'do it' });
    expect(r.ok).toBe(true);
    const names = h.client.command.mock.calls.map((c) => c[0]);
    expect(names.indexOf('addRepo')).toBeLessThan(names.indexOf('createTask'));
    expect(h.client.command).toHaveBeenCalledWith('createTask', expect.objectContaining({ repo: '/repo', branch: 'n', description: 'do it' }));
    expect(h.service.buildState().activeWorktreeId).toBe('n');
  });

  it('opens a tab for a session that appears later, closes tabs of windows that are gone, and adds folders', async () => {
    const h = harness(snap([item({ id: 'a', sessions: [{ index: 1, name: 'claude', kind: 'agent', state: 'idle' }], agentCount: 1 })]));
    h.snapshots.fire(h.client.snapshot!);
    await settle();
    expect(h.terminals.claim).toHaveBeenCalledOnce();
    expect(h.terminals.openTab).not.toHaveBeenCalled(); // the first snapshot is a baseline
    h.client.snapshot = snap([item({ id: 'a', sessions: [{ index: 1, name: 'claude', kind: 'agent', state: 'idle' }, { index: 2, name: 'shell', kind: 'shell', state: 'idle' }], agentCount: 1 })]);
    h.snapshots.fire(h.client.snapshot);
    await settle();
    expect(h.terminals.openTab).toHaveBeenCalledOnce();
    expect(h.terminals.openTab.mock.calls[0][1]).toBe(2);
    expect(h.terminals.closeTabsExcept).toHaveBeenLastCalledWith('a', new Set([1, 2]));
    expect(h.host.addWorkspaceFolders).toHaveBeenCalledWith({ path: '/repo/.worktrees/a', name: 'a' });
    expect(h.ui.pushWebview).toHaveBeenCalled();
  });

  it('turns changes of agent state into attention events, the first sighting being a baseline', async () => {
    const h = harness(snap([item({ id: 'a', agent: 'active' })]));
    const seen: Array<[string, string]> = [];
    h.service.onStateChange((e) => seen.push([e.worktreeId, e.state]));
    h.snapshots.fire(h.client.snapshot!);
    await settle();
    h.client.snapshot = snap([item({ id: 'a', agent: 'permission' })]);
    h.snapshots.fire(h.client.snapshot);
    await settle();
    expect(seen).toEqual([['a', 'active'], ['a', 'permission']]);
  });

  it('serves the review panel: diff errors keep their type, clipboard stays local', async () => {
    const h = harness(snap([item({ id: 'a', alias: 'Alias', agentCount: 1 })]));
    expect(h.service.getContext('a')).toEqual({ label: 'Alias', hasLiveAgent: true });
    h.client.command.mockResolvedValueOnce({ unified: 'diff --git' });
    expect(await h.service.getDiff('a', 'branch')).toBe('diff --git');
    h.client.command.mockRejectedValueOnce(new Error("couldn't compute the diff: bad ref"));
    await expect(h.service.getDiff('a', 'branch')).rejects.toBeInstanceOf(DiffError);
    const comments = [{ file: 'a.ts', line: 1, side: 'new', code: 'x', body: 'fix' }] as never;
    expect(await h.service.send('a', 'clipboard', comments)).toBe('clipboard');
    expect(h.host.writeClipboard).toHaveBeenCalled();
    h.client.command.mockResolvedValueOnce({ went: 'new' });
    expect(await h.service.send('a', 'live', comments)).toBe('new');
    expect(h.client.command).toHaveBeenLastCalledWith('sendComments', expect.objectContaining({ worktreeId: 'a', destination: 'live' }));
  });
});
