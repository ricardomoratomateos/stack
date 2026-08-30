import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, Uri } from '../__mocks__/vscode';
import { NewTaskPanelManager, type NewTaskPanelHost } from '../../src/newtask/NewTaskPanelManager';
import type { NewTaskExtMessage, NewTaskMessage } from '../../src/newtask/types';

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

function makeHost(over: Partial<NewTaskPanelHost> = {}): NewTaskPanelHost {
  return {
    branchOptions: vi.fn(() => ({ branches: ['main', 'develop'], baseBranch: 'main' })),
    createWorktree: vi.fn(async () => {}),
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
    expect(panel.posted).toEqual([
      { type: 'init', init: { branches: ['main', 'develop'], baseBranch: 'main' } },
    ]);
  });

  it('creates the worktree and closes, so the user lands back in their editor', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'create', branch: 'feat/x', title: 'Fix X', description: 'do it', baseBranch: 'develop' });
    expect(host.createWorktree).toHaveBeenCalledWith({
      branch: 'feat/x', title: 'Fix X', description: 'do it', baseBranch: 'develop',
    });
    expect(panel.dispose).toHaveBeenCalled();
  });

  it('still closes when creating the worktree fails', async () => {
    // The failure is reported by the service that raised it; leaving the form
    // open on top of it would just bury the message.
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ createWorktree: vi.fn(async () => { throw new Error('branch exists'); }) });
    new NewTaskPanelManager(extUri, host).open();

    await panel.fire({ type: 'create', branch: 'feat/x' });
    expect(panel.dispose).toHaveBeenCalled();
  });

  it('closes on cancel', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    new NewTaskPanelManager(extUri, makeHost()).open();

    await panel.fire({ type: 'cancel' });
    expect(panel.dispose).toHaveBeenCalled();
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
