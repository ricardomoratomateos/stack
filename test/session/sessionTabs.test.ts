import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { window, resetVscodeMock, makeTerminal, FakeMemento, TerminalLocation, ViewColumn, ThemeIcon, TabInputTerminal } from '../__mocks__/vscode';
import type { MockTerminal } from '../__mocks__/vscode';
import { AgentSessionManager } from '../../src/session/AgentSessionManager';
import { SessionTerminals } from '../../src/session/SessionTerminals';
import type { SessionTabsMode } from '../../src/session/SessionTerminals';
import { TmuxManager } from '../../src/session/TmuxManager';
import { ProviderFactory } from '../../src/providers/ProviderFactory';
import type { ConfigSource } from '../../src/providers/claude/ClaudeProvider';
import type { ISessionManager } from '../../src/ports/ISessionManager';
import type { Worktree } from '../../src/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const wt: Worktree = {
  id: 'wt-1', branch: 'feat/login', path: '/nonexistent/wt-1', repoRoot: '/nonexistent/repo',
  debugPort: 9898, dockerProjectName: 'feat-login', createdAt: 0,
};
const wt2: Worktree = { ...wt, id: 'wt-2', branch: 'feat/login-v2', path: '/nonexistent/wt-2' };
const SESSION = 'stack-wt-1';
const view = (index: number, base = SESSION) => TmuxManager.viewSessionName(base, index);

type Fn = ReturnType<typeof vi.fn>;

function makeStub(): ISessionManager & Record<string, Fn> {
  return {
    hasSession: vi.fn().mockResolvedValue(false),
    ensureSession: vi.fn().mockResolvedValue(undefined),
    newWindow: vi.fn().mockResolvedValue(1),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    paste: vi.fn().mockResolvedValue(undefined),
    pressEnter: vi.fn().mockResolvedValue(undefined),
    respawnWindow: vi.fn().mockResolvedValue(undefined),
    selectWindow: vi.fn().mockResolvedValue(undefined),
    killWindow: vi.fn().mockResolvedValue(undefined),
    // A killed view takes its client — the terminal's process — with it.
    killSession: vi.fn(async (name: string) => {
      for (const t of window.terminals) {
        if (TmuxManager.sessionOfAttachArgs(t.creationOptions.shellArgs) === name) t.exitStatus = { code: 0 };
      }
    }),
    detachClients: vi.fn(async (name: string) => {
      for (const t of window.terminals) {
        if (TmuxManager.sessionOfAttachArgs(t.creationOptions.shellArgs) === name) t.exitStatus = { code: 0 };
      }
    }),
    listWindows: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    listClients: vi.fn().mockResolvedValue([]),
    hasChildProcess: vi.fn().mockResolvedValue(false),
    processCommandLine: vi.fn().mockRejectedValue(new Error('no ps in unit tests')),
  } as unknown as ISessionManager & Record<string, Fn>;
}

function makeFactory(): ProviderFactory {
  const config = { get: () => ({ claudeCommand: 'claude', opencodeCommand: 'opencode', defaultProvider: 'claude' }) } as unknown as ConfigSource;
  return new ProviderFactory(config, '/tmp/stack-test-storage');
}

function create(mode: SessionTabsMode = 'perSession') {
  const stub = makeStub();
  let current = mode;
  const mgr = new AgentSessionManager(
    makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub, () => true, 'Test-Host.local', async () => {},
    () => current,
  );
  return { mgr, stub, setMode: (m: SessionTabsMode) => { current = m; } };
}

/** The listener the manager registered on a vscode.window event (the last one). */
function listener(event: Fn): (arg: unknown) => void {
  return event.mock.calls.at(-1)![0] as (arg: unknown) => void;
}

/** Launch an agent (or open a shell) at a given window index. */
async function open(mgr: AgentSessionManager, stub: Record<string, Fn>, index: number, kind: 'agent' | 'shell' = 'agent', w = wt) {
  stub.newWindow.mockResolvedValueOnce(index);
  return (kind === 'agent' ? mgr.launch(w) : mgr.openTerminal(w)) as unknown as Promise<MockTerminal>;
}

