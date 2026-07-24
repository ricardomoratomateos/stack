import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { window, resetVscodeMock, makeTerminal, FakeMemento, TerminalLocation } from '../__mocks__/vscode';
import type { MockTerminal } from '../__mocks__/vscode';
import { AgentSessionManager } from '../../src/session/AgentSessionManager';
import { ProviderFactory } from '../../src/providers/ProviderFactory';
import type { ConfigSource } from '../../src/providers/claude/ClaudeProvider';
import type { ISessionManager } from '../../src/ports/ISessionManager';
import type { AgentSessionState, Worktree } from '../../src/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const wt: Worktree = {
  id: 'wt-1',
  branch: 'feat/login',
  path: '/nonexistent/wt-1',
  repoRoot: '/nonexistent/repo',
  xdebugPort: 9898,
  dockerProjectName: 'feat-login',
  createdAt: 0,
};
const SESSION = 'unmess-wt-1'; // TmuxManager.sessionName('wt-1')

const wt2: Worktree = {
  id: 'wt-2',
  branch: 'other',
  path: '/nonexistent/wt-2',
  repoRoot: '/nonexistent/repo',
  xdebugPort: 9899,
  dockerProjectName: 'other',
  createdAt: 0,
};

function makeStub(): ISessionManager {
  return {
    hasSession: vi.fn().mockResolvedValue(false),
    ensureSession: vi.fn().mockResolvedValue(undefined),
    newWindow: vi.fn().mockResolvedValue(1),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    paste: vi.fn().mockResolvedValue(undefined),
    respawnWindow: vi.fn().mockResolvedValue(undefined),
    selectWindow: vi.fn().mockResolvedValue(undefined),
    killWindow: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    detachClients: vi.fn().mockResolvedValue(undefined),
    listWindows: vi.fn().mockResolvedValue([]),
  };
}

function makeFactory(claudeCommand = 'claude'): ProviderFactory {
  const config = { get: () => ({ claudeCommand, opencodeCommand: 'opencode', defaultProvider: 'claude' }) } as unknown as ConfigSource;
  return new ProviderFactory(config, '/tmp/unmess-test-storage');
}

function create(claudeCommand = 'claude', memento: vscode.Memento = new FakeMemento() as unknown as vscode.Memento) {
  const stub = makeStub();
  // Default: worktree directories exist, deterministic hostname. Individual tests override as needed.
  const mgr = new AgentSessionManager(makeFactory(claudeCommand), memento, stub, () => true, 'Test-Host.local');
  const stateEvents: Array<{ worktreeId: string; state: AgentSessionState }> = [];
  let terminalsChanges = 0;
  mgr.onStateChange(e => stateEvents.push(e));
  mgr.onTerminalsChange(() => terminalsChanges++);
  return { mgr, stub, stateEvents, getTerminalsChanges: () => terminalsChanges, memento };
}

/** Seed the private windows map directly (state combinations unreachable via public API). */
function seed(mgr: AgentSessionManager, worktreeId: string, entries: Array<[number, { kind: 'agent' | 'shell'; provider?: 'claude'; state: AgentSessionState; name: string }]>) {
  const map = (mgr as unknown as { windowMap(id: string): Map<number, unknown> }).windowMap(worktreeId);
  for (const [idx, meta] of entries) map.set(idx, meta);
}

beforeEach(() => {
  resetVscodeMock();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── aggregateState ────────────────────────────────────────────────────────────

describe('aggregateState', () => {
  it('returns idle with no windows', () => {
    const { mgr } = create();
    expect(mgr.getState('unknown')).toBe('idle');
  });

  it('ignores shell windows (claude only)', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'shell', state: 'active', name: 'shell' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    expect(mgr.getState('wt-1')).toBe('waiting');
  });

  it('returns idle when only shell windows exist', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'active', name: 'shell' }]]);
    expect(mgr.getState('wt-1')).toBe('idle');
  });

  it('exact priority: permission > active > waiting > terminated > idle', () => {
    const all: AgentSessionState[] = ['idle', 'terminated', 'waiting', 'active', 'permission'];
    const expectFor = (states: AgentSessionState[], expected: AgentSessionState) => {
      const { mgr } = create();
      seed(mgr, 'wt-1', states.map((s, i) => [i + 1, { kind: 'agent' as const, provider: 'claude' as const, state: s, name: 'claude' }]));
      expect(mgr.getState('wt-1')).toBe(expected);
    };
    expectFor(all, 'permission');
    expectFor(['idle', 'terminated', 'waiting', 'active'], 'active');
    expectFor(['idle', 'terminated', 'waiting'], 'waiting');
    expectFor(['idle', 'terminated'], 'terminated');
    expectFor(['idle'], 'idle');
  });

  it('falls back to idle when a window carries a state outside the priority list (defensive)', () => {
    const { mgr } = create();
    // Simulates a rogue state string reaching updateState at runtime (JS callers are untyped)
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'bogus' as AgentSessionState, name: 'claude' }]]);
    expect(mgr.getState('wt-1')).toBe('idle');
  });
});

