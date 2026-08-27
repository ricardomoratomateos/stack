import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnmessWebviewProvider } from '../../src/sidebar/UnmessWebviewProvider';
import { Uri, window, resetVscodeMock } from '../__mocks__/vscode';
import type { WorktreeApplicationService } from '../../src/application/WorktreeApplicationService';
import type { AgentSessionManager } from '../../src/session/AgentSessionManager';
import type { GitWatcher } from '../../src/git/GitWatcher';
import type { UnmessState, WebMessage } from '../../src/webview/types';

// ── harness ──────────────────────────────────────────────────────────────────

function makeWebviewView(visible = true) {
  const webview = {
    options: undefined as unknown,
    html: '',
    cspSource: 'csp-src',
    onDidReceiveMessage: vi.fn(),
    postMessage: vi.fn(),
    asWebviewUri: vi.fn((u: Uri) => u),
  };
  return {
    webview,
    visible,
    badge: undefined as { value: number; tooltip: string } | undefined,
    description: undefined as string | undefined,
    show: vi.fn(),
    onDidChangeVisibility: vi.fn(),
  };
}

const emptyState: UnmessState = { worktrees: [], activeWorktreeId: undefined };

/** Minimal WorktreeItem carrying just the agent state the header summarises. */
function item(id: string, agent: 'idle' | 'active' | 'permission' | 'waiting'): UnmessState['worktrees'][number] {
  return {
    id, branch: `feat/${id}`, path: `/repo/${id}`, isMain: false, deleting: false,
    agent, agentCount: 1, terminalCount: 0, sessions: [],
    git: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 },
    docker: [], pr: null,
  };
}

function makeHarness() {
  const stateListeners: Array<() => void> = [];
  const terminalsListeners: Array<() => void> = [];
  const gitListeners: Array<() => void> = [];

  const agentManager = {
    onStateChange: vi.fn((cb: () => void) => { stateListeners.push(cb); return { dispose: vi.fn() }; }),
    onTerminalsChange: vi.fn((cb: () => void) => { terminalsListeners.push(cb); return { dispose: vi.fn() }; }),
  };
  const gitWatcher = { onChange: vi.fn((cb: () => void) => { gitListeners.push(cb); }) };
  const service = {
    handleMessage: vi.fn(async () => {}),
    buildState: vi.fn((): UnmessState => emptyState),
    handleActiveTerminalChange: vi.fn(),
  };

  const provider = new UnmessWebviewProvider(
    Uri.file('/ext') as never,
    agentManager as unknown as AgentSessionManager,
    gitWatcher as unknown as GitWatcher,
    service as unknown as WorktreeApplicationService,
  );

  return { provider, agentManager, gitWatcher, service, stateListeners, terminalsListeners, gitListeners };
}

function resolve(h: ReturnType<typeof makeHarness>, visible = true) {
  const view = makeWebviewView(visible);
  h.provider.resolveWebviewView(view as never);
  const onMessage = view.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: WebMessage) => void;
  const onVisibility = view.onDidChangeVisibility.mock.calls[0][0] as () => void;
  return { view, onMessage, onVisibility };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  resetVscodeMock();
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveWebviewView
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveWebviewView', () => {
  it('enables scripts and restricts resources to the dist folder', () => {
    const h = makeHarness();
    const { view } = resolve(h);
    const options = view.webview.options as { enableScripts: boolean; localResourceRoots: Uri[] };
    expect(options.enableScripts).toBe(true);
    expect(options.localResourceRoots).toHaveLength(1);
    expect(options.localResourceRoots[0].fsPath).toBe('/ext/dist');
  });

  it('renders HTML with the webview script, codicon css and a nonce-based CSP', () => {
    const h = makeHarness();
    const { view } = resolve(h);
    const html = view.webview.html;
    expect(html).toContain('file:///ext/dist/webview.js');
    expect(html).toContain('file:///ext/dist/codicon.css');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('csp-src');
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}"`);
  });

  it('pushes the initial state when the view is visible', () => {
    const h = makeHarness();
    const { view } = resolve(h);
    expect(h.service.buildState).toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'state', payload: emptyState });
  });

  it('pushes again when the view becomes visible', () => {
    const h = makeHarness();
    const { view, onVisibility } = resolve(h);
    view.webview.postMessage.mockClear();
    onVisibility();
    expect(view.webview.postMessage).toHaveBeenCalledTimes(1);
  });

  it('does not push when the view is hidden', () => {
    const h = makeHarness();
    const { view, onVisibility } = resolve(h, false);
    expect(view.webview.postMessage).not.toHaveBeenCalled();
    onVisibility();
    expect(view.webview.postMessage).not.toHaveBeenCalled();
  });

  it('subscribes to claude state/terminal changes and git changes, pushing on each', () => {
    const h = makeHarness();
    const { view } = resolve(h);
    view.webview.postMessage.mockClear();
    h.stateListeners[0]();
    h.terminalsListeners[0]();
    h.gitListeners[0]();
    expect(view.webview.postMessage).toHaveBeenCalledTimes(3);
  });

  it('forwards active-terminal changes to the service (selection sync)', () => {
    const h = makeHarness();
    resolve(h);
    const listener = window.onDidChangeActiveTerminal.mock.calls[0][0] as (t: unknown) => void;
    const terminal = { name: 'viewer' };
    listener(terminal);
    expect(h.service.handleActiveTerminalChange).toHaveBeenCalledWith(terminal);
  });
});

