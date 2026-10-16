import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForemanWebviewProvider, PUSH_COALESCE_MS } from '../../src/sidebar/ForemanWebviewProvider';
import { Uri, window, resetVscodeMock } from '../__mocks__/vscode';
import type { WorktreeApplicationService } from '../../src/application/WorktreeApplicationService';
import type { AgentSessionManager } from '../../src/session/AgentSessionManager';
import type { GitWatcher } from '../../src/git/GitWatcher';
import type { ForemanState, WebMessage } from '../../src/webview/types';

// ── harness ──────────────────────────────────────────────────────────────────

/** A subscription whose dispose is observable. */
function disposable() {
  return { dispose: vi.fn() };
}

function makeWebviewView(visible = true) {
  const webview = {
    options: undefined as unknown,
    html: '',
    cspSource: 'csp-src',
    onDidReceiveMessage: vi.fn(() => disposable()),
    postMessage: vi.fn(async (_msg: unknown) => true),
    asWebviewUri: vi.fn((u: Uri) => u),
  };
  return {
    webview,
    visible,
    badge: undefined as { value: number; tooltip: string } | undefined,
    description: undefined as string | undefined,
    show: vi.fn(),
    onDidChangeVisibility: vi.fn(() => disposable()),
    onDidDispose: vi.fn(() => disposable()),
  };
}

const emptyState: ForemanState = { worktrees: [], activeWorktreeId: undefined };

/** Minimal WorktreeItem carrying just the agent state the header summarises. */
function item(id: string, agent: 'idle' | 'active' | 'permission' | 'waiting'): ForemanState['worktrees'][number] {
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
    onStateChange: vi.fn((cb: () => void) => { stateListeners.push(cb); return disposable(); }),
    onTerminalsChange: vi.fn((cb: () => void) => { terminalsListeners.push(cb); return disposable(); }),
  };
  const gitWatcher = { onChange: vi.fn((cb: () => void) => { gitListeners.push(cb); return disposable(); }) };
  const service = {
    handleMessage: vi.fn(async () => {}),
    buildState: vi.fn((): ForemanState => emptyState),
    handleActiveTerminalChange: vi.fn(),
  };

  const provider = new ForemanWebviewProvider(
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
  const onMessage = (view.webview.onDidReceiveMessage.mock.calls[0] as unknown[])[0] as (msg: WebMessage) => void;
  const onVisibility = (view.onDidChangeVisibility.mock.calls[0] as unknown[])[0] as () => void;
  const onDispose = (view.onDidDispose.mock.calls[0] as unknown[])[0] as () => void;
  return { view, onMessage, onVisibility, onDispose };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** Lets the coalescing window close, so whatever was pushed goes out. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
}

beforeEach(() => {
  resetVscodeMock();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

  it('pushes the initial state when the view is visible', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    await settle();
    expect(h.service.buildState).toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: 'state', payload: emptyState });
  });

  it('pushes what changed while hidden when the view becomes visible', async () => {
    const h = makeHarness();
    const { view, onVisibility } = resolve(h);
    await settle();
    view.webview.postMessage.mockClear();
    h.service.buildState.mockReturnValue({ worktrees: [item('a', 'active')] });
    onVisibility();
    await settle();
    expect(view.webview.postMessage).toHaveBeenCalledTimes(1);
  });

  it('does not push when the view is hidden', async () => {
    const h = makeHarness();
    const { view, onVisibility } = resolve(h, false);
    await settle();
    expect(view.webview.postMessage).not.toHaveBeenCalled();
    onVisibility();
    await settle();
    expect(view.webview.postMessage).not.toHaveBeenCalled();
  });

  it('drops a push that was pending when the view got hidden', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    view.visible = false;
    await settle();
    expect(view.webview.postMessage).not.toHaveBeenCalled();
  });

  it('subscribes to agent state/terminal changes and git changes, pushing on each', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    await settle();
    let n = 0;
    h.service.buildState.mockImplementation(() => ({ worktrees: [], activeWorktreeId: String(n++) }));
    view.webview.postMessage.mockClear();
    for (const fire of [h.stateListeners[0], h.terminalsListeners[0], h.gitListeners[0]]) {
      fire();
      await settle();
    }
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
  it('is a no-op before the view is resolved', async () => {
    const h = makeHarness();
    expect(() => h.provider.push()).not.toThrow();
    await settle();
    expect(h.service.buildState).not.toHaveBeenCalled();
  });

  it('coalesces a burst of pushes into one state, built once', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    for (let i = 0; i < 10; i++) h.stateListeners[0]();
    await settle();
    expect(h.service.buildState).toHaveBeenCalledOnce();
    expect(view.webview.postMessage).toHaveBeenCalledOnce();
  });

  it('builds the state when the window closes, so it carries the latest change', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    h.service.buildState.mockReturnValue({ worktrees: [item('late', 'active')] });
    h.gitListeners[0]();
    await settle();
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: 'state', payload: { worktrees: [item('late', 'active')] },
    });
  });

  it('does not re-send a state the webview already has', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    await settle();
    h.stateListeners[0]();
    await settle();
    h.gitListeners[0]();
    await settle();
    expect(h.service.buildState).toHaveBeenCalledTimes(3);
    expect(view.webview.postMessage).toHaveBeenCalledOnce();
  });

  it('re-sends after the page says it is ready, even when nothing changed', async () => {
    // The ready handshake exists because the first state can be lost while
    // the bundle loads; deduplication must not swallow the answer to it.
    const h = makeHarness();
    h.service.handleMessage.mockImplementation(async () => { h.provider.push(); });
    const { view, onMessage } = resolve(h);
    await settle();
    onMessage({ type: 'ready' });
    await flush();
    await settle();
    expect(view.webview.postMessage).toHaveBeenCalledTimes(2);
  });

  it('re-sends a state the webview did not take', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    view.webview.postMessage.mockResolvedValueOnce(false);
    await settle();
    h.stateListeners[0]();
    await settle();
    expect(view.webview.postMessage).toHaveBeenCalledTimes(2);
  });

  it('re-sends a state whose delivery failed', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    view.webview.postMessage.mockRejectedValueOnce(new Error('disposed'));
    await settle();
    h.stateListeners[0]();
    await settle();
    expect(view.webview.postMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps the dedup of a newer state when an older delivery reports late', async () => {
    const h = makeHarness();
    const { view } = resolve(h);
    let answer!: (ok: boolean) => void;
    view.webview.postMessage.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));
    await settle(); // first state in flight
    h.service.buildState.mockReturnValue({ worktrees: [item('b', 'idle')] });
    h.stateListeners[0]();
    await settle(); // second state sent and delivered
    answer(false); // the first one turns out to have been dropped
    await flush();
    h.stateListeners[0]();
    await settle();
    // The page holds the second state, which is what is current: nothing to send.
    expect(view.webview.postMessage).toHaveBeenCalledTimes(2);
  });
});

