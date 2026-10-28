import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { window, resetVscodeMock, makeTerminal, FakeMemento, TerminalLocation } from '../__mocks__/vscode';
import type { MockTerminal } from '../__mocks__/vscode';
import { AgentSessionManager } from '../../src/session/AgentSessionManager';
import { ProviderFactory } from '../../src/providers/ProviderFactory';
import type { ConfigSource } from '../../src/providers/claude/ClaudeProvider';
import type { ISessionManager } from '../../src/ports/ISessionManager';
import type { AgentSessionState, Worktree } from '../../src/types';
import type { ProviderId } from '../../src/ports/IAgentProvider';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const wt: Worktree = {
  id: 'wt-1',
  branch: 'feat/login',
  path: '/nonexistent/wt-1',
  repoRoot: '/nonexistent/repo',
  debugPort: 9898,
  dockerProjectName: 'feat-login',
  createdAt: 0,
};
const SESSION = 'stack-wt-1'; // TmuxManager.sessionName('wt-1')

const wt2: Worktree = {
  id: 'wt-2',
  branch: 'other',
  path: '/nonexistent/wt-2',
  repoRoot: '/nonexistent/repo',
  debugPort: 9899,
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
    pressEnter: vi.fn().mockResolvedValue(undefined),
    respawnWindow: vi.fn().mockResolvedValue(undefined),
    selectWindow: vi.fn().mockResolvedValue(undefined),
    killWindow: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    detachClients: vi.fn().mockResolvedValue(undefined),
    listWindows: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    listClients: vi.fn().mockResolvedValue([]),
    hasChildProcess: vi.fn().mockResolvedValue(false),
    processCommandLine: vi.fn().mockRejectedValue(new Error('no ps in unit tests')),
    capturePane: vi.fn().mockResolvedValue('pane text'),
  };
}

function makeFactory(claudeCommand = 'claude'): ProviderFactory {
  const config = { get: () => ({ claudeCommand, opencodeCommand: 'opencode', defaultProvider: 'claude' }) } as unknown as ConfigSource;
  return new ProviderFactory(config, '/tmp/stack-test-storage');
}

function create(
  claudeCommand = 'claude',
  memento: vscode.Memento = new FakeMemento() as unknown as vscode.Memento,
  promptPrefix: () => string = () => '',
) {
  const stub = makeStub();
  // Default: worktree directories exist, deterministic hostname. Individual tests override as needed.
  // Instant sleep: waitForAgentProcess is bounded by attempts, so this runs
  // its whole budget without any wall-clock time.
  const mgr = new AgentSessionManager(
    makeFactory(claudeCommand), memento, stub, () => true, 'Test-Host.local', async () => {},
    () => 'single', promptPrefix,
  );
  const stateEvents: Array<{ worktreeId: string; state: AgentSessionState }> = [];
  let terminalsChanges = 0;
  mgr.onStateChange(e => stateEvents.push(e));
  mgr.onTerminalsChange(() => terminalsChanges++);
  return { mgr, stub, stateEvents, getTerminalsChanges: () => terminalsChanges, memento };
}

/** Seed the private windows map directly (state combinations unreachable via public API). */
function seed(mgr: AgentSessionManager, worktreeId: string, entries: Array<[number, { kind: 'agent' | 'shell'; provider?: ProviderId; state: AgentSessionState; name: string; hookSeen?: boolean; title?: string; attention?: string; attentionFromRequest?: boolean }]>) {
  const map = (mgr as unknown as { windowMap(id: string): Map<number, unknown> }).windowMap(worktreeId);
  for (const [idx, meta] of entries) map.set(idx, meta);
}

/** tmux reports these windows with an agent in the foreground — running, by any measure. */
function live(stub: ISessionManager, ...indexes: number[]) {
  (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue(
    indexes.map((index) => ({ index, name: 'claude', command: 'node', pid: 100 + index })),
  );
}

/** The prompt was pasted into `target` and Enter was pressed there afterwards. */
function expectSubmitted(stub: ISessionManager, target: string, text: string) {
  expect(stub.paste).toHaveBeenCalledWith(target, text);
  expect(stub.pressEnter).toHaveBeenCalledWith(target);
  const pasted = (stub.paste as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
  const entered = (stub.pressEnter as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
  expect(pasted).toBeLessThan(entered);
}

/** The prompt was pasted into `target` and left there: no Enter at all. */
function expectUnsent(stub: ISessionManager, target: string, text: string) {
  expect(stub.paste).toHaveBeenCalledWith(target, text);
  expect(stub.pressEnter).not.toHaveBeenCalled();
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

  it('DROPS events for an untracked window (dying window race)', () => {
    // Killing a window removes it from the map BEFORE its SessionEnd hook
    // arrives — that stale event must not repaint the surviving sessions.
    const { mgr, stateEvents } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    mgr.updateState('wt-1', 'terminated', 9);
    const byIndex = Object.fromEntries(mgr.getSessions('wt-1').map(s => [s.index, s.state]));
    expect(byIndex).toEqual({ 1: 'waiting', 2: 'waiting' });
    expect(stateEvents).toEqual([]);
  });

  it('ADOPTS a shell window that starts reporting agent states', () => {
    // Only an agent's hook sends these, so a shell window reporting one has an
    // agent the user started by hand. Dropping the event made that agent
    // invisible: it never lit up, however long it waited on a permission.
    const { mgr } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);

    mgr.updateState('wt-1', 'permission', 2);

    const adopted = mgr.getSessions('wt-1').find(s => s.index === 2)!;
    expect(adopted.kind).toBe('agent');
    expect(adopted.state).toBe('permission');
    // And it must not have splashed onto the agent that was already there.
    expect(mgr.getSessions('wt-1').find(s => s.index === 1)!.state).toBe('waiting');
  });

  it('leaves the adopted window without a provider rather than guessing one', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[2, { kind: 'shell', state: 'idle', name: 'shell' }]]);

    mgr.updateState('wt-1', 'active', 2);

    expect(mgr.getSessions('wt-1').find(s => s.index === 2)!.provider).toBeUndefined();
  });

  it('counts an adopted window as an agent, not a terminal', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[2, { kind: 'shell', state: 'idle', name: 'shell' }]]);

    mgr.updateState('wt-1', 'active', 2);

    expect(mgr.getAgentCount('wt-1')).toBe(1);
    expect(mgr.getShellCount('wt-1')).toBe(0);
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

// ── attention (what the agent asked) ──────────────────────────────────────────