beforeEach(() => { resetVscodeMock(); });
afterEach(() => { vi.useRealTimers(); });

// ── A tab per session ─────────────────────────────────────────────────────────

describe('perSession: a terminal tab per session', () => {
  it('launch opens the agent in a tab of its own, attached through its view session', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 3);
    expect(tab.creationOptions).toEqual({
      name: 'feat/login · claude',
      cwd: wt.path,
      location: TerminalLocation.Editor,
      iconPath: new ThemeIcon('hubot'),
      shellPath: 'tmux',
      shellArgs: TmuxManager.viewAttachArgs(SESSION, 3),
    });
    expect(tab.show).toHaveBeenCalled();
    // The base still follows, so single mode and an unaimed paste agree.
    expect(stub.selectWindow).toHaveBeenCalledWith(SESSION, 3);
    expect(mgr.getTargetForTerminal(tab as never)).toEqual({ worktreeId: 'wt-1', windowIndex: 3 });
  });

  it('a shell gets its own tab, with a terminal icon, next to the agent — both open at once', async () => {
    const { mgr, stub } = create();
    const agent = await open(mgr, stub, 1);
    const shell = await open(mgr, stub, 2, 'shell');
    expect(shell).not.toBe(agent);
    expect(shell.name).toBe('feat/login · shell');
    expect(shell.creationOptions.iconPath).toEqual(new ThemeIcon('terminal'));
    expect(agent.dispose).not.toHaveBeenCalled();
    expect(mgr.getWorktreeIdForTerminal(agent as never)).toBe('wt-1');
    expect(mgr.getWorktreeIdForTerminal(shell as never)).toBe('wt-1');
    expect(mgr.getTargetForTerminalName('feat/login · shell')).toEqual({ worktreeId: 'wt-1', windowIndex: 2 });
    expect(mgr.getWorktreeIdForTerminalName('feat/login · claude')).toBe('wt-1');
    expect(mgr.getTargetForTerminalName('feat/login · claude 7')).toBeUndefined();
  });

  it('keeps tab names unique, so a tab label always leads back to one session', async () => {
    const { mgr, stub } = create();
    await open(mgr, stub, 1);
    const second = await open(mgr, stub, 2);
    const third = await open(mgr, stub, 3);
    expect(second.name).toBe('feat/login · claude 2');
    expect(third.name).toBe('feat/login · claude 3');
  });

  it('names a tab after the session\'s alias when it has one', async () => {
    const { mgr, stub } = create();
    await open(mgr, stub, 2, 'shell');
    mgr.setSessionAlias('wt-1', 2, 'redis');
    await mgr.closeViewer('wt-1');
    const tab = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(tab.name).toBe('feat/login · redis');
  });

  it('focusWindow shows the session\'s existing tab — never a second one', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    await open(mgr, stub, 2, 'shell');
    tab.show.mockClear();
    window.createTerminal.mockClear();
    await mgr.focusWindow(wt, 1);
    expect(window.createTerminal).not.toHaveBeenCalled();
    expect(tab.show).toHaveBeenCalledTimes(1);
    expect(mgr.getViewer('wt-1')).toBe(tab);
  });

  it('focusWindow reopens a session whose tab was closed', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    listener(window.onDidCloseTerminal)(tab);
    const again = await mgr.focusWindow(wt, 1).then(() => mgr.getViewer('wt-1')) as unknown as MockTerminal;
    expect(again).not.toBe(tab);
    expect(again.creationOptions.shellArgs).toEqual(TmuxManager.viewAttachArgs(SESSION, 1));
  });

  it('focusWindow on a window Stack does not track brings the worktree forward instead', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    window.createTerminal.mockClear();
    await mgr.focusWindow(wt, 9);
    expect(window.createTerminal).not.toHaveBeenCalled();
    expect(tab.show).toHaveBeenCalled();
  });

  it('two requests for one session at once still make one tab', async () => {
    const { mgr, stub } = create();
    await open(mgr, stub, 1);
    listener(window.onDidCloseTerminal)(mgr.getViewer('wt-1'));
    window.createTerminal.mockClear();
    await Promise.all([mgr.focusWindow(wt, 1), mgr.focusWindow(wt, 1)]);
    expect(window.createTerminal).toHaveBeenCalledTimes(1);
  });

  it('sendPromptToAgent shows THAT agent\'s tab, not whichever is in front', async () => {
    const { mgr, stub } = create();
    const agent = await open(mgr, stub, 1);
    const shell = await open(mgr, stub, 2, 'shell');
    agent.show.mockClear();
    stub.listWindows.mockResolvedValue([{ index: 1, name: 'claude', command: 'node', pid: 101 }]);
    expect(await mgr.sendPromptToAgent(wt, 'hi')).toBe(true);
    expect(agent.show).toHaveBeenCalled();
    expect(shell.show).toHaveBeenCalledTimes(1); // only when it was opened
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:1`, 'hi');
  });

  it('a mode change applies to the next terminal opened, without a reload', async () => {
    const { mgr, stub, setMode } = create('single');
    const viewer = await open(mgr, stub, 1);
    expect(viewer.creationOptions.shellArgs).toEqual(TmuxManager.attachArgs(SESSION));
    setMode('perSession');
    const tab = await open(mgr, stub, 2, 'shell');
    expect(tab.creationOptions.shellArgs).toEqual(TmuxManager.viewAttachArgs(SESSION, 2));
  });
});

// ── The worktree as a whole ───────────────────────────────────────────────────

describe('perSession: bringing a worktree forward', () => {
  it('with no session yet, there is no tab to give: the single viewer, as before', async () => {
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(viewer.creationOptions.shellArgs).toEqual(TmuxManager.attachArgs(SESSION));
    expect(mgr.getTargetForTerminal(viewer as never)).toEqual({ worktreeId: 'wt-1' });
  });

  it('returns the tab the user was last in', async () => {
    const { mgr, stub } = create();
    const agent = await open(mgr, stub, 1);
    await open(mgr, stub, 2, 'shell');
    listener(window.onDidChangeActiveTerminal)(agent);
    expect(await mgr.getOrCreateViewer(wt)).toBe(agent);
    expect(mgr.getViewer('wt-1')).toBe(agent);
    expect(mgr.focusedSession('wt-1')).toBe(1);
  });

  it('falls back to any open tab when the last one was closed', async () => {
    const { mgr, stub } = create();
    const agent = await open(mgr, stub, 1);
    const shell = await open(mgr, stub, 2, 'shell');
    listener(window.onDidCloseTerminal)(shell);
    expect(mgr.getViewer('wt-1')).toBe(agent);
  });

  it('ignores focus moving to terminals that are not session tabs', async () => {
    const { mgr, stub } = create();
    const shell = await open(mgr, stub, 2, 'shell');
    listener(window.onDidChangeActiveTerminal)(undefined);
    listener(window.onDidChangeActiveTerminal)(makeTerminal({ name: 'zsh' }));
    expect(mgr.getViewer('wt-1')).toBe(shell);
  });

  it('with no tab open, opens the session last focused, if it is still there', async () => {
    const { mgr, stub } = create();
    await open(mgr, stub, 1);
    const shell = await open(mgr, stub, 2, 'shell');
    listener(window.onDidCloseTerminal)(mgr.getViewer('wt-1'));
    listener(window.onDidCloseTerminal)(window.terminals[0]);
    const reopened = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(reopened).not.toBe(shell);
    expect(reopened.creationOptions.shellArgs).toEqual(TmuxManager.viewAttachArgs(SESSION, 2));
  });

  it('else the first session in the card\'s order', async () => {
    const { mgr, stub } = create();
    await open(mgr, stub, 1);
    await open(mgr, stub, 2, 'shell');
    await mgr.killWindow('wt-1', 2); // the last focused one is gone
    listener(window.onDidCloseTerminal)(mgr.getViewer('wt-1'));
    const opened = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(opened.creationOptions.shellArgs).toEqual(TmuxManager.viewAttachArgs(SESSION, 1));
  });

  it('focus() shows the tab in front, and is a no-op for a worktree without one', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    tab.show.mockClear();
    mgr.focus('wt-1');
    expect(tab.show).toHaveBeenCalledTimes(1);
    expect(() => mgr.focus('nope')).not.toThrow();
  });

  it('focusedSession falls back to the first session when no tab is open, and is undefined with none', async () => {
    const { mgr, stub } = create();
    expect(mgr.focusedSession('wt-1')).toBeUndefined();
    await open(mgr, stub, 4, 'shell');
    listener(window.onDidCloseTerminal)(mgr.getViewer('wt-1'));
    expect(mgr.focusedSession('wt-1')).toBe(4);
  });
});

// ── Focus mode ────────────────────────────────────────────────────────────────

describe('perSession: closeViewer (focus mode) and coming back', () => {
  it('closes every tab of the worktree through its view session, leaving the sessions running', async () => {
    const { mgr, stub } = create();
    const agent = await open(mgr, stub, 1);
    const shell = await open(mgr, stub, 2, 'shell');
    await mgr.closeViewer('wt-1');
    expect(stub.killSession).toHaveBeenCalledWith(view(1));
    expect(stub.killSession).toHaveBeenCalledWith(view(2));
    expect(stub.killSession).not.toHaveBeenCalledWith(SESSION);
    expect(stub.killWindow).not.toHaveBeenCalled();
    expect(agent.dispose).toHaveBeenCalled();
    expect(shell.dispose).toHaveBeenCalled();
    expect(mgr.getViewer('wt-1')).toBeUndefined();
    expect(mgr.hasTerminals('wt-1')).toBe(true);
  });

  it('reopens them in the editor groups they sat in, the focused one last so it ends up in front', async () => {
    const { mgr, stub } = create();
    const agent = await open(mgr, stub, 1);
    const shell = await open(mgr, stub, 2, 'shell');
    listener(window.onDidChangeActiveTerminal)(agent);
    window.tabGroups.all = [
      { viewColumn: 1, tabs: [{ input: new TabInputTerminal(), label: agent.name }] },
      { viewColumn: 2, tabs: [{ input: {}, label: shell.name }, { input: new TabInputTerminal(), label: shell.name }] },
    ];
    await mgr.closeViewer('wt-1');
    window.createTerminal.mockClear();

    const front = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    const created = window.createTerminal.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(created.map((o) => [o.shellArgs, o.location])).toEqual([
      [TmuxManager.viewAttachArgs(SESSION, 2), { viewColumn: 2 }],
      [TmuxManager.viewAttachArgs(SESSION, 1), { viewColumn: 1 }],
    ]);
    expect(front.creationOptions.shellArgs).toEqual(TmuxManager.viewAttachArgs(SESSION, 1));
    // Handed back once: a later close-and-reopen starts from what is open then.
    expect(await mgr.getOrCreateViewer(wt)).toBe(front);
  });

  it('a tab whose group cannot be found reopens in the active group; a session gone meanwhile does not reopen', async () => {
    const { mgr, stub } = create();
    await open(mgr, stub, 1);
    await open(mgr, stub, 2, 'shell');
    await mgr.closeViewer('wt-1');
    await mgr.killWindow('wt-1', 2);
    window.createTerminal.mockClear();
    await mgr.getOrCreateViewer(wt);
    expect(window.createTerminal).toHaveBeenCalledTimes(1);
    expect(window.createTerminal.mock.calls[0][0]).toMatchObject({
      shellArgs: TmuxManager.viewAttachArgs(SESSION, 1),
      location: TerminalLocation.Editor,
    });
  });

  it('disposes after the deadline when a tab\'s client does not exit', async () => {
    vi.useFakeTimers();
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    stub.killSession.mockResolvedValue(undefined); // the client hangs on
    const done = mgr.closeViewer('wt-1');
    await vi.advanceTimersByTimeAsync(300);
    expect(tab.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(tab.dispose).toHaveBeenCalledTimes(1);
  });

  it('a tab that already exited is just forgotten', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    tab.exitStatus = { code: 0 };
    await mgr.killWindow('wt-1', 1);
    expect(stub.killSession).not.toHaveBeenCalled();
    expect(tab.dispose).not.toHaveBeenCalled();
  });
});

// ── To the side ───────────────────────────────────────────────────────────────

describe('Open Session to the Side', () => {
  it('opens a session with no tab beside the active group', async () => {
    const { mgr, stub } = create();
    await open(mgr, stub, 1);
    await open(mgr, stub, 2, 'shell');
    listener(window.onDidCloseTerminal)(mgr.getViewer('wt-1'));
    window.createTerminal.mockClear();
    await mgr.focusWindow(wt, 2, { beside: true });
    expect(window.createTerminal.mock.calls[0][0]).toMatchObject({
      shellArgs: TmuxManager.viewAttachArgs(SESSION, 2),
      location: { viewColumn: ViewColumn.Beside },
    });
  });

  it('moves an open tab: closed through its view, reopened beside', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    window.createTerminal.mockClear();
    await mgr.focusWindow(wt, 1, { beside: true });
    expect(stub.killSession).toHaveBeenCalledWith(view(1));
    expect(tab.dispose).toHaveBeenCalled();
    const moved = mgr.getViewer('wt-1') as unknown as MockTerminal;
    expect(moved).not.toBe(tab);
    expect(moved.creationOptions.location).toEqual({ viewColumn: ViewColumn.Beside });
    expect(moved.show).toHaveBeenCalled();
    // Disposing the old one must not take the new one out of the books.
    listener(window.onDidCloseTerminal)(tab);
    expect(mgr.getViewer('wt-1')).toBe(moved);
  });

  it('single mode moves the worktree\'s viewer beside', async () => {
    const { mgr, stub } = create('single');
    const viewer = await open(mgr, stub, 1);
    await mgr.focusWindow(wt, 1, { beside: true });
    expect(stub.detachClients).toHaveBeenCalledWith(SESSION);
    expect(viewer.dispose).toHaveBeenCalled();
    const moved = mgr.getViewer('wt-1') as unknown as MockTerminal;
    expect(moved.creationOptions).toMatchObject({
      location: { viewColumn: ViewColumn.Beside },
      shellArgs: TmuxManager.attachArgs(SESSION),
    });
  });
});

// ── Killing ───────────────────────────────────────────────────────────────────

describe('perSession: sessions ending', () => {
  it('killWindow closes the tab first, while its view still shows that window', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    await mgr.killWindow('wt-1', 1);
    expect(stub.killSession).toHaveBeenCalledWith(view(1));
    expect(stub.killSession.mock.invocationCallOrder[0]).toBeLessThan(stub.killWindow.mock.invocationCallOrder[0]);
    expect(tab.dispose).toHaveBeenCalled();
  });

  it('a window found gone by the poller takes its tab with it', async () => {
    const { mgr, stub } = create();
    const agent = await open(mgr, stub, 1);
    const shell = await open(mgr, stub, 2, 'shell');
    stub.listWindows.mockResolvedValue([{ index: 1, name: 'claude', command: 'node' }]);
    await mgr.syncWindows('wt-1');
    await vi.waitFor(() => expect(shell.dispose).toHaveBeenCalled());
    expect(stub.killSession).toHaveBeenCalledWith(view(2));
    expect(agent.dispose).not.toHaveBeenCalled();
  });

  it('killWorktreeSession kills the worktree\'s views before its base, and no one else\'s', async () => {
    const { mgr, stub } = create();
    const tab = await open(mgr, stub, 1);
    stub.listSessions.mockResolvedValue([
      { name: SESSION, attached: 0 },
      { name: view(1), attached: 1 },
      { name: view(4), attached: 0 },
      { name: view(1, 'stack-wt-2'), attached: 1 },
      { name: 'work', attached: 1 },
    ]);
    await mgr.killWorktreeSession('wt-1');
    const killed = stub.killSession.mock.calls.map((c) => c[0]);
    expect(killed).toEqual([view(1), view(4), SESSION]);
    expect(tab.dispose).toHaveBeenCalled();
    expect(mgr.getViewer('wt-1')).toBeUndefined();
  });

  it('killWorktreeSession survives tmux failing to list sessions', async () => {
    const { mgr, stub } = create();
    stub.listSessions.mockRejectedValue(new Error('no server'));
    await mgr.killWorktreeSession('wt-1');
    expect(stub.killSession).toHaveBeenCalledWith(SESSION);
  });
});

// ── Pasting ───────────────────────────────────────────────────────────────────

describe('pasteToActiveWindow', () => {
  it('aims at the window it is given', async () => {
    const { mgr, stub } = create();
    await mgr.pasteToActiveWindow('wt-1', 'x', 4);
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:4`, 'x');
  });

  it('per session, without one: the window of the tab in front', async () => {
    const { mgr, stub } = create();
    await open(mgr, stub, 1);
    await open(mgr, stub, 2, 'shell');
    await mgr.pasteToActiveWindow('wt-1', 'x');
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:2`, 'x');
  });

  it('single mode, without one: the session itself — its current window is what the viewer shows', async () => {
    const { mgr, stub } = create('single');
    await open(mgr, stub, 1);
    await mgr.pasteToActiveWindow('wt-1', 'x');
    expect(stub.paste).toHaveBeenCalledWith(SESSION, 'x');
  });
});

// ── Reload ────────────────────────────────────────────────────────────────────

describe('reconnect: claiming restored terminals exactly', () => {
  function reloaded(windows: Array<{ index: number; name: string }>) {
    const h = create();
    h.stub.hasSession.mockImplementation(async (name: string) => name === SESSION);
    h.stub.listWindows.mockResolvedValue(windows);
    return h;
  }

  it('claims a restored tab by the view session in its launch argv', async () => {
    const { mgr } = reloaded([{ index: 1, name: 'claude' }, { index: 2, name: 'shell' }]);
    const tab = makeTerminal({ name: 'feat/login · shell', shellPath: 'tmux', shellArgs: TmuxManager.viewAttachArgs(SESSION, 2) });
    window.terminals = [tab];
    await mgr.reconnect([wt]);
    expect(mgr.getTargetForTerminal(tab as never)).toEqual({ worktreeId: 'wt-1', windowIndex: 2 });
    expect(mgr.getViewer('wt-1')).toBe(tab);
  });

  it('claims by the tmux client behind its process when the argv is not there to read', async () => {
    const { mgr, stub } = reloaded([{ index: 1, name: 'claude' }]);
    const tab = makeTerminal({ name: 'renamed by the user' });
    tab.processId = Promise.resolve(4242);
    const stranger = makeTerminal({ name: 'zsh' });
    stranger.processId = Promise.resolve(7);
    const failing = makeTerminal({ name: 'broken' });
    failing.processId = Promise.reject(new Error('gone'));
    window.terminals = [stranger, failing, tab];
    stub.listClients.mockResolvedValue([{ pid: 4242, session: view(1) }, { pid: 9, session: SESSION }]);
    await mgr.reconnect([wt]);
    expect(mgr.getTargetForTerminal(tab as never)).toEqual({ worktreeId: 'wt-1', windowIndex: 1 });
    expect(mgr.getTargetForTerminal(stranger as never)).toBeUndefined();
    expect(stub.listClients).toHaveBeenCalledTimes(1); // asked once for the lot
  });

  it('claims a single-mode viewer by its session, including the old /bin/sh form', async () => {
    const { mgr } = reloaded([{ index: 1, name: 'claude' }]);
    const legacy = makeTerminal({ name: 'whatever', shellPath: '/bin/sh', shellArgs: ['-c', `tmux attach -t "${SESSION}"`] });
    window.terminals = [legacy];
    await mgr.reconnect([wt]);
    expect(mgr.getTargetForTerminal(legacy as never)).toEqual({ worktreeId: 'wt-1' });
  });

  it('never lets "feat" take "feat-login"\'s terminal: the name fallback is anchored at the separator', async () => {
    const { mgr } = reloaded([]);
    const feat = { ...wt, id: 'wt-feat', branch: 'feat' };
    const theirs = makeTerminal({ name: 'feat-login — claude' });
    const theirsBare = makeTerminal({ name: 'feat-login' });
    const ours = makeTerminal({ name: 'feat — claude' });
    window.terminals = [theirs, theirsBare, ours];
    await mgr.reconnect([feat, { ...wt2, branch: 'feat-login' }]);
    expect(mgr.getViewer('wt-feat')).toBe(ours);
    expect(mgr.getViewer('wt-2')).toBe(theirs);
  });

  it('leaves alone a terminal attached to a session of a worktree it does not know, or already tracked', async () => {
    const { mgr } = reloaded([{ index: 1, name: 'claude' }]);
    const other = makeTerminal({ name: 'x', shellArgs: TmuxManager.attachArgs('stack-elsewhere') });
    const otherTab = makeTerminal({ name: 'y', shellArgs: TmuxManager.viewAttachArgs('stack-elsewhere', 1) });
    const twinViewer = [makeTerminal({ name: 'a', shellArgs: TmuxManager.attachArgs(SESSION) }), makeTerminal({ name: 'b', shellArgs: TmuxManager.attachArgs(SESSION) })];
    const twinTab = [makeTerminal({ name: 'c', shellArgs: TmuxManager.viewAttachArgs(SESSION, 1) }), makeTerminal({ name: 'd', shellArgs: TmuxManager.viewAttachArgs(SESSION, 1) })];
    window.terminals = [other, otherTab, ...twinViewer, ...twinTab];
    await mgr.reconnect([wt]);
    expect(mgr.getTargetForTerminal(other as never)).toBeUndefined();
    expect(mgr.getTargetForTerminal(otherTab as never)).toBeUndefined();
    expect(mgr.getTargetForTerminal(twinViewer[0] as never)).toEqual({ worktreeId: 'wt-1' });
    expect(mgr.getTargetForTerminal(twinViewer[1] as never)).toBeUndefined();
    expect(mgr.getTargetForTerminal(twinTab[0] as never)).toEqual({ worktreeId: 'wt-1', windowIndex: 1 });
    expect(mgr.getTargetForTerminal(twinTab[1] as never)).toBeUndefined();
  });

  it('closes a restored tab whose window is gone — its view would show something else', async () => {
    const { mgr, stub } = reloaded([{ index: 1, name: 'claude' }]);
    const gone = makeTerminal({ name: 'feat/login · shell', shellArgs: TmuxManager.viewAttachArgs(SESSION, 2) });
    window.terminals = [gone];
    await mgr.reconnect([wt]);
    expect(stub.killSession).toHaveBeenCalledWith(view(2));
    expect(gone.dispose).toHaveBeenCalled();
    expect(mgr.getTargetForTerminal(gone as never)).toBeUndefined();
  });

  it('prunes leaked views: unattached ones and those whose base is gone, nothing else', async () => {
    const { mgr, stub } = reloaded([]);
    stub.listSessions.mockResolvedValue([
      { name: SESSION, attached: 0 },
      { name: view(1), attached: 1 },
      { name: view(2), attached: 0 },
      { name: view(1, 'stack-gone'), attached: 1 },
      { name: 'stack-other', attached: 0 },
      { name: 'work', attached: 0 },
    ]);
    await mgr.reconnect([wt]);
    expect(stub.killSession.mock.calls.map((c) => c[0])).toEqual([view(2), view(1, 'stack-gone')]);
  });

  it('tolerates tmux failing to list clients or sessions', async () => {
    const { mgr, stub } = reloaded([]);
    stub.listClients.mockRejectedValue(new Error('no server'));
    stub.listSessions.mockRejectedValue(new Error('no server'));
    const t = makeTerminal({ name: 'zsh' });
    t.processId = Promise.resolve(5);
    window.terminals = [t];
    await expect(mgr.reconnect([wt])).resolves.toBeUndefined();
    expect(mgr.getTargetForTerminal(t as never)).toBeUndefined();
  });

  it('remembers the restored tab that is focused as the one in front', async () => {
    const { mgr } = reloaded([{ index: 1, name: 'claude' }, { index: 2, name: 'shell' }]);
    const one = makeTerminal({ name: 'a', shellArgs: TmuxManager.viewAttachArgs(SESSION, 1) });
    const two = makeTerminal({ name: 'b', shellArgs: TmuxManager.viewAttachArgs(SESSION, 2) });
    window.terminals = [one, two];
    window.activeTerminal = two;
    await mgr.reconnect([wt]);
    expect(mgr.getViewer('wt-1')).toBe(two);
  });

  it('does not wait forever on a terminal whose process never reports', async () => {
    vi.useFakeTimers();
    const { mgr } = reloaded([]);
    const stuck = makeTerminal({ name: 'stuck' });
    stuck.processId = new Promise<number>(() => {});
    window.terminals = [stuck];
    const done = mgr.reconnect([wt]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
  });

  it('claims a terminal VS Code revives after reconnect ran', async () => {
    const { mgr } = reloaded([{ index: 1, name: 'claude' }]);
    await mgr.reconnect([wt]);
    const revived = makeTerminal({ name: 'feat/login · claude', shellArgs: TmuxManager.viewAttachArgs(SESSION, 1) });
    listener(window.onDidOpenTerminal)(revived);
    await vi.waitFor(() => expect(mgr.getTargetForTerminal(revived as never)).toEqual({ worktreeId: 'wt-1', windowIndex: 1 }));
    // Its own terminals open through the same event, and are left as they are.
    const before = mgr.getViewer('wt-1');
    listener(window.onDidOpenTerminal)(revived);
    const exited = makeTerminal({ name: 'x', shellArgs: TmuxManager.viewAttachArgs(SESSION, 1) });
    exited.exitStatus = { code: 1 };
    listener(window.onDidOpenTerminal)(exited);
    await new Promise((r) => setTimeout(r, 0));
    expect(mgr.getViewer('wt-1')).toBe(before);
    expect(mgr.getTargetForTerminal(exited as never)).toBeUndefined();
  });

  it('a late terminal with no argv to read is placed by its tmux client', async () => {
    const { mgr, stub } = reloaded([{ index: 1, name: 'claude' }]);
    await mgr.reconnect([wt]);
    stub.listClients.mockResolvedValue([{ pid: 31, session: view(1) }]);
    const revived = makeTerminal({ name: 'feat/login · claude' });
    revived.processId = Promise.resolve(31);
    listener(window.onDidOpenTerminal)(revived);
    await vi.waitFor(() => expect(mgr.getTargetForTerminal(revived as never)).toEqual({ worktreeId: 'wt-1', windowIndex: 1 }));
    // And one tmux cannot place is not claimed, whatever its name.
    stub.listClients.mockRejectedValue(new Error('no server'));
    const stray = makeTerminal({ name: 'feat/login' });
    stray.processId = Promise.resolve(32);
    listener(window.onDidOpenTerminal)(stray);
    await new Promise((r) => setTimeout(r, 0));
    expect(mgr.getTargetForTerminal(stray as never)).toBeUndefined();
  });
});

// ── SessionTerminals on its own ───────────────────────────────────────────────

describe('SessionTerminals', () => {
  it('stops listening when disposed', () => {
    const terminals = new SessionTerminals(makeStub(), () => true);
    const subs = [window.onDidCloseTerminal, window.onDidChangeActiveTerminal, window.onDidOpenTerminal]
      .map((e) => e.mock.results.at(-1)!.value as { dispose: Fn });
    terminals.dispose();
    for (const s of subs) expect(s.dispose).toHaveBeenCalled();
  });

  it('opens a tab without a cwd when the worktree directory is missing', async () => {
    const terminals = new SessionTerminals(makeStub(), () => false);
    const tab = await terminals.openTab(wt, 1, { label: 'feat/login', session: 'claude', kind: 'agent' }) as unknown as MockTerminal;
    expect(tab.creationOptions.cwd).toBeUndefined();
  });

  it('a request while a tab is still being created waits for that one', async () => {
    const stub = makeStub();
    const terminals = new SessionTerminals(stub, () => true);
    const info = { label: 'feat/login', session: 'claude', kind: 'agent' as const };
    const first = await terminals.openTab(wt, 1, info);
    // Moving it is async (its view is killed first); a request meanwhile joins it.
    const moving = terminals.openTab(wt, 1, info, { beside: true });
    const joined = terminals.openTab(wt, 1, info);
    expect(await joined).toBe(await moving);
    expect(await moving).not.toBe(first);
  });

  it('forgets nothing when an unknown terminal closes', () => {
    const terminals = new SessionTerminals(makeStub(), () => true);
    expect(() => listener(window.onDidCloseTerminal)(makeTerminal())).not.toThrow();
    expect(terminals.targetOfName('nope')).toBeUndefined();
  });
});