// ── updateState ───────────────────────────────────────────────────────────────

describe('updateState', () => {
  it('sets the state on ALL claude windows of the worktree', async () => {
    const { mgr, stub } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await mgr.launch(wt);
    await mgr.launch(wt);
    mgr.updateState('wt-1', 'active');
    const sessions = mgr.getSessions('wt-1');
    expect(sessions).toHaveLength(2);
    expect(sessions.every(s => s.state === 'active')).toBe(true);
  });

  it('targets ONLY the given window when windowIndex identifies an agent window', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    mgr.updateState('wt-1', 'active', 2);
    const byIndex = Object.fromEntries(mgr.getSessions('wt-1').map(s => [s.index, s.state]));
    expect(byIndex).toEqual({ 1: 'waiting', 2: 'active' });
  });

  it('DROPS events whose windowIndex is untracked or points at a shell (dying window race)', () => {
    // Killing a window removes it from the map BEFORE its SessionEnd hook
    // arrives — that stale event must not repaint the surviving sessions.
    for (const windowIndex of [9, 3]) {
      const { mgr, stateEvents } = create();
      seed(mgr, 'wt-1', [
        [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
        [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
        [3, { kind: 'shell', state: 'idle', name: 'shell' }],
      ]);
      mgr.updateState('wt-1', 'terminated', windowIndex);
      const byIndex = Object.fromEntries(mgr.getSessions('wt-1').map(s => [s.index, s.state]));
      expect(byIndex, `windowIndex=${windowIndex}`).toEqual({ 1: 'waiting', 2: 'waiting', 3: 'idle' });
      expect(stateEvents, `windowIndex=${windowIndex}`).toEqual([]);
    }
  });

  it('applies the state to ALL agent windows when the event carries no windowIndex (legacy launches)', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    mgr.updateState('wt-1', 'active');
    expect(mgr.getSessions('wt-1').every(s => s.state === 'active')).toBe(true);
  });

  it('does not touch shell windows', async () => {
    const { mgr, stub } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await mgr.launch(wt);
    await mgr.openTerminal(wt);
    mgr.updateState('wt-1', 'permission');
    const sessions = mgr.getSessions('wt-1');
    expect(sessions.find(s => s.kind === 'agent')!.state).toBe('permission');
    expect(sessions.find(s => s.kind === 'shell')!.state).toBe('idle');
  });

  it('no-ops for unknown worktree', () => {
    const { mgr, stateEvents } = create();
    mgr.updateState('nope', 'active');
    expect(stateEvents).toEqual([]);
  });

  it('fires stateChangeEmitter with the re-aggregated state', async () => {
    const { mgr, stub, stateEvents } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    await mgr.launch(wt);
    stateEvents.length = 0;
    mgr.updateState('wt-1', 'permission');
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'permission' }]);
  });

  it('fires idle when the worktree only has shell windows (aggregate ignores the given state)', async () => {
    const { mgr, stateEvents } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    mgr.updateState('wt-1', 'active');
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'idle' }]);
  });
});

// ── getSessions / counts ──────────────────────────────────────────────────────

describe('getSessions', () => {
  it('returns empty array for unknown worktree', () => {
    const { mgr } = create();
    expect(mgr.getSessions('unknown')).toEqual([]);
  });

  it('returns sessions in insertion order (NOT sorted by window index)', () => {
    // Real behavior: [...map.entries()] preserves Map insertion order.
    const { mgr } = create();
    seed(mgr, 'wt-1', [
      [3, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [1, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);
    expect(mgr.getSessions('wt-1')).toEqual([
      { name: 'claude', kind: 'agent', provider: 'claude', state: 'waiting', index: 3 },
      { name: 'shell', kind: 'shell', state: 'idle', index: 1 },
    ]);
  });

  it('sorts by a saved display order; windows not in the order fall to the end (stable)', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'shell', state: 'idle', name: 'shell' }],
      [3, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);
    // Order puts 3 first, 1 second; window 2 is not listed → goes last.
    mgr.setSessionOrder('wt-1', [3, 1]);
    expect(mgr.getSessions('wt-1').map(s => s.index)).toEqual([3, 1, 2]);
  });
});

describe('setSessionOrder', () => {
  it('persists the order, applies it, and fires terminalsChange', () => {
    const { mgr, getTerminalsChanges, memento } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);
    mgr.setSessionOrder('wt-1', [2, 1]);
    expect(mgr.getSessions('wt-1').map(s => s.index)).toEqual([2, 1]);
    expect(getTerminalsChanges()).toBe(1);
    expect(memento.get('unmess.sessionOrder')).toEqual({ 'wt-1': [2, 1] });
  });

  it('restores a persisted order from the memento on construction', () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    memento.update('unmess.sessionOrder', { 'wt-1': [2, 1] });
    const { mgr } = create('claude', memento);
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);
    expect(mgr.getSessions('wt-1').map(s => s.index)).toEqual([2, 1]);
  });
});