describe('attention message', () => {
  const agent = (state: AgentSessionState = 'permission') =>
    ({ kind: 'agent' as const, provider: 'claude' as const, state, name: 'claude' });
  const sessionsOf = (mgr: AgentSessionManager) => mgr.getSessions('wt-1').map((s) => s.attention);

  it('keeps a notification\'s message on the window that sent it', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, agent()], [2, agent()]]);
    expect(mgr.noteHookEvent({ event: 'Notification', workspaceId: 'wt-1', windowIndex: 2, message: 'Claude needs your permission to use Bash' })).toBe(true);
    expect(sessionsOf(mgr)).toEqual([undefined, 'Claude needs your permission to use Bash']);
  });

  it('applies to every window asking when the hook could not say which sent it', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, agent()], [2, agent('active')], [3, agent()]]);
    mgr.noteHookEvent({ event: 'Notification', workspaceId: 'wt-1', message: 'Pick one' });
    expect(sessionsOf(mgr)).toEqual(['Pick one', undefined, 'Pick one']);
  });

  it('reads the command out of a permission request, which has no message', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, agent()]]);
    mgr.noteHookEvent({ event: 'PermissionRequest', workspaceId: 'wt-1', windowIndex: 1, payload: { tool_name: 'Bash', tool_input: { command: ' composer test ' } } });
    expect(sessionsOf(mgr)).toEqual(['Bash: composer test']);
  });

  it('names the file for a tool that edits one, and falls back to the message otherwise', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, agent()]]);
    mgr.noteHookEvent({ event: 'PermissionRequest', workspaceId: 'wt-1', windowIndex: 1, payload: { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } } });
    expect(sessionsOf(mgr)).toEqual(['Edit: src/a.ts']);
    mgr.noteHookEvent({ event: 'PermissionRequest', workspaceId: 'wt-1', windowIndex: 1, message: 'plain', payload: { tool_name: 'Edit', tool_input: {} } });
    expect(sessionsOf(mgr)).toEqual(['plain']);
    mgr.noteHookEvent({ event: 'PermissionRequest', workspaceId: 'wt-1', windowIndex: 1, payload: { tool_name: 'Bash', tool_input: { command: '  ' } } });
    expect(sessionsOf(mgr)).toEqual(['plain']);
    // A tool_input that is not an object (or no tool name) names nothing either.
    mgr.noteHookEvent({ event: 'PermissionRequest', workspaceId: 'wt-1', windowIndex: 1, payload: { tool_name: 'Bash', tool_input: 'rm -rf /' } });
    mgr.noteHookEvent({ event: 'PermissionRequest', workspaceId: 'wt-1', windowIndex: 1, payload: { tool_input: { command: 'ls' } } });
    expect(sessionsOf(mgr)).toEqual(['plain']);
  });

  it('does not let a notification\'s prose replace the command a request named', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, agent()]]);
    mgr.noteHookEvent({ event: 'PermissionRequest', workspaceId: 'wt-1', windowIndex: 1, payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
    expect(mgr.noteHookEvent({ event: 'Notification', workspaceId: 'wt-1', windowIndex: 1, message: 'Claude needs your permission' })).toBe(false);
    expect(sessionsOf(mgr)).toEqual(['Bash: ls']);
  });

  it('lets a request replace a notification that arrived first', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, agent()]]);
    mgr.noteHookEvent({ event: 'Notification', workspaceId: 'wt-1', windowIndex: 1, message: 'Claude needs your permission' });
    mgr.noteHookEvent({ event: 'PermissionRequest', workspaceId: 'wt-1', windowIndex: 1, payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
    expect(sessionsOf(mgr)).toEqual(['Bash: ls']);
  });

  it('ignores other events, empty messages, unknown worktrees and windows that are not asking', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, agent('active')], [2, { kind: 'shell', state: 'permission', name: 'zsh' }]]);
    expect(mgr.noteHookEvent({ event: 'PreToolUse', workspaceId: 'wt-1', message: 'x' })).toBe(false);
    expect(mgr.noteHookEvent({ event: 'Notification', workspaceId: 'wt-1' })).toBe(false);
    expect(mgr.noteHookEvent({ event: 'Notification', workspaceId: 'nope', message: 'x' })).toBe(false);
    expect(mgr.noteHookEvent({ event: 'Notification', workspaceId: 'wt-1', message: 'x' })).toBe(false);
    expect(sessionsOf(mgr)).toEqual([undefined, undefined]);
  });

  it('is cleared when the agent moves on, but kept while it is still asking or waiting', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, agent()], [2, agent()]]);
    mgr.noteHookEvent({ event: 'Notification', workspaceId: 'wt-1', message: 'Pick one' });

    mgr.updateState('wt-1', 'permission', 1);
    expect(sessionsOf(mgr)).toEqual(['Pick one', 'Pick one']);
    mgr.updateState('wt-1', 'waiting', 1);
    expect(sessionsOf(mgr)).toEqual(['Pick one', 'Pick one']);

    // Only the window that moved on forgets; the other is still asking.
    mgr.updateState('wt-1', 'active', 1);
    expect(sessionsOf(mgr)).toEqual([undefined, 'Pick one']);

    // A hook that cannot say which window sent it clears them all.
    mgr.updateState('wt-1', 'active');
    expect(sessionsOf(mgr)).toEqual([undefined, undefined]);
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
    expect(memento.get('stack.sessionOrder')).toEqual({ 'wt-1': [2, 1] });
  });

  it('restores a persisted order from the memento on construction', () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    memento.update('stack.sessionOrder', { 'wt-1': [2, 1] });
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

  it('getAgentCount counts only agents that are still running', () => {
    // The review panel offers "paste into the live session" on this count.
    const { mgr } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'terminated', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    expect(mgr.getAgentCount('wt-1')).toBe(1);
    mgr.updateState('wt-1', 'terminated', 2);
    expect(mgr.getAgentCount('wt-1')).toBe(0);
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
    expect(stub.respawnWindow).toHaveBeenCalledWith(SESSION, 5, 'STACK_WINDOW_INDEX="5" STACK_WORKSPACE_ID="wt-1" claude; exec "${SHELL:-/bin/sh}"');
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
  it('keeps the prompt out of the command line entirely', async () => {
    // tmux runs the launch line through `sh -c`. A prompt in there is expanded
    // before the agent sees it: `${...}` aborts the command and the agent never
    // starts, and backticks substitute away whatever they wrap — which is every
    // code line buildCommentPrompt attaches, so "send to a new agent" from the
    // review panel delivered comments with their code silently missing.
    const { mgr, stub } = create();
    await mgr.launch(wt, { prompt: 'fix ${user.id} and `const x = 1`' });
    expect(stub.respawnWindow).toHaveBeenCalledWith(
      SESSION,
      1,
      'STACK_WINDOW_INDEX="1" STACK_WORKSPACE_ID="wt-1" claude; exec "${SHELL:-/bin/sh}"',
    );
  });

  it('pastes the prompt, submitted, once the agent owns the pane', async () => {
    const { mgr, stub } = create();
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', command: 'node' },
    ]);
    await mgr.launch(wt, { prompt: 'fix ${user.id}' });
    expectSubmitted(stub, `${SESSION}:1`, 'fix ${user.id}');
  });

  it('prepends stack.promptPrefix to the prompt', async () => {
    const { mgr, stub } = create('claude', undefined, () => 'Check the skill first.');
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', command: 'node' },
    ]);
    await mgr.launch(wt, { prompt: 'fix the bug' });
    expectSubmitted(stub, `${SESSION}:1`, 'Check the skill first.\n\nfix the bug');
  });

  it('sends the prefix on its own when launched with no prompt', async () => {
    const { mgr, stub } = create('claude', undefined, () => 'Check the skill first.');
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', command: 'node' },
    ]);
    await mgr.launch(wt);
    expectSubmitted(stub, `${SESSION}:1`, 'Check the skill first.');
  });

  it('shows the viewer before waiting on the agent, so its boot is watched rather than waited out', async () => {
    const { mgr, stub } = create();
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', command: 'node' },
    ]);
    await mgr.launch(wt, { prompt: 'go' });
    const shown = window.createTerminal.mock.invocationCallOrder[0];
    const pasted = (stub.paste as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(shown).toBeLessThan(pasted);
  });

  it('waits while the pane is still the shell that launches the agent', async () => {
    const { mgr, stub } = create();
    const listWindows = stub.listWindows as ReturnType<typeof vi.fn>;
    listWindows
      .mockResolvedValueOnce([{ index: 1, name: 'claude', command: 'sh' }])
      .mockResolvedValue([{ index: 1, name: 'claude', command: 'node' }]);
    await mgr.launch(wt, { prompt: 'go' });
    expect(listWindows.mock.calls.length).toBeGreaterThan(1);
    expectSubmitted(stub, `${SESSION}:1`, 'go');
  });

  it('sees the agent through the shell that launched it: command stays a shell, but the pane has a child', async () => {
    // What tmux really reports for `zsh -c "claude; exec zsh"`: the pane's
    // command is `zsh` for the agent's whole life, and only the child list moves.
    const { mgr, stub } = create();
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', command: 'zsh', pid: 4242 },
    ]);
    (stub.hasChildProcess as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    await mgr.launch(wt, { prompt: 'go' });
    expect(stub.hasChildProcess).toHaveBeenCalledWith(4242);
    expectSubmitted(stub, `${SESSION}:1`, 'go');
  });

  it('treats a failing child lookup as "not yet"', async () => {
    const { mgr, stub } = create();
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', command: 'zsh', pid: 4242 },
    ]);
    (stub.hasChildProcess as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no pgrep'));
    await mgr.launch(wt, { prompt: 'go' });
    expectUnsent(stub, `${SESSION}:1`, 'go');
  });

  it('leaves the prompt unsent when the agent never takes the pane', async () => {
    // Binary missing, or it exited at once — the trailing `exec $SHELL` owns the
    // pane. Submitting there would run the prompt as a shell command.
    const { mgr, stub } = create();
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', command: 'zsh' },
    ]);
    await mgr.launch(wt, { prompt: 'rm -rf everything' });
    expectUnsent(stub, `${SESSION}:1`, 'rm -rf everything');
  });

  it('tolerates tmux failing while it waits for the agent', async () => {
    const { mgr, stub } = create();
    (stub.listWindows as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no server'));
    await mgr.launch(wt, { prompt: 'go' });
    expectUnsent(stub, `${SESSION}:1`, 'go');
  });

  it('waits on a real timer when no sleep is injected', async () => {
    // Everything else here drives the wait with an instant sleep; this is the
    // one place the shipped setTimeout default actually runs.
    const stub = makeStub();
    (stub.listWindows as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ index: 1, name: 'claude', command: 'sh' }])
      .mockResolvedValue([{ index: 1, name: 'claude', command: 'node' }]);
    const mgr = new AgentSessionManager(
      makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub, () => true, 'Test-Host.local',
    );

    // The agent confirms the submit the way Claude Code does: UserPromptSubmit → 'active'.
    (stub.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(async () => mgr.updateState('wt-1', 'active', 1));

    const started = Date.now();
    const launched = mgr.launch(wt, { prompt: 'go' });
    // The hook wait is real-timed too (6 s cap): release it once the process poll has slept.
    await new Promise((r) => setTimeout(r, 200));
    mgr.updateState('wt-1', 'waiting', 1);
    await launched;
    // Process poll, then the input-ready and paste settle delays, all real.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200 + 500 + 250 - 20);
    expectSubmitted(stub, `${SESSION}:1`, 'go');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  describe('waiting for the agent to listen', () => {
    /**
     * Process detection succeeds at once; the hook wait's cap never elapses, so
     * only a hook can release the paste. Every other sleep is instant.
     */
    function createHung() {
      const stub = makeStub();
      (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude', command: 'node', pid: 7 }]);
      const mgr = new AgentSessionManager(
        makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub, () => true, 'Test-Host.local',
        (ms) => (ms === 6_000 ? new Promise<void>(() => {}) : Promise.resolve()),
      );
      return { mgr, stub };
    }
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("holds the paste until the window's first hook event, then submits", async () => {
      const { mgr, stub } = createHung();
      const launched = mgr.launch(wt, { prompt: 'go' });
      await flush();
      expect(stub.paste).not.toHaveBeenCalled();
      mgr.updateState('wt-1', 'waiting', 1);
      await launched;
      expectSubmitted(stub, `${SESSION}:1`, 'go');
    });

    it('a hook without a window index releases every waiter of that worktree, and no other', async () => {
      const { mgr, stub } = createHung();
      const other = { ...wt, id: 'wt-2', path: '/tmp/wt-2' };
      const a = mgr.launch(wt, { prompt: 'a' });
      const b = mgr.launch(other, { prompt: 'b' });
      await flush();
      mgr.updateState('wt-1', 'waiting');
      await a;
      expect(stub.paste).toHaveBeenCalledTimes(1);
      mgr.updateState('wt-2', 'waiting', 1);
      await b;
      expect(stub.paste).toHaveBeenCalledTimes(2);
    });

    it('does not wait when the hook already arrived while the process was being detected', async () => {
      const { mgr, stub } = createHung();
      // Fired from inside the process poll, once: updateState itself refreshes
      // titles through listWindows, so an unconditional hook here would recurse.
      let hookFired = false;
      (stub.listWindows as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (!hookFired) { hookFired = true; mgr.updateState('wt-1', 'waiting', 1); }
        return [{ index: 1, name: 'claude', command: 'node', pid: 7 }];
      });
      await mgr.launch(wt, { prompt: 'go' }); // would hang here if it waited
      expectSubmitted(stub, `${SESSION}:1`, 'go');
    });

    it('pastes anyway once the cap passes — hooks the user never trusted do not fire', async () => {
      const { mgr, stub } = create(); // instant sleep: the cap elapses at once
      (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude', command: 'node', pid: 7 }]);
      await mgr.launch(wt, { prompt: 'go' });
      expectSubmitted(stub, `${SESSION}:1`, 'go');
    });

    it('stops waiting, and pastes nothing, when the window is closed meanwhile', async () => {
      const { mgr, stub } = createHung();
      const launched = mgr.launch(wt, { prompt: 'go' });
      await flush();
      await mgr.killWindow('wt-1', 1);
      await launched; // released by the kill, not by the (never-ending) cap
      expect(stub.paste).not.toHaveBeenCalled();
    });

    it('stops waiting, and pastes nothing, when the whole session is killed meanwhile', async () => {
      const { mgr, stub } = createHung();
      const launched = mgr.launch(wt, { prompt: 'go' });
      await flush();
      await mgr.killWorktreeSession('wt-1');
      await launched; // released by the kill, not by the (never-ending) cap
      expect(stub.paste).not.toHaveBeenCalled();
    });

    it('survives the worktree being deleted mid-launch, and does not resurrect its entry', async () => {
      // waitForHook asserted the window's meta was there (a TypeError) and
      // looked it up through windowMap(), which re-created the worktree.
      const { mgr, stub } = create();
      let killed = false;
      (stub.listWindows as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (!killed) { killed = true; await mgr.killWorktreeSession('wt-1'); }
        return [{ index: 1, name: 'claude', command: 'node', pid: 7 }];
      });
      await expect(mgr.launch(wt, { prompt: 'go' })).resolves.toBeDefined();
      expect(stub.paste).not.toHaveBeenCalled();
      expect(mgr.hasTerminals('wt-1')).toBe(false);
      expect((mgr as unknown as { windows: Map<string, unknown> }).windows.has('wt-1')).toBe(false);
    });
  });

  it('does not paste, or wait, when there is no prompt', async () => {
    const { mgr, stub } = create();
    await mgr.launch(wt);
    expect(stub.paste).not.toHaveBeenCalled();
    expect(stub.listWindows).not.toHaveBeenCalled();
  });

  it("announces the worktree's aggregate, so a pending permission elsewhere is not read as answered", async () => {
    const { mgr, stub, stateEvents } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'permission', name: 'claude' }]]);
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    await mgr.launch(wt);
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'permission' }]);
  });

  it('launches an explicitly requested provider instead of the default', async () => {
    const { mgr, stub } = create();
    await mgr.launch(wt, { provider: 'opencode' });
    expect(stub.newWindow).toHaveBeenCalledWith(SESSION, 'opencode', wt.path);
    expect(stub.respawnWindow).toHaveBeenCalledWith(
      SESSION,
      1,
      'STACK_WINDOW_INDEX="1" STACK_WORKSPACE_ID="wt-1" opencode; exec "${SHELL:-/bin/sh}"',
    );
    expect(mgr.getSessions('wt-1')[0].provider).toBe('opencode');
  });

  it('launchWithPrompt delegates to launch with the prompt', async () => {
    const { mgr, stub } = create('my-claude');
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', command: 'node' },
    ]);
    await mgr.launchWithPrompt(wt, 'hello');
    expect(stub.respawnWindow).toHaveBeenCalledWith(
      SESSION,
      1,
      'STACK_WINDOW_INDEX="1" STACK_WORKSPACE_ID="wt-1" my-claude; exec "${SHELL:-/bin/sh}"',
    );
    expectSubmitted(stub, `${SESSION}:1`, 'hello');
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

  it('getWorktreeIdForTerminalName reverse-maps by the label VS Code shows', async () => {
    // The image-drop catcher only ever sees a tab label, never the terminal.
    const { mgr } = create();
    await mgr.launch(wt);
    const viewer = mgr.getViewer('wt-1')!;
    expect(mgr.getWorktreeIdForTerminalName(viewer.name)).toBe('wt-1');
    expect(mgr.getWorktreeIdForTerminalName('some other tab')).toBeUndefined();
  });

  it('viewer terminal runs tmux attach directly, no shell, in the Editor area (no exec $SHELL fallback)', async () => {
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(viewer.creationOptions).toEqual({
      name: 'feat/login',
      cwd: wt.path,
      location: TerminalLocation.Editor,
      shellPath: 'tmux',
      // Exact target: a bare name would also match a view session by prefix.
      shellArgs: ['attach-session', '-t', `=${SESSION}`],
    });
    expect(JSON.stringify(viewer.creationOptions)).not.toContain('exec $SHELL');
  });

  it('viewer name uses alias over branch and appends the window name when given', async () => {
    const { mgr } = create();
    const aliased = { ...wt, alias: 'login-work' };
    const viewer = await mgr.getOrCreateViewer(aliased, 'claude') as unknown as MockTerminal;
    expect(viewer.name).toBe('login-work — claude');
  });

  it('caps a sentence-long alias so the tab cannot swallow the tab bar', async () => {
    const { mgr } = create();
    const essay = { ...wt, alias: '[Shop] Al marcar un pedido como enviado, el descuento se pierde al recalcular el total.' };
    const viewer = await mgr.getOrCreateViewer(essay) as unknown as MockTerminal;
    expect(viewer.name).toBe('[Shop] Al marcar un pedido como…');
    expect(viewer.name.length).toBeLessThan(essay.alias.length);
  });

  it('leaves an alias that already fits untouched (no stray ellipsis)', async () => {
    const { mgr } = create();
    const exact = { ...wt, alias: 'x'.repeat(32) };
    const viewer = await mgr.getOrCreateViewer(exact) as unknown as MockTerminal;
    expect(viewer.name).toBe('x'.repeat(32));
  });

  it('reconnect reclaims a viewer named with the CAPPED label (they must agree)', async () => {
    const stub = makeStub();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', title: '' },
    ]);
    const mgr = new AgentSessionManager(makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub, () => true, 'Test-Host.local');
    const essay = { ...wt, alias: '[Shop] Al marcar un pedido como enviado, el descuento se pierde al recalcular el total.' };
    // A viewer VSCode restored after a reload, carrying the capped name.
    const restored = makeTerminal({ name: '[Shop] Al marcar un pedido como…' });
    window.terminals = [restored as never];
    await mgr.reconnect([essay]);
    expect(mgr.getViewer(essay.id)).toBe(restored as never);
  });

  it('attaches WITHOUT a cwd when the worktree directory is missing (avoids the does-not-exist launch error)', async () => {
    const stub = makeStub();
    // pathExists → false: the worktree dir is gone but its tmux session may still be alive.
    const mgr = new AgentSessionManager(makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub, () => false);
    const viewer = await mgr.getOrCreateViewer(wt) as unknown as MockTerminal;
    expect(viewer.creationOptions.cwd).toBeUndefined();
    expect(viewer.creationOptions.shellArgs).toEqual(['attach-session', '-t', `=${SESSION}`]);
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

  it('getPlainTerminal is an alias of getViewer', async () => {
    const { mgr } = create();
    const viewer = await mgr.getOrCreateViewer(wt);
    expect(mgr.getPlainTerminal('wt-1')).toBe(viewer);
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
  it('selects the tmux window and REUSES the live viewer (never disposes it)', async () => {
    const { mgr, stub } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const existing = await mgr.launch(wt) as unknown as MockTerminal;
    await mgr.focusWindow(wt, 1);
    expect(stub.selectWindow).toHaveBeenLastCalledWith(SESSION, 1);
    // Disposing an editor-area terminal makes VSCode activate a neighbouring tab
    // in the group, flashing a file the user never opened into view.
    expect(existing.dispose).not.toHaveBeenCalled();
    expect(mgr.getViewer('wt-1')).toBe(existing as unknown as vscode.Terminal);
    expect(existing.show).toHaveBeenCalled();
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
    expect(memento.get('stack.sessionOrder')).toEqual({ 'wt-1': [1] });
  });

  it('leaves the saved order untouched when the killed window was not in it', async () => {
    const { mgr, memento } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);
    mgr.setSessionOrder('wt-1', [1]); // 2 not listed
    await mgr.killWindow('wt-1', 2);
    expect(memento.get('stack.sessionOrder')).toEqual({ 'wt-1': [1] });
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
    live(stub, 3);
    expect(await mgr.sendPromptToAgent(wt, 'review this')).toBe(true);
    expect(stub.selectWindow).toHaveBeenCalledWith(SESSION, 3);
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:3`, 'review this');
  });

  it('sends to the one session it is aimed at, and refuses one that is not a live agent', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'agent', provider: 'codex', state: 'active', name: 'codex' }],
      [3, { kind: 'shell', state: 'idle', name: 'shell' }],
    ]);
    live(stub, 1, 2);
    expect(await mgr.sendPromptToAgent(wt, 'x', 2)).toBe(true);
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:2`, 'x');
    expect(await mgr.sendPromptToAgent(wt, 'y', 3)).toBe(false);
    expect(stub.paste).not.toHaveBeenCalledWith(`${SESSION}:3`, 'y');
  });

  it('prefers a ready (waiting/idle/permission) window over a busy one', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    live(stub, 1, 2);
    await mgr.sendPromptToAgent(wt, 'x');
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:2`, 'x');
  });

  it('falls back to the first agent window when none is ready', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [
      [4, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }],
      [5, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }],
    ]);
    live(stub, 4, 5);
    await mgr.sendPromptToAgent(wt, 'x');
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:4`, 'x');
  });

  it('shows the viewer before submitting, which can take a few seconds of confirmation', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    live(stub, 3);
    await mgr.sendPromptToAgent(wt, 'x');
    const shown = window.createTerminal.mock.invocationCallOrder[0];
    const pasted = (stub.paste as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(shown).toBeLessThan(pasted);
  });

  it('prefers an agent at its prompt over one asking for permission', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'permission', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'idle', name: 'claude' }],
    ]);
    live(stub, 1, 2);
    await mgr.sendPromptToAgent(wt, 'x');
    expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:2`, 'x');
  });

  describe('only into a running agent', () => {
    /** Window 3: tmux says `zsh`, and the pane process's command line is `args`. */
    function paneRunning(stub: ISessionManager, args: string) {
      (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 3, name: 'claude', command: 'zsh', pid: 42 }]);
      (stub.processCommandLine as ReturnType<typeof vi.fn>).mockResolvedValue(args);
    }
    const waiting = { kind: 'agent' as const, provider: 'claude' as const, state: 'waiting' as const, name: 'claude' };

    it('never pastes into a window whose agent has exited — what is left there is a shell', async () => {
      // The launch line ends in `exec $SHELL`; review prompts quote code in
      // backticks, which that shell would run as command substitution.
      const { mgr, stub, stateEvents } = create();
      seed(mgr, 'wt-1', [[3, waiting]]);
      paneRunning(stub, '/bin/zsh');
      expect(await mgr.sendPromptToAgent(wt, 'fix `rm -rf ~`')).toBe(false);
      expect(stub.paste).not.toHaveBeenCalled();
      expect(stub.pressEnter).not.toHaveBeenCalled();
      expect(stub.processCommandLine).toHaveBeenCalledWith(42);
      // Found dead on the way: the card says so, and the panel stops offering it.
      expect(mgr.getSessions('wt-1')[0].state).toBe('terminated');
      expect(stateEvents).toContainEqual({ worktreeId: 'wt-1', state: 'terminated' });
      expect(mgr.getAgentCount('wt-1')).toBe(0);
    });

    it('is not fooled by a shell that has children of its own', async () => {
      // An interactive zsh keeps helpers such as gitstatusd as children, so
      // "the pane has a child" is true of a dead agent window too.
      const { mgr, stub } = create();
      seed(mgr, 'wt-1', [[3, waiting]]);
      paneRunning(stub, 'zsh');
      (stub.hasChildProcess as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      expect(await mgr.sendPromptToAgent(wt, 'x')).toBe(false);
      expect(stub.paste).not.toHaveBeenCalled();
    });

    it('sees a running agent through its launch wrapper, which tmux reports as the shell', async () => {
      const { mgr, stub } = create();
      seed(mgr, 'wt-1', [[3, waiting]]);
      paneRunning(stub, 'zsh -c STACK_WINDOW_INDEX="3" STACK_WORKSPACE_ID="wt-1" claude; exec "${SHELL:-/bin/sh}"');
      expect(await mgr.sendPromptToAgent(wt, 'x')).toBe(true);
      expectSubmitted(stub, `${SESSION}:3`, 'x');
    });

    it('moves on from a dead window to a live one', async () => {
      const { mgr, stub } = create();
      seed(mgr, 'wt-1', [
        [3, waiting],
        [4, { ...waiting, state: 'active' }],
      ]);
      (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
        { index: 3, name: 'claude', command: 'zsh', pid: 42 },
        { index: 4, name: 'claude', command: 'node', pid: 43 },
      ]);
      (stub.processCommandLine as ReturnType<typeof vi.fn>).mockResolvedValue('zsh');
      expect(await mgr.sendPromptToAgent(wt, 'x')).toBe(true);
      expect(stub.paste).toHaveBeenCalledWith(`${SESSION}:4`, 'x');
      expect(mgr.getSessions('wt-1').find((s) => s.index === 3)?.state).toBe('terminated');
    });

    it('sends nothing, and condemns nothing, when tmux cannot say', async () => {
      const { mgr, stub } = create();
      seed(mgr, 'wt-1', [[3, waiting]]);
      (stub.listWindows as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no server'));
      expect(await mgr.sendPromptToAgent(wt, 'x')).toBe(false);
      expect(stub.paste).not.toHaveBeenCalled();
      expect(mgr.getSessions('wt-1')[0].state).toBe('waiting');
    });

    it('treats an unreadable command line as unknown, not as dead', async () => {
      const { mgr, stub } = create();
      seed(mgr, 'wt-1', [[3, waiting]]);
      (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 3, name: 'claude', command: 'zsh', pid: 42 }]);
      expect(await mgr.sendPromptToAgent(wt, 'x')).toBe(false);
      expect(mgr.getSessions('wt-1')[0].state).toBe('waiting');
    });

    it('does not announce an end twice when the agent reports it while ps is being asked', async () => {
      const { mgr, stub, stateEvents } = create();
      seed(mgr, 'wt-1', [[3, waiting]]);
      (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 3, name: 'claude', command: 'zsh', pid: 42 }]);
      (stub.processCommandLine as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        mgr.updateState('wt-1', 'terminated', 3); // SessionEnd, on its way already
        return '/bin/zsh';
      });
      expect(await mgr.sendPromptToAgent(wt, 'x')).toBe(false);
      expect(stub.paste).not.toHaveBeenCalled();
      expect(stateEvents.filter((e) => e.state === 'terminated')).toHaveLength(1);
    });

    it('skips a window already known to be terminated', async () => {
      const { mgr, stub } = create();
      seed(mgr, 'wt-1', [[3, { ...waiting, state: 'terminated' }]]);
      live(stub, 3);
      expect(await mgr.sendPromptToAgent(wt, 'x')).toBe(false);
      expect(stub.listWindows).not.toHaveBeenCalled();
    });
  });

  it('pasteToActiveWindow pastes to the session (active pane) without submitting', async () => {
    const { mgr, stub } = create();
    await mgr.pasteToActiveWindow('wt-1', "'/x/shot.png' ");
    expectUnsent(stub, SESSION, "'/x/shot.png' ");
  });
});

// ── submitting a prompt (settle, Enter, confirmation) ────────────────────────

describe('submitting a prompt', () => {
  /** A manager whose sleeps are instant but recorded, interleaved with the tmux calls. */
  function createRecorded() {
    const log: string[] = [];
    const stub = makeStub();
    (stub.paste as ReturnType<typeof vi.fn>).mockImplementation(async () => { log.push('paste'); });
    (stub.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(async () => { log.push('enter'); });
    const mgr = new AgentSessionManager(
      makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub, () => true, 'Test-Host.local',
      async (ms) => { log.push(`sleep ${ms}`); },
    );
    return { mgr, stub, log };
  }
  /** A claude window at its prompt whose hooks have been reaching us. */
  const listening = { kind: 'agent' as const, provider: 'claude' as const, state: 'waiting' as const, name: 'claude', hookSeen: true };
  /**
   * The agent confirms the Nth Enter (1-based) the way Claude Code does: UserPromptSubmit → 'active'.
   * 'none': the event carries no window index (an agent launched before STACK_WINDOW_INDEX).
   */
  function confirmOn(stub: ISessionManager, mgr: AgentSessionManager, nth: number, windowIndex: number | 'none' = 3) {
    let presses = 0;
    (stub.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (++presses === nth) mgr.updateState('wt-1', 'active', windowIndex === 'none' ? undefined : windowIndex);
    });
  }

  it('lets the paste settle before pressing Enter — an Enter during the paste is swallowed', async () => {
    const { mgr, stub, log } = createRecorded();
    seed(mgr, 'wt-1', [[3, { ...listening, hookSeen: false }]]);
    live(stub, 3);
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(log).toEqual(['paste', 'sleep 250', 'enter']);
  });

  it('stops at the first Enter the agent confirms', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, listening]]);
    live(stub, 3);
    confirmOn(stub, mgr, 1);
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  it('presses Enter again when no confirmation comes, at most twice more', async () => {
    const { mgr, stub, log } = createRecorded();
    seed(mgr, 'wt-1', [[3, listening]]);
    live(stub, 3);
    await mgr.sendPromptToAgent(wt, 'review this');
    // Each wait is armed before its Enter, so a confirmation cannot slip in between.
    expect(log).toEqual(['paste', 'sleep 250', 'sleep 2000', 'enter', 'sleep 2000', 'enter', 'sleep 2000', 'enter']);
  });

  it('a retry that gets confirmed ends the retries', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, listening]]);
    live(stub, 3);
    confirmOn(stub, mgr, 2);
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(2);
  });

  it('takes a permission request as confirmation too — the agent is working on it', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, listening]]);
    live(stub, 3);
    (stub.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(async () => mgr.updateState('wt-1', 'permission', 3));
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  it('stops pressing when the agent ends instead — there is nothing left to submit to', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, listening]]);
    live(stub, 3);
    (stub.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(async () => mgr.updateState('wt-1', 'terminated', 3));
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  it('does not take an event that says the agent is still at its prompt as confirmation', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, listening]]);
    live(stub, 3);
    (stub.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(async () => mgr.updateState('wt-1', 'waiting', 3));
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(3);
  });

  it('accepts a confirmation from an agent that sends no window index', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, listening]]);
    live(stub, 3);
    confirmOn(stub, mgr, 1, 'none');
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  it("ignores another window's events", async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, listening], [4, { ...listening, state: 'active' }]]);
    live(stub, 3, 4);
    confirmOn(stub, mgr, 1, 4);
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(3);
  });

  it('presses once when no hook from this window has arrived — silence then proves nothing', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, { ...listening, hookSeen: false }]]);
    live(stub, 3);
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  it('presses once for opencode, which has no submit hook to confirm with', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, { ...listening, provider: 'opencode', name: 'opencode' }]]);
    live(stub, 3);
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  it('never presses again into a window asking for permission — an Enter there is a "yes"', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, { ...listening, state: 'permission' }]]);
    live(stub, 3);
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  it('stops pressing once the window is gone', async () => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[3, listening]]);
    live(stub, 3);
    (stub.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      (mgr as unknown as { windows: Map<string, Map<number, unknown>> }).windows.get('wt-1')!.delete(3);
    });
    await mgr.sendPromptToAgent(wt, 'review this');
    expect(stub.pressEnter).toHaveBeenCalledTimes(1);
  });

  it('a launch waits for the input box after SessionStart, then settles the paste, then submits', async () => {
    const { mgr, stub, log } = createRecorded();
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude', command: 'node', pid: 7 }]);
    // SessionStart arrives while the process is being detected.
    let started = false;
    (stub.listWindows as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (!started) { started = true; mgr.updateState('wt-1', 'waiting', 1); }
      return [{ index: 1, name: 'claude', command: 'node', pid: 7 }];
    });
    (stub.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      log.push('enter');
      mgr.updateState('wt-1', 'active', 1);
    });
    await mgr.launch(wt, { prompt: 'go' });
    expect(log).toEqual(['sleep 500', 'paste', 'sleep 250', 'sleep 2000', 'enter']);
  });
});

// ── reconnect ─────────────────────────────────────────────────────────────────

describe('hasSession', () => {
  it('asks tmux about the worktree\'s own session, so a caller can reattach instead of launching a duplicate', async () => {
    const { mgr, stub } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await mgr.hasSession('wt-1')).toBe(true);
    expect(stub.hasSession).toHaveBeenCalledWith(SESSION);
    expect(await mgr.hasSession('wt-1')).toBe(false);
  });
});

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

  it('finds that first window at base-index 1 too (a common ~/.tmux.conf setting)', async () => {
    const { mgr, stub } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'zsh' },
      { index: 2, name: 'claude' },
      { index: 3, name: 'vim' },
    ]);
    await mgr.reconnect([wt]);
    expect(mgr.getSessions('wt-1').map(s => s.index)).toEqual([2, 3]);
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

  it('does NOT restore a persisted "terminated" — the window still exists, so waiting is the recoverable guess', async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    await memento.update('stack.claudeStates', { 'wt-1': { 1: 'terminated' } });
    const { mgr, stub, stateEvents } = create('claude', memento);
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude' }]);
    await mgr.reconnect([wt]);
    // A stale "terminated" is a dead end: nothing moves it until a hook arrives,
    // and an agent idling at its prompt never fires one.
    expect(mgr.getState('wt-1')).toBe('waiting');
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'waiting' }]);
  });

  it('falls back to waiting when no state was persisted for the worktree', async () => {
    const { mgr, stub } = create();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude' }]);
    await mgr.reconnect([wt]);
    expect(mgr.getState('wt-1')).toBe('waiting');
  });

  describe('against what is actually running', () => {
    const WRAPPER = 'zsh -c STACK_WINDOW_INDEX="1" STACK_WORKSPACE_ID="wt-1" claude; exec "${SHELL:-/bin/sh}"';
    async function reloadWith(persisted: Record<number, AgentSessionState>, args: Record<number, string>) {
      const memento = new FakeMemento() as unknown as vscode.Memento;
      await memento.update('stack.claudeStates', { 'wt-1': persisted });
      const h = create('claude', memento);
      (h.stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (h.stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue(
        Object.keys(args).map((i) => ({ index: Number(i), name: 'claude', command: 'zsh', pid: 100 + Number(i) })),
      );
      (h.stub.processCommandLine as ReturnType<typeof vi.fn>).mockImplementation(async (pid: number) => args[pid - 100]);
      await h.mgr.reconnect([wt]);
      return h;
    }
    const stateOf = (mgr: AgentSessionManager, index: number) => mgr.getSessions('wt-1').find((s) => s.index === index)?.state;

    it('comes back terminated when the agent exited while Stack was away', async () => {
      // Its last hooks went to the previous window's HookServer, which is gone.
      const { mgr } = await reloadWith({ 1: 'active' }, { 1: '/bin/zsh' });
      expect(stateOf(mgr, 1)).toBe('terminated');
      expect(mgr.getAgentCount('wt-1')).toBe(0);
    });

    it('does not bring back "working" — the agent may well have finished since', async () => {
      const { mgr } = await reloadWith({ 1: 'active' }, { 1: WRAPPER });
      expect(stateOf(mgr, 1)).toBe('waiting');
    });

    it('keeps a permission request, which nobody was there to answer', async () => {
      const { mgr } = await reloadWith({ 1: 'permission' }, { 1: WRAPPER });
      expect(stateOf(mgr, 1)).toBe('permission');
    });

    it('fires ONE event per worktree, carrying the aggregate', async () => {
      // Per-window events read as permission → waiting to the notifier, which
      // then cleared a real permission badge.
      const { stateEvents } = await reloadWith({ 1: 'permission', 2: 'waiting' }, { 1: WRAPPER, 2: WRAPPER });
      expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'permission' }]);
    });
  });
});

describe('agent liveness polling', () => {
  const WRAPPER = 'zsh -c STACK_WINDOW_INDEX="1" STACK_WORKSPACE_ID="wt-1" claude; exec "${SHELL:-/bin/sh}"';
  function polled(args: string | Error) {
    vi.useFakeTimers();
    const h = create();
    seed(h.mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }]]);
    (h.stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude', command: 'zsh', pid: 42 }]);
    const ps = h.stub.processCommandLine as ReturnType<typeof vi.fn>;
    if (args instanceof Error) ps.mockRejectedValue(args); else ps.mockResolvedValue(args);
    (h.mgr as unknown as { syncShellPolling(): void }).syncShellPolling();
    return h;
  }
  const timer = (mgr: AgentSessionManager) => (mgr as unknown as { shellTimer?: unknown }).shellTimer;

  it('marks an agent that died without a word terminated, and stops polling for it', async () => {
    // SIGKILL, a crash, Codex's missing SessionEnd: no hook says so, and the
    // session used to sit on "working" forever.
    const { mgr, stateEvents, getTerminalsChanges } = polled('/bin/zsh');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.getState('wt-1')).toBe('terminated');
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'terminated' }]);
    expect(getTerminalsChanges()).toBeGreaterThan(0);
    expect(timer(mgr)).toBeUndefined();
    mgr.dispose();
  });

  it('leaves a running agent alone', async () => {
    const { mgr, stateEvents } = polled(WRAPPER);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.getState('wt-1')).toBe('active');
    expect(stateEvents).toEqual([]);
    mgr.dispose();
  });

  it('condemns nothing when ps cannot answer', async () => {
    const { mgr } = polled(new Error('no ps'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mgr.getState('wt-1')).toBe('active');
    mgr.dispose();
  });

  it('is not asked on hook-driven syncs — an agent that just sent a hook is alive', async () => {
    const { mgr, stub } = polled('/bin/zsh');
    mgr.updateState('wt-1', 'active', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.processCommandLine).not.toHaveBeenCalled();
    mgr.dispose();
  });

  it('drops the answer for a session killed while tmux was answering', async () => {
    const { mgr, stub, stateEvents, getTerminalsChanges } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }]]);
    let answer!: (w: unknown[]) => void;
    (stub.listWindows as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => { answer = r; }));
    const sync = mgr.syncWindows('wt-1', { liveness: true });
    await mgr.killWorktreeSession('wt-1');
    stateEvents.length = 0;
    const changes = getTerminalsChanges();
    // A shell the agent left behind, and a window to adopt: both would be news.
    answer([{ index: 1, name: 'claude', command: 'zsh', pid: 41 }, { index: 2, name: 'codex', command: 'node', pid: 42 }]);
    await sync;
    expect(stub.processCommandLine).not.toHaveBeenCalled();
    expect(stateEvents).toEqual([]);
    expect(getTerminalsChanges()).toBe(changes);
    expect(mgr.hasTerminals('wt-1')).toBe(false);
  });

  it('does not condemn an agent whose session was killed while ps was being asked', async () => {
    const { mgr, stub, stateEvents } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([{ index: 1, name: 'claude', command: 'zsh', pid: 41 }]);
    (stub.processCommandLine as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await mgr.killWorktreeSession('wt-1');
      return '/bin/zsh';
    });
    await mgr.syncWindows('wt-1', { liveness: true });
    expect(stateEvents).toEqual([{ worktreeId: 'wt-1', state: 'idle' }]);
    expect(mgr.getState('wt-1')).toBe('idle');
  });

  it('neither prunes nor condemns a window that appeared while tmux was answering', async () => {
    // The list predates the launch, so the new window is missing from it — not gone.
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }]]);
    let answer!: (w: unknown[]) => void;
    (stub.listWindows as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => { answer = r; }));
    (stub.processCommandLine as ReturnType<typeof vi.fn>).mockResolvedValue('/bin/zsh');
    const sync = mgr.syncWindows('wt-1', { liveness: true });
    seed(mgr, 'wt-1', [[2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    answer([{ index: 1, name: 'claude', command: 'node', pid: 41 }]);
    await sync;
    expect(mgr.getSessions('wt-1').map((s) => [s.index, s.state])).toEqual([[1, 'active'], [2, 'waiting']]);
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

  it('leaves shell windows untitled, but ADOPTS an untracked agent window', async () => {
    // A window Stack did not open — the user pressed Ctrl-b c and started an
    // agent — used to be invisible: the map was only ever written when Stack
    // itself acted. Adoption is limited to windows whose name identifies a
    // provider, so the session's own initial shell never becomes a row.
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[2, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 2, name: 'shell', title: 'some shell title' },
      { index: 9, name: 'claude', title: 'untracked window' },
    ]);

    await mgr.syncWindows('wt-1');

    const byIndex = Object.fromEntries(mgr.getSessions('wt-1').map((s) => [s.index, s]));
    expect(byIndex[2].title).toBeUndefined();       // still a shell
    expect(byIndex[9].kind).toBe('agent');
    expect(byIndex[9].provider).toBe('claude');
    expect(byIndex[9].title).toBe('untracked window');
  });

  it('does not adopt a window whose name is not a provider', async () => {
    // Window 0 is an artefact of `new-session`; surfacing it would put a
    // session row on every card that nobody asked for.
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 0, name: 'zsh', title: 'my-host.local' },
      { index: 1, name: 'claude', title: 'working' },
    ]);

    await mgr.syncWindows('wt-1');

    expect(mgr.getSessions('wt-1').map((s) => s.index)).toEqual([1]);
  });

  it('drops a window tmux no longer has, so a closed session stops haunting the card', async () => {
    // `exit` inside a window left a row that could not be focused or killed.
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', title: 'still here' },
    ]);

    await mgr.syncWindows('wt-1');

    expect(mgr.getSessions('wt-1').map((s) => s.index)).toEqual([1]);
  });

  it('prunes nothing when tmux returns nothing — that is an error, not an empty session', async () => {
    // listWindows returns [] both when the session is gone AND when the command
    // failed. Pruning on that would wipe every session on a transient error.
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await mgr.syncWindows('wt-1');

    expect(mgr.getSessions('wt-1')).toHaveLength(1);
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
  it('updateState writes PER-WINDOW states to globalState under stack.claudeStates', () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const { mgr } = create('claude', memento);
    seed(mgr, 'wt-1', [
      [1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
      [2, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }],
    ]);
    mgr.updateState('wt-1', 'permission', 2);
    expect(memento.get('stack.claudeStates')).toEqual({ 'wt-1': { 1: 'waiting', 2: 'permission' } });
  });

  it('launch persists waiting for the new window; killWorktreeSession clears the worktree entry', async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const { mgr } = create('claude', memento);
    await mgr.launch(wt);
    expect((memento.get('stack.claudeStates') as Record<string, unknown>)['wt-1']).toEqual({ 1: 'waiting' });
    await mgr.killWorktreeSession('wt-1');
    expect((memento.get('stack.claudeStates') as Record<string, unknown>)['wt-1']).toEqual({});
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
    memento.update('stack.claudeStates', { 'wt-1': 'permission' });
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

  it('dispose drops its onDidCloseTerminal listener', () => {
    const { mgr } = create();
    const subscription = window.onDidCloseTerminal.mock.results.at(-1)?.value as { dispose: ReturnType<typeof vi.fn> };
    expect(subscription.dispose).not.toHaveBeenCalled();
    mgr.dispose();
    expect(subscription.dispose).toHaveBeenCalledTimes(1);
  });
});

// ── shell rows labelled with what they are running ───────────────────────────

describe('shell command labels', () => {
  /** A manager already tracking one shell window, with tmux replying `windows`. */
  const withShell = async (windows: Array<Record<string, unknown>>) => {
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue(windows);
    await mgr.syncWindows('wt-1');
    return { mgr, stub };
  };

  it('shows the process the shell is running, in the agents\' subtitle slot', async () => {
    // The row reads "shell / npm" the way an agent reads "claude / <task>".
    const { mgr } = await withShell([{ index: 1, name: 'shell', title: '', command: 'npm' }]);
    const session = mgr.getSessions('wt-1')[0];
    expect(session?.name).toBe('shell');
    expect(session?.title).toBe('npm');
  });

  it('says nothing when the shell is just sitting at its prompt', async () => {
    // pane_current_command is the shell itself then, which is the row's own name
    // and tells the user nothing.
    const { mgr } = await withShell([{ index: 1, name: 'shell', title: '', command: 'zsh' }]);
    expect(mgr.getSessions('wt-1')[0]?.title).toBeUndefined();
  });

  it('recognises a login shell, which tmux reports with a leading dash', async () => {
    const { mgr } = await withShell([{ index: 1, name: 'shell', title: '', command: '-bash' }]);
    expect(mgr.getSessions('wt-1')[0]?.title).toBeUndefined();
  });

  it('strips the dash from a real command too', async () => {
    const { mgr } = await withShell([{ index: 1, name: 'shell', title: '', command: '-vim' }]);
    expect(mgr.getSessions('wt-1')[0]?.title).toBe('vim');
  });

  it('ignores an empty or whitespace command', async () => {
    expect((await withShell([{ index: 1, name: 'shell', title: '', command: '' }]))
      .mgr.getSessions('wt-1')[0]?.title).toBeUndefined();
    expect((await withShell([{ index: 1, name: 'shell', title: '', command: '  ' }]))
      .mgr.getSessions('wt-1')[0]?.title).toBeUndefined();
    expect((await withShell([{ index: 1, name: 'shell', title: '' }]))
      .mgr.getSessions('wt-1')[0]?.title).toBeUndefined();
  });

  it('clears the label when the command finishes', async () => {
    const { mgr, stub } = await withShell([{ index: 1, name: 'shell', title: '', command: 'sleep' }]);
    expect(mgr.getSessions('wt-1')[0]?.title).toBe('sleep');

    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'shell', title: '', command: 'zsh' },
    ]);
    await mgr.syncWindows('wt-1');

    expect(mgr.getSessions('wt-1')[0]?.title).toBeUndefined();
  });

  it('leaves an agent\'s task title alone', async () => {
    // Agents keep taking their subtitle from pane_title; the command would only
    // ever say "node".
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'claude', title: 'Investigating the Slack bug', command: 'node' },
    ]);
    await mgr.syncWindows('wt-1');
    expect(mgr.getSessions('wt-1')[0]?.title).toBe('Investigating the Slack bug');
  });

  it('labels a shell on reconnect, before any poll has run', async () => {
    const stub = makeStub();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'shell', title: '', command: 'psql' },
    ]);
    const mgr = new AgentSessionManager(
      makeFactory(), new FakeMemento() as unknown as vscode.Memento, stub, () => true, 'Test-Host.local',
    );
    await mgr.reconnect([wt]);
    expect(mgr.getSessions('wt-1')[0]?.title).toBe('psql');
    mgr.dispose();
  });
});

// ── the poll that keeps those labels alive ───────────────────────────────────

describe('shell polling', () => {
  const timer = (mgr: AgentSessionManager) =>
    (mgr as unknown as { shellTimer?: unknown }).shellTimer;

  it('does not poll when nothing can change: no shell, and every agent already terminated', () => {
    vi.useFakeTimers();
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'terminated', name: 'claude' }]]);
    (mgr as unknown as { syncShellPolling(): void }).syncShellPolling();
    expect(timer(mgr)).toBeUndefined();
    mgr.dispose();
  });

  it('polls an agent-only worktree, for an exit no hook reports', () => {
    // A SIGKILL, a crash, or Codex (no SessionEnd) sends nothing: hook events
    // alone left such a session "working" forever.
    vi.useFakeTimers();
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'active', name: 'claude' }]]);
    (mgr as unknown as { syncShellPolling(): void }).syncShellPolling();
    expect(timer(mgr)).toBeDefined();
    mgr.dispose();
  });

  it('polls once a shell exists, and keeps its labels current', async () => {
    // syncWindows is otherwise only reached from a hook event — an AGENT's
    // heartbeat — so without this a shell in a worktree with no agent running
    // would be labelled once and then frozen.
    vi.useFakeTimers();
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'shell', title: '', command: 'npm' },
    ]);
    (mgr as unknown as { syncShellPolling(): void }).syncShellPolling();
    expect(timer(mgr)).toBeDefined();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(stub.listWindows).toHaveBeenCalledWith(SESSION);
    expect(mgr.getSessions('wt-1')[0]?.title).toBe('npm');
    mgr.dispose();
  });

  it('runs one timer however many worktrees have shells', () => {
    vi.useFakeTimers();
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    seed(mgr, 'wt-2', [[1, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    const sync = (mgr as unknown as { syncShellPolling(): void });
    sync.syncShellPolling();
    const first = timer(mgr);
    sync.syncShellPolling();
    expect(timer(mgr)).toBe(first);
    mgr.dispose();
  });

  it('polls every worktree that has a shell, and no others', async () => {
    vi.useFakeTimers();
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    seed(mgr, 'wt-2', [[1, { kind: 'agent', provider: 'claude', state: 'terminated', name: 'claude' }]]);
    (mgr as unknown as { syncShellPolling(): void }).syncShellPolling();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(stub.listWindows).toHaveBeenCalledWith(SESSION);
    expect(stub.listWindows).not.toHaveBeenCalledWith('stack-wt-2');
    mgr.dispose();
  });

  it('stops once the last shell is gone', () => {
    vi.useFakeTimers();
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell' }]]);
    const sync = (mgr as unknown as { syncShellPolling(): void });
    sync.syncShellPolling();
    expect(timer(mgr)).toBeDefined();

    (mgr as unknown as { windowMap(id: string): Map<number, unknown> }).windowMap('wt-1').clear();
    sync.syncShellPolling();

    expect(timer(mgr)).toBeUndefined();
    mgr.dispose();
  });

  it('survives a tmux failure with the last known label still on screen', async () => {
    // Blanking the row on a hiccup is worse than showing a slightly stale one.
    vi.useFakeTimers();
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell', title: 'npm' }]]);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no server'));
    (mgr as unknown as { syncShellPolling(): void }).syncShellPolling();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(mgr.getSessions('wt-1')[0]?.title).toBe('npm');
    mgr.dispose();
  });

  it('starts polling when a terminal is opened, and clears the timer on dispose', async () => {
    vi.useFakeTimers();
    const { mgr, stub } = create();
    (stub.newWindow as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    await mgr.openTerminal(wt);
    expect(timer(mgr)).toBeDefined();

    mgr.dispose();
    expect(timer(mgr)).toBeUndefined();
  });
});

// ── naming a session ─────────────────────────────────────────────────────────

describe('session aliases', () => {
  const shell = (index: number) =>
    [index, { kind: 'shell' as const, state: 'idle' as const, name: 'shell' }] as const;

  it('shows the name the user gave instead of the window name', () => {
    // The point of the feature: a shell running redis reads "redis".
    const { mgr } = create();
    seed(mgr, 'wt-1', [shell(1)]);
    mgr.setSessionAlias('wt-1', 1, 'redis');
    const session = mgr.getSessions('wt-1')[0];
    expect(session?.alias).toBe('redis');
    // The window name is untouched — it is what identifies an agent on reload.
    expect(session?.name).toBe('shell');
  });

  it('names only the session asked for', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [shell(1), shell(2)]);
    mgr.setSessionAlias('wt-1', 1, 'redis');
    expect(mgr.getSessions('wt-1').map((x) => x.alias)).toEqual(['redis', undefined]);
  });

  it('trims, and an empty name clears it', () => {
    // Clearing is the only way back to the derived label, so a blank answer
    // must not set a blank name.
    const { mgr } = create();
    seed(mgr, 'wt-1', [shell(1)]);
    mgr.setSessionAlias('wt-1', 1, '  redis  ');
    expect(mgr.getSessions('wt-1')[0]?.alias).toBe('redis');
    mgr.setSessionAlias('wt-1', 1, '   ');
    expect(mgr.getSessions('wt-1')[0]?.alias).toBeUndefined();
  });

  it('wins over the running-command label', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'shell', state: 'idle', name: 'shell', title: 'redis-server' }]]);
    mgr.setSessionAlias('wt-1', 1, 'cache');
    const session = mgr.getSessions('wt-1')[0];
    expect(session?.alias).toBe('cache');
    expect(session?.title).toBe('redis-server'); // still shown underneath
  });

  it('names an agent session too', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [[1, { kind: 'agent', provider: 'claude', state: 'waiting', name: 'claude' }]]);
    mgr.setSessionAlias('wt-1', 1, 'the refactor one');
    expect(mgr.getSessions('wt-1')[0]?.alias).toBe('the refactor one');
  });

  it('survives a reload', async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const first = create('claude', memento);
    seed(first.mgr, 'wt-1', [shell(1)]);
    first.mgr.setSessionAlias('wt-1', 1, 'redis');
    first.mgr.dispose();

    const stub = makeStub();
    (stub.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 1, name: 'shell', title: '', command: 'redis-server' },
    ]);
    const revived = new AgentSessionManager(makeFactory(), memento, stub, () => true, 'Test-Host.local');
    await revived.reconnect([wt]);

    expect(revived.getSessions('wt-1')[0]?.alias).toBe('redis');
    revived.dispose();
  });

  it('forgets the name when the window is killed', async () => {
    // tmux reuses window indexes, so a name left behind would land on whatever
    // opens in that slot next.
    const { mgr } = create();
    seed(mgr, 'wt-1', [shell(1)]);
    mgr.setSessionAlias('wt-1', 1, 'redis');
    await mgr.killWindow('wt-1', 1);

    seed(mgr, 'wt-1', [shell(1)]);
    expect(mgr.getSessions('wt-1')[0]?.alias).toBeUndefined();
  });

  it('forgets the name when the window disappears from tmux', async () => {
    // Not an EMPTY reply — syncWindows treats that as "no information", since a
    // failed command looks exactly like a vanished session. tmux has to say the
    // window is gone by listing the others.
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [shell(1), shell(2)]);
    mgr.setSessionAlias('wt-1', 1, 'redis');
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([
      { index: 2, name: 'shell', title: '', command: 'zsh' },
    ]);
    await mgr.syncWindows('wt-1');

    seed(mgr, 'wt-1', [shell(1)]);
    expect(mgr.getSessions('wt-1').find((x) => x.index === 1)?.alias).toBeUndefined();
  });

  it('keeps every name when tmux says nothing at all', async () => {
    // An empty reply is a failed command as often as an empty session; pruning
    // on it would wipe the names off a card because the tmux server hiccuped.
    const { mgr, stub } = create();
    seed(mgr, 'wt-1', [shell(1)]);
    mgr.setSessionAlias('wt-1', 1, 'redis');
    (stub.listWindows as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await mgr.syncWindows('wt-1');

    expect(mgr.getSessions('wt-1')[0]?.alias).toBe('redis');
  });

  it('forgets every name when the whole session is killed', async () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [shell(1), shell(2)]);
    mgr.setSessionAlias('wt-1', 1, 'redis');
    mgr.setSessionAlias('wt-1', 2, 'worker');
    await mgr.killWorktreeSession('wt-1');

    seed(mgr, 'wt-1', [shell(1), shell(2)]);
    expect(mgr.getSessions('wt-1').map((x) => x.alias)).toEqual([undefined, undefined]);
  });

  it('keeps one worktree\'s names out of another\'s', () => {
    const { mgr } = create();
    seed(mgr, 'wt-1', [shell(1)]);
    seed(mgr, 'wt-2', [shell(1)]);
    mgr.setSessionAlias('wt-1', 1, 'redis');
    expect(mgr.getSessions('wt-2')[0]?.alias).toBeUndefined();
  });

  it('tells the UI a name changed', () => {
    const { mgr, getTerminalsChanges } = create();
    seed(mgr, 'wt-1', [shell(1)]);
    const before = getTerminalsChanges();
    mgr.setSessionAlias('wt-1', 1, 'redis');
    expect(getTerminalsChanges()).toBe(before + 1);
  });
});


// ── capturePane ─────────────────────────────────────────────────────────────

describe('capturePane', () => {
  it('reads one session\'s pane through tmux', async () => {
    const { mgr, stub } = create();
    expect(await mgr.capturePane('wt-1', 4, 50)).toBe('pane text');
    expect(stub.capturePane).toHaveBeenCalledWith(`${SESSION}:4`, 50);
  });
});
