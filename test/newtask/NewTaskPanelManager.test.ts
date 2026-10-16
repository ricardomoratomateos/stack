import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, Uri } from '../__mocks__/vscode';
import { NewTaskPanelManager, type NewTaskPanelHost } from '../../src/newtask/NewTaskPanelManager';
import type { NewTaskExtMessage, NewTaskInit, NewTaskMessage } from '../../src/newtask/types';

function makePanel() {
  let handler: ((m: NewTaskMessage) => void) | undefined;
  let disposer: (() => void) | undefined;
  const posted: NewTaskExtMessage[] = [];
  return {
    webview: {
      cspSource: 'vscode-webview:',
      html: '',
      asWebviewUri: (u: Uri) => u,
      onDidReceiveMessage: (h: (m: NewTaskMessage) => void) => { handler = h; return { dispose() {} }; },
      postMessage: (m: NewTaskExtMessage) => { posted.push(m); return Promise.resolve(true); },
    },
    reveal: vi.fn(),
    dispose: vi.fn(() => disposer?.()),
    onDidDispose: (h: () => void) => { disposer = h; return { dispose() {} }; },
    posted,
    fire: (m: NewTaskMessage) => handler?.(m) as unknown as Promise<void> | void,
  };
}

const INIT: NewTaskInit = {
  branches: ['main', 'develop'], baseBranch: 'main', sidebarStyle: 'claude',
  defaultProvider: 'codex', installedProviders: ['claude', 'codex'],
};

function makeHost(over: Partial<NewTaskPanelHost> = {}): NewTaskPanelHost {
  return {
    init: vi.fn(() => INIT),
    sidebarStyle: vi.fn(() => 'claude' as const),
    createWorktree: vi.fn(async () => ({ ok: true })),
    showProviderInstall: vi.fn(async () => {}),
    confirmDiscard: vi.fn(async () => true),
    ...over,
  };
}

const extUri = Uri.file('/ext');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { window.createWebviewPanel.mockReset(); });