describe('counts', () => {
  it('getAgentCount / getShellCount / hasTerminals reflect the window map', async () => {
    const { mgr, stub } = create();
    expect(mgr.getAgentCount('wt-1')).toBe(0);
    expect(mgr.getShellCount('wt-1')).toBe(0);
    expect(mgr.hasTerminals('wt-1')).toBe(false);
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await mgr.launch(wt);
    await mgr.openTerminal(wt);
    expect(mgr.getAgentCount('wt-1')).toBe(1);
    expect(mgr.getShellCount('wt-1')).toBe(1);
    expect(mgr.hasTerminals('wt-1')).toBe(true);
  });
});

// ── launch ────────────────────────────────────────────────────────────────────

describe('launch', () => {
  it('calls sessionManager.ensureSession + newWindow + respawnWindow + selectWindow', async () => {
    const { mgr, stub } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    await mgr.launch(wt);
    expect(stub.ensureSession).toHaveBeenCalledWith(SESSION, wt.path);
    expect(stub.newWindow).toHaveBeenCalledWith(SESSION, 'claude', wt.path);
    expect(stub.respawnWindow).toHaveBeenCalledWith(SESSION, 5, 'UNMESS_WINDOW_INDEX="5" UNMESS_WORKSPACE_ID="wt-1" claude; exec "${SHELL:-/bin/sh}"');
    expect(stub.selectWindow).toHaveBeenCalledWith(SESSION, 5);
  });

  it('sets initial state to waiting', async () => {
    const { mgr } = create();
    await mgr.launch(wt);
    expect(mgr.getState('wt-1')).toBe('waiting');
    expect(mgr.getSessions('wt-1')).toEqual([{ name: 'claude', kind: 'agent', provider: 'claude', state: 'waiting', index: 1 }]);
  });

  it('fires stateChangeEmitter with waiting', async () => {
    const { mgr, stateEvents } = create();
    await mgr.launch(wt);
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'waiting' }]);
  });

  it('fires terminalsChangeEmitter', async () => {
    const { mgr, getTerminalsChanges } = create();
    await mgr.launch(wt);
    expect(getTerminalsChanges()).toBe(1);
  });

  it('creates and shows the viewer terminal', async () => {
    const { mgr } = create();
    const viewer = await mgr.launch(wt) as unknown as MockTerminal;
    expect(window.createTerminal).toHaveBeenCalledTimes(1);
    expect(viewer.show).toHaveBeenCalled();
    expect(mgr.getViewer('wt-1')).toBe(viewer);
  });
});

describe('launch command line', () => {
  it('prefixes UNMESS_WORKSPACE_ID and escapes double quotes in the initial prompt', async () => {
    const { mgr, stub } = create();
    await mgr.launch(wt, { prompt: 'fix "this" bug' });
    expect(stub.respawnWindow).toHaveBeenCalledWith(
      SESSION,
      1,
      'UNMESS_WINDOW_INDEX="1" UNMESS_WORKSPACE_ID="wt-1" claude "fix \\"this\\" bug"; exec "${SHELL:-/bin/sh}"',
    );
  });

  it('launches an explicitly requested provider instead of the default', async () => {
    const { mgr, stub } = create();
    await mgr.launch(wt, { provider: 'opencode' });
    expect(stub.newWindow).toHaveBeenCalledWith(SESSION, 'opencode', wt.path);
    expect(stub.respawnWindow).toHaveBeenCalledWith(
      SESSION,
      1,
      'UNMESS_WINDOW_INDEX="1" UNMESS_WORKSPACE_ID="wt-1" opencode; exec "${SHELL:-/bin/sh}"',
    );
    expect(mgr.getSessions('wt-1')[0].provider).toBe('opencode');
  });

  it('launchWithPrompt delegates to launch with the prompt', async () => {
    const { mgr, stub } = create('my-claude');
    await mgr.launchWithPrompt(wt, 'hello');
    expect(stub.respawnWindow).toHaveBeenCalledWith(
      SESSION,
      1,
      'UNMESS_WINDOW_INDEX="1" UNMESS_WORKSPACE_ID="wt-1" my-claude "hello"; exec "${SHELL:-/bin/sh}"',
    );
  });
});

// ── openTerminal ──────────────────────────────────────────────────────────────