describe('setBadge', () => {
  it('is safe before the view resolves and applies the pending count on resolve', () => {
    const h = makeHarness();
    expect(() => h.provider.setBadge(2)).not.toThrow();
    const { view } = resolve(h);
    expect(view.badge).toEqual({ value: 2, tooltip: '2 agent sessions need your attention' });
  });

  it('sets a singular-form badge for one pending session', () => {
    const h = makeHarness();
    const { view } = resolve(h);
    h.provider.setBadge(1);
    expect(view.badge).toEqual({ value: 1, tooltip: '1 agent session needs your attention' });
  });

  it('clears the badge when the count drops to zero', () => {
    const h = makeHarness();
    const { view } = resolve(h);
    h.provider.setBadge(3);
    h.provider.setBadge(0);
    expect(view.badge).toBeUndefined();
  });
});

describe('push', () => {
  it('is a no-op before the view is resolved', () => {
    const h = makeHarness();
    expect(() => h.provider.push()).not.toThrow();
    expect(h.service.buildState).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// message dispatch — every message is forwarded to the application service
// ─────────────────────────────────────────────────────────────────────────────

describe('message dispatch', () => {
  // Keyed by WebMessage['type'], so removing or renaming a message is a
  // compile error here rather than a case that quietly keeps passing. Three of
  // these used to reference `launchClaude`, `pickAgent` and a `focusSession`
  // with kind 'claude' — none of which had existed in the protocol for a while.
  // The `as WebMessage[]` cast hid it and the assertion only checked blind
  // forwarding, so thirteen cases stayed green against an API that was gone.
  const SAMPLES: { [K in WebMessage['type']]: Extract<WebMessage, { type: K }> } = {
    ready: { type: 'ready' },
    launchAgent: { type: 'launchAgent', worktreeId: 'a' },
    pickDefaultProvider: { type: 'pickDefaultProvider' },
    showProviderInstall: { type: 'showProviderInstall', provider: 'claude' },
    openTerminal: { type: 'openTerminal', worktreeId: 'a' },
    focusTerminal: { type: 'focusTerminal', worktreeId: 'a' },
    focusSession: { type: 'focusSession', worktreeId: 'a', kind: 'agent', index: 1 },
    killSession: { type: 'killSession', worktreeId: 'a', index: 1 },
    reorderSessions: { type: 'reorderSessions', worktreeId: 'a', orderedIndexes: [1] },
    reorderWorktrees: { type: 'reorderWorktrees', orderedIds: ['a'] },
    dockerUp: { type: 'dockerUp', worktreeId: 'a' },
    dockerDown: { type: 'dockerDown', worktreeId: 'a' },
    deleteWorktree: { type: 'deleteWorktree', worktreeId: 'a' },
    renameWorktree: { type: 'renameWorktree', worktreeId: 'a' },
    initWorktree: { type: 'initWorktree', worktreeId: 'a' },
    createWorktree: { type: 'createWorktree', branch: 'b' },
    selectWorktree: { type: 'selectWorktree', worktreeId: 'a' },
    listBranches: { type: 'listBranches' },
    openDiff: { type: 'openDiff', worktreeId: 'a' },
  };

  it.each(Object.values(SAMPLES))('delegates $type to the application service', async (msg) => {
    const h = makeHarness();
    const { onMessage } = resolve(h);
    onMessage(msg);
    await flush();
    expect(h.service.handleMessage).toHaveBeenCalledWith(msg);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// native view header: title description + the "+" that opens the modal
// ─────────────────────────────────────────────────────────────────────────────

describe('openNewTask', () => {
  it('reveals the view and asks the webview to open its new-task modal', () => {
    const h = makeHarness();
    const { view } = resolve(h);
    h.provider.openNewTask();
    expect(view.show).toHaveBeenCalledWith(true);
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'openNewTask' });
  });

  it('is a no-op before the view has been resolved', () => {
    const h = makeHarness();
    expect(() => h.provider.openNewTask()).not.toThrow();
  });
});

describe('header description', () => {
  it('summarises the live counts on every push', () => {
    const h = makeHarness();
    h.service.buildState.mockReturnValue({
      worktrees: [item('a', 'active'), item('b', 'active'), item('c', 'permission')],
      activeWorktreeId: 'a',
    });
    const { view } = resolve(h);
    expect(view.description).toBe('2 thinking · 1 needs you');
  });

  it.each([
    { agents: [] as Array<'idle' | 'active' | 'permission'>, expected: undefined },
    { agents: ['idle'] as const, expected: undefined },
    { agents: ['active'] as const, expected: '1 thinking' },
    { agents: ['permission'] as const, expected: '1 needs you' },
  ])('describe($agents) → $expected', ({ agents, expected }) => {
    const state: UnmessState = {
      worktrees: agents.map((a, i) => item(String(i), a)),
      activeWorktreeId: undefined,
    };
    expect(UnmessWebviewProvider.describe(state)).toBe(expected);
  });
});