describe('NewTaskPanelManager', () => {
  it('creates one panel and renders the bundle into it', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    new NewTaskPanelManager(extUri, makeHost()).open();

    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('newTaskPanel.js');
    expect(panel.webview.html).toContain('id="root"');
  });

  it('titles the tab "New task" and tells the page which style to wear before it loads', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    new NewTaskPanelManager(extUri, makeHost()).open();

    expect(window.createWebviewPanel.mock.calls[0][1]).toBe('New task');
    expect(panel.webview.html).toContain('<title>New task</title>');
    expect(panel.webview.html).toContain('<body data-style="claude">');
  });

  it('gives each panel its own nonce, and uses it for the script tag', () => {
    const a = makePanel(); const b = makePanel();
    window.createWebviewPanel.mockReturnValueOnce(a).mockReturnValueOnce(b);
    const mgr = new NewTaskPanelManager(extUri, makeHost());
    mgr.open();
    mgr.dispose();
    mgr.open();

    const nonceOf = (html: string) => /nonce-([a-f0-9]{32})/.exec(html)?.[1];
    expect(nonceOf(a.webview.html)).toBeDefined();
    expect(nonceOf(a.webview.html)).not.toBe(nonceOf(b.webview.html));
    expect(a.webview.html).toContain(`<script nonce="${nonceOf(a.webview.html)}"`);
  });

  it('reveals the existing panel instead of opening a second one', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const mgr = new NewTaskPanelManager(extUri, makeHost());
    mgr.open();
    mgr.open();

    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });

  it('answers "ready" with the branch options', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new NewTaskPanelManager(extUri, host).open();

    panel.fire({ type: 'ready' });
    expect(panel.posted).toEqual([{ type: 'init', init: INIT }]);
  });

  it('re-sends its inputs on refresh, so a changed setting reaches an open panel', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    const mgr = new NewTaskPanelManager(extUri, host);
    mgr.open();

    (host.init as ReturnType<typeof vi.fn>).mockReturnValue({ ...INIT, sidebarStyle: 'aside' });
    mgr.refresh();
    expect(panel.posted).toEqual([{ type: 'init', init: { ...INIT, sidebarStyle: 'aside' } }]);
  });

  it('creates the worktree and closes, so the user lands back in their editor', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'create', branch: 'feat/x', title: 'Fix X', description: 'do it', baseBranch: 'develop', provider: 'codex' });
    expect(host.createWorktree).toHaveBeenCalledWith({
      branch: 'feat/x', title: 'Fix X', description: 'do it', baseBranch: 'develop', provider: 'codex',
    });
    expect(panel.dispose).toHaveBeenCalled();
    expect(panel.posted).toEqual([]);
  });

  it('stays open and reports the reason when creating the worktree fails', async () => {
    // Closing would throw away the prompt the user just spent minutes writing.
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ createWorktree: vi.fn(async () => ({ ok: false, error: 'branch exists' })) });
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'create', branch: 'feat/x' });
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(panel.posted).toEqual([{ type: 'error', message: 'branch exists' }]);
  });

  it('says something even when a failure arrives without a reason', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ createWorktree: vi.fn(async () => ({ ok: false })) });
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'create', branch: 'feat/x' });
    expect(panel.posted).toEqual([{ type: 'error', message: 'Could not create the worktree.' }]);
  });

  it('treats a rejection from the host as a failure to report, not a crash', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ createWorktree: vi.fn(async () => { throw new Error('boom'); }) });
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'create', branch: 'feat/x' });
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(panel.posted).toEqual([{ type: 'error', message: 'Error: boom' }]);
  });

  it('closes on cancel', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    new NewTaskPanelManager(extUri, makeHost()).open();

    await panel.fire({ type: 'cancel' });
    expect(panel.dispose).toHaveBeenCalled();
  });

  it('closes a clean cancel without asking', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'cancel', dirty: false });
    expect(host.confirmDiscard).not.toHaveBeenCalled();
    expect(panel.dispose).toHaveBeenCalled();
  });

  it('asks before discarding a written description, and keeps the panel on "no"', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ confirmDiscard: vi.fn(async () => false) });
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'cancel', dirty: true });
    expect(host.confirmDiscard).toHaveBeenCalled();
    expect(panel.dispose).not.toHaveBeenCalled();
  });

  it('discards a written description once the user agrees', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    new NewTaskPanelManager(extUri, makeHost()).open();

    await panel.fire({ type: 'cancel', dirty: true });
    expect(panel.dispose).toHaveBeenCalled();
  });

  it('explains how to install an agent that is not on PATH', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'showProviderInstall', provider: 'opencode' });
    expect(host.showProviderInstall).toHaveBeenCalledWith('opencode');
    expect(panel.dispose).not.toHaveBeenCalled();
  });

  it('forgets a panel the user closed, so the next open builds a fresh one', () => {
    const a = makePanel(); const b = makePanel();
    window.createWebviewPanel.mockReturnValueOnce(a).mockReturnValueOnce(b);
    const mgr = new NewTaskPanelManager(extUri, makeHost());
    mgr.open();
    a.dispose();
    mgr.open();

    expect(window.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(b.reveal).not.toHaveBeenCalled();
  });

  it('dispose is a no-op with no panel open, and closes one that is', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const mgr = new NewTaskPanelManager(extUri, makeHost());

    expect(() => mgr.dispose()).not.toThrow();
    mgr.open();
    mgr.dispose();
    expect(panel.dispose).toHaveBeenCalled();
  });

  it('drops a message that arrives after the panel is gone', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const mgr = new NewTaskPanelManager(extUri, makeHost());
    mgr.open();
    mgr.dispose();

    await panel.fire({ type: 'ready' });
    await flush();
    expect(panel.posted).toEqual([]);
  });
});