describe('openTerminal', () => {
  it('creates a shell window, selects it, shows the viewer, fires terminalsChange only', async () => {
    const { mgr, stub, stateEvents, getTerminalsChanges } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    const viewer = await mgr.openTerminal(wt) as unknown as MockTerminal;
    expect(stub.ensureSession).toHaveBeenCalledWith(SESSION, wt.path);
    expect(stub.newWindow).toHaveBeenCalledWith(SESSION, 'shell', wt.path);
    expect(stub.selectWindow).toHaveBeenCalledWith(SESSION, 2);
    expect(stub.respawnWindow).not.toHaveBeenCalled();
    expect(mgr.getSessions('wt-1')).toEqual([{ name: 'shell', kind: 'shell', state: 'idle', index: 2 }]);
    expect(viewer.show).toHaveBeenCalled();
    expect(stateEvents).toEqual([]);
    expect(getTerminalsChanges()).toBe(1);
  });
});

// ── viewer lifecycle ──────────────────────────────────────────────────────────

describe('viewer lifecycle', () => {
  it('getOrCreateViewer reuses a live viewer, recreates an exited one', async () => {
    const { mgr } = create();
    const first = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    const again = await mgr.getOrCreateViewer(wt);
    expect(again).toBe(first);
    expect(window.createTerminal).toHaveBeenCalledTimes(1);

    first.exitStatus = { code: 0 };
    const recreated = await mgr.getOrCreateViewer(wt);
    expect(recreated).not.toBe(first);
    expect(window.createTerminal).toHaveBeenCalledTimes(2);
  });

  it('getWorktreeIdForTerminal reverse-maps a viewer to its worktree, undefined for strangers', async () => {
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt);
    expect(mgr.getWorktreeIdForTerminal(viewer)).toBe(wt.id);
    expect(mgr.getWorktreeIdForTerminal({} as never)).toBeUndefined();
  });

  it('viewer terminal uses /bin/sh -c tmux attach in the Editor area (no exec $SHELL fallback)', async () => {
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(viewer.creationOptions).toEqual({
      name: 'feat/login',
      cwd: wt.path,
      location: TerminalLocation.Editor,
      shellPath: '/bin/sh',
      shellArgs: ['-c', `tmux attach -t "${SESSION}"`],
    });
    expect(JSON.stringify(viewer.creationOptions)).not.toContain('exec $SHELL');
  });

  it('viewer name uses alias over branch and appends the window name when given', async () => {
    const { mgr } = create();
    const aliased = { ...wt, alias: 'login-work' };
    const viewer = await mgr.getOrCreateViewer(aliased, 'claude') as unknown as MockTerminal;
    expect(viewer.name).toBe('login-work — claude');
  });

  it('attaches WITHOUT a cwd when the worktree directory is missing (avoids the does-not-exist launch error)', async () => {
    const stub = makeStub();
    // pathExists → false: the worktree dir is gone but its tmux session may still be alive.
    const mgr = new AgentSessionManager(makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub, () => false);
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(viewer.creationOptions.cwd).toBeUndefined();
    expect(viewer.creationOptions.shellArgs).toEqual(['-c', `tmux attach -t "${SESSION}"`]);
  });

  it('uses fs.existsSync by default (no injected pathExists) — falls back for a missing dir', async () => {
    const stub = makeStub();
    const mgr = new AgentSessionManager(makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub);
    // wt.path is a fixture path that does not exist on disk → default fs.existsSync is false.
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(viewer.creationOptions.cwd).toBeUndefined();
  });

  it('onDidCloseTerminal removes the viewer from the map', async () => {
    const { mgr } = create();
    const onClose = (window.onDidCloseTerminal as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    const viewer = await mgr.getOrCreateViewer(wt);
    onClose(viewer);
    // Even though exitStatus is still undefined, the viewer was dropped
    expect(mgr.getViewer('wt-1')).toBeUndefined();
    const recreated = await mgr.getOrCreateViewer(wt);
    expect(recreated).not.toBe(viewer);
  });

  it('onDidCloseTerminal ignores unrelated terminals', async () => {
    const { mgr } = create();
    const onClose = (window.onDidCloseTerminal as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    const viewer = await mgr.getOrCreateViewer(wt);
    onClose(makeTerminal({ name: 'unrelated' }));
    expect(mgr.getViewer('wt-1')).toBe(viewer);
  });

  it('getViewer returns undefined for exited terminals', async () => {
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(mgr.getViewer('wt-1')).toBe(viewer);
    viewer.exitStatus = { code: 0 };
    expect(mgr.getViewer('wt-1')).toBeUndefined();
  });

  it('getTerminal and getPlainTerminal are aliases of getViewer', async () => {
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt);
    expect(mgr.getTerminal('wt-1')).toBe(viewer);
    expect(mgr.getPlainTerminal('wt-1')).toBe(viewer);
    expect(mgr.getTerminal('unknown')).toBeUndefined();
  });

  it('focus shows the viewer and no-ops for unknown worktrees', async () => {
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    viewer.show.mockClear();
    mgr.focus('wt-1');
    expect(viewer.show).toHaveBeenCalledTimes(1);
    expect(() => mgr.focus('unknown')).not.toThrow();
  });
});

// ── focusWindow ───────────────────────────────────────────────────────────────