describe('subscriptions', () => {
  function allSubscriptions(h: ReturnType<typeof makeHarness>, view: ReturnType<typeof makeWebviewView>) {
    return [
      ...view.webview.onDidReceiveMessage.mock.results,
      ...view.onDidChangeVisibility.mock.results,
      ...view.onDidDispose.mock.results,
      ...h.agentManager.onStateChange.mock.results,
      ...h.agentManager.onTerminalsChange.mock.results,
      ...h.gitWatcher.onChange.mock.results,
      ...window.onDidChangeActiveTerminal.mock.results,
    ].map((r) => r.value as { dispose: ReturnType<typeof vi.fn> });
  }

  it('re-resolving disposes the previous view\'s subscriptions instead of stacking more', async () => {
    const h = makeHarness();
    const first = resolve(h);
    const firstSubs = allSubscriptions(h, first.view);
    expect(firstSubs).toHaveLength(7);

    const second = resolve(h);
    for (const s of firstSubs) expect(s.dispose).toHaveBeenCalledOnce();

    // One event, one state — not one per resolve the window has seen.
    await settle();
    second.view.webview.postMessage.mockClear();
    h.service.buildState.mockClear();
    h.stateListeners.at(-1)!();
    await settle();
    expect(h.service.buildState).toHaveBeenCalledOnce();
    expect(first.view.webview.postMessage).not.toHaveBeenCalled();
  });

  it('disposing the view releases everything and forgets it', async () => {
    const h = makeHarness();
    const { view, onDispose } = resolve(h);
    const subs = allSubscriptions(h, view);

    onDispose();

    for (const s of subs) expect(s.dispose).toHaveBeenCalledOnce();
    await settle(); // the initial push was pending: it must not go out
    expect(view.webview.postMessage).not.toHaveBeenCalled();
    h.provider.push();
    h.provider.setBadge(1);
    await settle();
    expect(h.service.buildState).not.toHaveBeenCalled();
    expect(view.badge).toBeUndefined();
  });

  it('a stale view\'s dispose does not tear down its replacement', async () => {
    const h = makeHarness();
    const first = resolve(h);
    const second = resolve(h);
    const secondSubs = allSubscriptions(h, second.view).filter((s) => !allSubscriptions(h, first.view).includes(s));

    first.onDispose();

    for (const s of secondSubs) expect(s.dispose).not.toHaveBeenCalled();
    await settle();
    expect(second.view.webview.postMessage).toHaveBeenCalledOnce();
  });

  it('a failing message handler is logged, not left as an unhandled rejection', async () => {
    const h = makeHarness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.service.handleMessage.mockRejectedValueOnce(new Error('boom'));
    const { onMessage } = resolve(h);

    onMessage({ type: 'listBranches' });
    await flush();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('"listBranches" failed'), expect.any(Error));
    error.mockRestore();
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

describe('header description', () => {
  it('summarises the live counts on every push', async () => {
    const h = makeHarness();
    h.service.buildState.mockReturnValue({
      worktrees: [item('a', 'active'), item('b', 'active'), item('c', 'permission')],
      activeWorktreeId: 'a',
    });
    const { view } = resolve(h);
    await settle();
    expect(view.description).toBe('2 thinking · 1 needs you');
  });

  it.each([
    { agents: [] as Array<'idle' | 'active' | 'permission'>, expected: undefined },
    { agents: ['idle'] as const, expected: undefined },
    { agents: ['active'] as const, expected: '1 thinking' },
    { agents: ['permission'] as const, expected: '1 needs you' },
  ])('describe($agents) → $expected', ({ agents, expected }) => {
    const state: ForemanState = {
      worktrees: agents.map((a, i) => item(String(i), a)),
      activeWorktreeId: undefined,
    };
    expect(ForemanWebviewProvider.describe(state)).toBe(expected);
  });
});