describe('focusWindow', () => {
  it('selects the tmux window and recreates the viewer with the window name in the title', async () => {
    const { mgr, stub } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const old = await mgr.launch(wt) as unknown as MockTerminal;
    await mgr.focusWindow(wt, 1);
    expect(stub.selectWindow).toHaveBeenLastCalledWith(SESSION, 1);
    expect(old.dispose).toHaveBeenCalled();
    const viewer = mgr.getViewer('wt-1') as unknown as MockTerminal;
    expect(viewer).not.toBe(old);
    expect(viewer.name).toBe('feat/login — claude');
    expect(viewer.show).toHaveBeenCalled();
  });

  it('creates a viewer without a window suffix when the window is untracked', async () => {
    const { mgr } = create();
    await mgr.focusWindow(wt, 9);
    const viewer = mgr.getViewer('wt-1') as unknown as MockTerminal;
    expect(viewer.name).toBe('feat/login');
  });
});

// ── killWindow ────────────────────────────────────────────────────────────────

describe('killWindow', () => {
  it('calls sessionManager.killWindow', async () => {
    const { mgr, stub } = create();
    await mgr.killWindow('wt-1', 3);
    expect(stub.killWindow).toHaveBeenCalledWith(SESSION, 3);
  });

  it('removes window from map', async () => {
    const { mgr, stub } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(4);
    await mgr.launch(wt);
    await mgr.killWindow('wt-1', 4);
    expect(mgr.getSessions('wt-1')).toEqual([]);
    expect(mgr.hasTerminals('wt-1')).toBe(false);
  });

  it('fires stateChangeEmitter with the re-aggregated state and terminalsChange', async () => {
    const { mgr, stub, stateEvents, getTerminalsChanges } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(4);
    await mgr.launch(wt);
    stateEvents.length = 0;
    const before = getTerminalsChanges();
    await mgr.killWindow('wt-1', 4);
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'idle' }]);
    expect(getTerminalsChanges()).toBe(before + 1);
  });

  it('prunes the killed window from the saved display order', async () => {
    const { mgr, memento } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);
    mgr.setSessionOrder('wt-1', [2, 1]);
    await mgr.killWindow('wt-1', 2);
    expect(mgr.getSessions('wt-1').map(s => s.index)).toEqual([1]);
    expect(memento.get('unmess.sessionOrder')).toEqual({ 'wt-1': [1] });
  });

  it('leaves the saved order untouched when the killed window was not in it', async () => {
    const { mgr, memento } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);
    mgr.setSessionOrder('wt-1', [1]); // 2 not listed
    await mgr.killWindow('wt-1', 2);
    expect(memento.get('unmess.sessionOrder')).toEqual({ 'wt-1': [1] });
  });
});

// ── closeViewer ───────────────────────────────────────────────────────────────

describe('closeViewer', () => {
  it('calls sessionManager.detachClients, then disposes once sh exits', async () => {
    const { mgr, stub } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    // Simulate the sh process exiting right after the detach
    (stub.detachClients as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      viewer.exitStatus = { code: 0 };
    });
    await mgr.closeViewer('wt-1');
    expect(stub.detachClients).toHaveBeenCalledWith(SESSION);
    expect(viewer.dispose).toHaveBeenCalledTimes(1);
    expect(mgr.getViewer('wt-1')).toBeUndefined();
  });

  it('polls every 30ms until the sh process exits', async () => {
    vi.useFakeTimers();
    const { mgr, stub } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    const done = mgr.closeViewer('wt-1');
    await vi.advanceTimersByTimeAsync(30);
    expect(viewer.dispose).not.toHaveBeenCalled();
    viewer.exitStatus = { code: 0 };
    await vi.advanceTimersByTimeAsync(30);
    await done;
    expect(stub.detachClients).toHaveBeenCalledWith(SESSION);
    expect(viewer.dispose).toHaveBeenCalledTimes(1);
  });

  it('gives up after the ~400ms deadline and disposes anyway', async () => {
    vi.useFakeTimers();
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    const done = mgr.closeViewer('wt-1');
    await vi.advanceTimersByTimeAsync(300);
    expect(viewer.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(viewer.dispose).toHaveBeenCalledTimes(1);
    expect(mgr.getViewer('wt-1')).toBeUndefined();
  });

  it('no-ops when viewer missing', async () => {
    const { mgr, stub } = create();
    await mgr.closeViewer('wt-1');
    expect(stub.detachClients).not.toHaveBeenCalled();
  });

  it('no-ops when viewer already exited', async () => {
    const { mgr, stub } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    viewer.exitStatus = { code: 0 };
    viewer.dispose.mockClear();
    await mgr.closeViewer('wt-1');
    expect(stub.detachClients).not.toHaveBeenCalled();
    expect(viewer.dispose).not.toHaveBeenCalled();
  });
});

// ── killWorktreeSession / terminateSession ────────────────────────────────────

describe('killWorktreeSession', () => {
  it('kills the tmux session, disposes the viewer, clears state, fires idle', async () => {
    const { mgr, stub, stateEvents, getTerminalsChanges } = create();
    const viewer = await mgr.launch(wt) as unknown as MockTerminal;
    stateEvents.length = 0;
    const before = getTerminalsChanges();
    await mgr.killWorktreeSession('wt-1');
    expect(stub.killSession).toHaveBeenCalledWith(SESSION);
    expect(viewer.dispose).toHaveBeenCalled();
    expect(mgr.hasTerminals('wt-1')).toBe(false);
    expect(mgr.getViewer('wt-1')).toBeUndefined();
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'idle' }]);
    expect(getTerminalsChanges()).toBe(before + 1);
  });

  it('terminateSession swallows errors (fire-and-forget)', async () => {
    const { mgr, stub } = create();
    (stub.killSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tmux gone'));
    mgr.terminateSession('wt-1');
    await new Promise(r => setTimeout(r, 0));
    expect(stub.killSession).toHaveBeenCalledWith(SESSION);
  });
});

// ── sendPromptToAgent ───────────────────────────────────────────────────────

describe('sendPromptToAgent', () => {
  it('returns false when the worktree has no windows', async () => {
    const { mgr, stub } = create();
    expect(await mgr.sendPromptToAgent(wt, 'hi')).toBe(false);
    expect(stub.paste).not.toHaveBeenCalled();
  });

  it('returns false when only shell windows exist', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    expect(await mgr.sendPromptToAgent(wt, 'hi')).toBe(false);
    expect(stub.paste).not.toHaveBeenCalled();
  });

  it('pastes into a ready agent window and selects it', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    expect(await mgr.sendPromptToAgent(wt, 'review this')).toBe(true);
    expect(stub.selectWindow).toHaveBeenCalledWith(SESSION, 3);
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:3`, 'review this');
  });

  it('prefers a ready (waiting/idle/permission) window over a busy one', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    await mgr.sendPromptToAgent(wt, 'x');
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:2`, 'x');
  });

  it('falls back to the first agent window when none is ready', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [
      [4, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }],
      [5, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }],
    ]);
    await mgr.sendPromptToAgent(wt, 'x');
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:4`, 'x');
  });

  it('pasteToActiveWindow pastes to the session (active pane) without submitting', async () => {
    const { mgr, stub } = create();
    await mgr.pasteToActiveWindow('wt-1', "'/x/shot.png' ");
    expect(stub.paste).toHaveBeenCalledWith(SESSION, "'/x/shot.png' ", false);
  });
});

// ── reconnect ─────────────────────────────────────────────────────────────────

describe('reconnect', () => {
  it('restores window map from tmux listWindows', async () => {
    const { mgr, stub } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude' },
      { index: 2, name: 'shell' },
    ]);
    await mgr.reconnect([wt]);
    expect(stub.listWindows).toHaveBeenCalledWith(SESSION);
    expect(mgr.getSessions('wt-1')).toEqual([
      { name: 'claude', kind: 'agent', provider: 'claude', state: 'waiting', index: 1 },
      { name: 'shell', kind: 'shell', state: 'idle', index: 2 },
    ]);
  });

  it('skips window 0 unless named shell or claude*', async () => {
    const { mgr, stub } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 0, name: 'zsh' },
      { index: 1, name: 'claude' },
    ]);
    await mgr.reconnect([wt]);
    expect(mgr.getSessions('wt-1').map(s => s.index)).toEqual([1]);
  });

  it('keeps window 0 when named shell or claude*', async () => {
    const { mgr, stub } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ index: 0, name: 'shell' }])
      .mockResolvedValueOnce([{ index: 0, name: 'claude-resume' }]);
    await mgr.reconnect([wt]);
    expect(mgr.getSessions('wt-1')).toEqual([{ name: 'shell', kind: 'shell', state: 'idle', index: 0 }]);
    await mgr.reconnect([wt2]);
    expect(mgr.getSessions('wt-2')).toEqual([{ name: 'claude-resume', kind: 'agent', provider: 'claude', state: 'waiting', index: 0 }]);
  });

  it('restores claude windows as waiting (fires stateChange), shells as idle; unknown names count as shell', async () => {
    const { mgr, stub, stateEvents } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude' },
      { index: 2, name: 'vim' },
    ]);
    await mgr.reconnect([wt]);
    expect(mgr.getSessions('wt-1')).toEqual([
      { name: 'claude', kind: 'agent', provider: 'claude', state: 'waiting', index: 1 },
      { name: 'vim', kind: 'shell', state: 'idle', index: 2 },
    ]);
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'waiting' }]);
  });

  it('claims existing VSCode terminals by label prefix (alias/branch, emoji empty by default)', async () => {
    const { mgr } = create();
    const restored = makeTerminal({ name: 'feat/login — claude' });
    window.terminals.push(makeTerminal({ name: 'no-match' }), restored);
    await mgr.reconnect([wt]);
    expect(mgr.getViewer('wt-1')).toBe(restored);
  });

  it('does not claim exited terminals or double-claim', async () => {
    const { mgr } = create();
    const exited = makeTerminal({ name: 'feat/login — claude' });
    exited.exitStatus = { code: 0 };
    const live1 = makeTerminal({ name: 'feat/login — claude' });
    const live2 = makeTerminal({ name: 'feat/login' });
    window.terminals.push(exited, live1, live2);
    await mgr.reconnect([wt]);
    // first live match wins; the second matching terminal is left unclaimed
    expect(mgr.getViewer('wt-1')).toBe(live1);
  });

  it('skips worktrees with no tmux session (but still claims viewers and fires terminalsChange)', async () => {
    const { mgr, stub, getTerminalsChanges } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const restored = makeTerminal({ name: 'feat/login' });
    window.terminals.push(restored);
    await mgr.reconnect([wt]);
    expect(stub.listWindows).not.toHaveBeenCalled();
    expect(mgr.getSessions('wt-1')).toEqual([]);
    expect(mgr.getViewer('wt-1')).toBe(restored);
    expect(getTerminalsChanges()).toBe(1);
  });

  it('does not steal a viewer already tracked for the worktree', async () => {
    const { mgr } = create();
    const original = await mgr.getOrCreateViewer(wt);
    window.terminals.push(makeTerminal({ name: 'feat/login — other' }));
    await mgr.reconnect([wt]);
    expect(mgr.getViewer('wt-1')).toBe(original);
  });

  it('restores the persisted claude state (e.g. permission) across a reload instead of waiting', async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    // First session: a claude window driven to "permission" (persisted to globalState).
    const first = create('claude', memento);
    seed(first.mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    first.mgr.updateState('wt-1', 'permission');

    // Reload: a brand-new manager over the SAME globalState.
    const second = create('claude', memento);
    (second.stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (second.stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude' }]);
    await second.mgr.reconnect([wt]);

    expect(second.mgr.getState('wt-1')).toBe('permission');
    expect(second.stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'permission' }]);
  });

  it('falls back to waiting when no state was persisted for the worktree', async () => {
    const { mgr, stub } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude' }]);
    await mgr.reconnect([wt]);
    expect(mgr.getState('wt-1')).toBe('waiting');
  });
});

// ── session titles (tmux pane_title → SessionItem.title) ─────────────────────

describe('session titles', () => {
  /** Seeds one claude window and points listWindows at the given pane titles. */
  function createTitled(windows: Array<{ index: number; name: string; title: string }>) {
    const ctx = create();
    seed(ctx.mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    (ctx.stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue(windows);
    return ctx;
  }

  const flush = () => new Promise(r => setTimeout(r, 0));

  it('updateState refreshes the title from the pane title, stripping spinner glyphs', async () => {
    const { mgr } = createTitled([{ index: 1, name: 'claude', title: '⠂ Fix login flow bug' }]);
    mgr.updateState('wt-1', 'active');
    await flush();
    expect(mgr.getSessions('wt-1')[0].title).toBe('Fix login flow bug');
    mgr.dispose();
  });

  it('strips ✳/· style prefixes and surrounding whitespace', async () => {
    const { mgr } = createTitled([{ index: 1, name: 'claude', title: ' ✳ · Add OpenCode provider ' }]);
    await mgr.refreshTitles('wt-1');
    expect(mgr.getSessions('wt-1')[0].title).toBe('Add OpenCode provider');
  });

  it('fires terminalsChange when a title changes, stays silent when unchanged', async () => {
    const { mgr, getTerminalsChanges } = createTitled([{ index: 1, name: 'claude', title: 'Do the thing' }]);
    await mgr.refreshTitles('wt-1');
    expect(getTerminalsChanges()).toBe(1);
    await mgr.refreshTitles('wt-1');
    expect(getTerminalsChanges()).toBe(1);
  });

  it('drops uninformative titles: empty, window name, product default, or the machine hostname (case-insensitive)', async () => {
    for (const title of ['', '   ', 'claude', 'Claude Code', '\u2733 Claude Code', 'test-host.local', 'TEST-HOST.LOCAL']) {
      const { mgr, getTerminalsChanges } = createTitled([{ index: 1, name: 'claude', title }]);
      await mgr.refreshTitles('wt-1');
      expect(mgr.getSessions('wt-1')[0].title, `title=${JSON.stringify(title)}`).toBeUndefined();
      expect(getTerminalsChanges()).toBe(0);
    }
  });

  it('clears a previously-set title when the pane title becomes uninformative again', async () => {
    const { mgr, stub, getTerminalsChanges } = createTitled([{ index: 1, name: 'claude', title: 'Fix bug' }]);
    await mgr.refreshTitles('wt-1');
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude', title: '' }]);
    await mgr.refreshTitles('wt-1');
    expect(mgr.getSessions('wt-1')[0].title).toBeUndefined();
    expect(getTerminalsChanges()).toBe(2);
  });

  it('ignores shell windows and tmux windows not in the tracked map', async () => {
    const { mgr, stub, getTerminalsChanges } = create();
    seed(mgr, 'wt-1', [[2, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 2, name: 'shell', title: 'some shell title' },
      { index: 9, name: 'claude', title: 'untracked window' },
    ]);
    await mgr.refreshTitles('wt-1');
    expect(mgr.getSessions('wt-1')[0].title).toBeUndefined();
    expect(getTerminalsChanges()).toBe(0);
  });

  it('refreshTitles early-returns without querying tmux when nothing is tracked', async () => {
    const { mgr, stub } = create();
    await mgr.refreshTitles('unknown');
    expect(stub.listWindows).not.toHaveBeenCalled();
  });

  it('updateState schedules ONE debounced re-read 800ms later (rapid hooks collapse)', async () => {
    vi.useFakeTimers();
    const { mgr, stub } = createTitled([{ index: 1, name: 'claude', title: 'T' }]);
    mgr.updateState('wt-1', 'active');
    mgr.updateState('wt-1', 'active');
    expect(stub.listWindows).toHaveBeenCalledTimes(2); // immediate refresh per event
    await vi.advanceTimersByTimeAsync(800);
    expect(stub.listWindows).toHaveBeenCalledTimes(3); // single debounced follow-up
  });

  it('dispose cancels the pending debounced refresh', async () => {
    vi.useFakeTimers();
    const { mgr, stub } = createTitled([{ index: 1, name: 'claude', title: 'T' }]);
    mgr.updateState('wt-1', 'active');
    expect(stub.listWindows).toHaveBeenCalledTimes(1);
    mgr.dispose();
    await vi.advanceTimersByTimeAsync(800);
    expect(stub.listWindows).toHaveBeenCalledTimes(1);
  });

  it('reconnect restores claude titles from pane titles (shells stay untitled)', async () => {
    const { mgr, stub } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', title: '✳ Resume feature work' },
      { index: 2, name: 'shell', title: 'zsh stuff' },
    ]);
    await mgr.reconnect([wt]);
    const sessions = mgr.getSessions('wt-1');
    expect(sessions.find(s => s.index === 1)!.title).toBe('Resume feature work');
    expect(sessions.find(s => s.index === 2)!.title).toBeUndefined();
  });
});

// ── state persistence ─────────────────────────────────────────────────────────

describe('state persistence', () => {
  it('updateState writes PER-WINDOW states to globalState under unmess.claudeStates', () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const { mgr } = create('claude', memento);
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    mgr.updateState('wt-1', 'permission', 2);
    expect(memento.get('unmess.claudeStates')).toEqual({ 'wt-1': { 1: 'waiting', 2: 'permission' } });
  });

  it('launch persists waiting for the new window; killWorktreeSession clears the worktree entry', async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const { mgr } = create('claude', memento);
    await mgr.launch(wt);
    expect((memento.get('unmess.claudeStates') as Record<string, unknown>)['wt-1']).toEqual({ 1: 'waiting' });
    await mgr.killWorktreeSession('wt-1');
    expect((memento.get('unmess.claudeStates') as Record<string, unknown>)['wt-1']).toEqual({});
  });

  it('reconnect restores EACH window to its own pre-reload state', async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const first = create('claude', memento);
    seed(first.mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    first.mgr.updateState('wt-1', 'permission', 2);

    const second = create('claude', memento);
    (second.stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (second.stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude' },
      { index: 2, name: 'claude' },
    ]);
    await second.mgr.reconnect([wt]);
    const byIndex = Object.fromEntries(second.mgr.getSessions('wt-1').map(s => [s.index, s.state]));
    expect(byIndex).toEqual({ 1: 'waiting', 2: 'permission' });
  });

  it('still understands the legacy aggregate-string format (applies it to every window)', async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    memento.update('unmess.claudeStates', { 'wt-1': 'permission' });
    const { mgr, stub } = create('claude', memento);
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude' },
      { index: 2, name: 'claude' },
    ]);
    await mgr.reconnect([wt]);
    expect(mgr.getSessions('wt-1').every(s => s.state === 'permission')).toBe(true);
  });
});

// ── misc compat API ───────────────────────────────────────────────────────────

describe('compat API', () => {
  it('register is a no-op', () => {
    const { mgr } = create();
    expect(() => mgr.register('wt-1', makeTerminal() as unknown as vscode.Terminal)).not.toThrow();
  });

  it('dispose disposes the emitters (events stop firing)', async () => {
    const { mgr, stateEvents } = create();
    mgr.dispose();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    mgr.updateState('wt-1', 'active');
    expect(stateEvents).toEqual([]);
  });
});
