import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, Uri } from '../__mocks__/vscode';
import { DiffPanelManager, type DiffPanelHost } from '../../src/diff/DiffPanelManager';
import type { DiffPanelMessage, DiffPanelExtMessage } from '../../src/diff/types';

interface FakePanel {
  webview: {
    cspSource: string;
    html: string;
    asWebviewUri: (u: Uri) => Uri;
    onDidReceiveMessage: (h: (m: DiffPanelMessage) => void) => { dispose: () => void };
    postMessage: (m: DiffPanelExtMessage) => Promise<boolean>;
  };
  reveal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onDidDispose: (h: () => void) => { dispose: () => void };
  posted: DiffPanelExtMessage[];
  fire: (m: DiffPanelMessage) => Promise<void> | void;
  triggerDispose: () => void;
}

function makePanel(): FakePanel {
  let handler: ((m: DiffPanelMessage) => void) | undefined;
  let disposer: (() => void) | undefined;
  const posted: DiffPanelExtMessage[] = [];
  return {
    webview: {
      cspSource: 'vscode-webview:',
      html: '',
      asWebviewUri: (u) => u,
      onDidReceiveMessage: (h) => { handler = h; return { dispose() {} }; },
      postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
    },
    reveal: vi.fn(),
    dispose: vi.fn(() => disposer?.()),
    onDidDispose: (h) => { disposer = h; return { dispose() {} }; },
    posted,
    fire: (m) => handler?.(m),
    triggerDispose: () => disposer?.(),
  };
}

function makeHost(over: Partial<DiffPanelHost> = {}): DiffPanelHost {
  return {
    getDiff: vi.fn(async () => 'DIFF'),
    getContext: vi.fn(() => ({ label: 'Fix X', hasLiveAgent: true })),
    send: vi.fn(async () => true),
    openFile: vi.fn(async () => {}),
    ...over,
  };
}

const extUri = Uri.file('/ext');

beforeEach(() => {
  window.createWebviewPanel.mockReset();
});

describe('DiffPanelManager', () => {
  it('creates a panel, titles it from the context, and sets html', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new DiffPanelManager(extUri, host).open('wt-1');

    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(window.createWebviewPanel.mock.calls[0][1]).toBe('Review: Fix X');
    expect(panel.webview.html).toContain('diffPanel.js');
    expect(panel.webview.html).toContain('diff2html.css');
  });

  it('titles the panel "Review" when there is no context', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    new DiffPanelManager(extUri, makeHost({ getContext: vi.fn(() => undefined) })).open('wt-1');
    expect(window.createWebviewPanel.mock.calls[0][1]).toBe('Review');
  });

  it('reveals the existing panel instead of creating a second one', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const mgr = new DiffPanelManager(extUri, makeHost());
    mgr.open('wt-1');
    mgr.open('wt-1');
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });

  it('on "ready" pushes the branch diff with context', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new DiffPanelManager(extUri, host).open('wt-1');

    await panel.fire({ type: 'ready' });
    expect(host.getDiff).toHaveBeenCalledWith('wt-1', 'branch');
    expect(panel.posted).toContainEqual({ type: 'diff', base: 'branch', unified: 'DIFF', hasLiveAgent: true, label: 'Fix X' });
  });

  it('on "requestDiff" pushes the requested base', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new DiffPanelManager(extUri, host).open('wt-1');

    await panel.fire({ type: 'requestDiff', base: 'working' });
    expect(host.getDiff).toHaveBeenCalledWith('wt-1', 'working');
    expect(panel.posted.at(-1)).toMatchObject({ type: 'diff', base: 'working' });
  });

  it('posts an error when the worktree context is gone', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    // Context present at open (for the title), gone by the time a diff is requested.
    const getContext = vi.fn()
      .mockReturnValueOnce({ label: 'Fix X', hasLiveAgent: false })
      .mockReturnValue(undefined);
    new DiffPanelManager(extUri, makeHost({ getContext })).open('wt-1');

    await panel.fire({ type: 'ready' });
    expect(panel.posted).toContainEqual({ type: 'error', message: 'Worktree not found.' });
  });

  it('falls back to an empty diff when getDiff throws', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ getDiff: vi.fn(async () => { throw new Error('git boom'); }) });
    new DiffPanelManager(extUri, host).open('wt-1');

    await panel.fire({ type: 'requestDiff', base: 'branch' });
    expect(panel.posted.at(-1)).toMatchObject({ type: 'diff', unified: '' });
  });

  it('on "send" relays the destination and reports ok', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new DiffPanelManager(extUri, host).open('wt-1');

    const comments = [{ file: 'a.ts', side: 'new' as const, line: 1, body: 'x' }];
    await panel.fire({ type: 'send', destination: 'new', comments });
    expect(host.send).toHaveBeenCalledWith('wt-1', 'new', comments);
    expect(panel.posted).toContainEqual({ type: 'sent', destination: 'new', ok: true });
  });

  it('reports ok:false when send throws', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ send: vi.fn(async () => { throw new Error('nope'); }) });
    new DiffPanelManager(extUri, host).open('wt-1');

    await panel.fire({ type: 'send', destination: 'live', comments: [] });
    expect(panel.posted).toContainEqual({ type: 'sent', destination: 'live', ok: false });
  });

  it('on "openFile" delegates to the host', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new DiffPanelManager(extUri, host).open('wt-1');

    await panel.fire({ type: 'openFile', path: 'src/a.ts', line: 5 });
    expect(host.openFile).toHaveBeenCalledWith('wt-1', 'src/a.ts', 5);
  });

  it('swallows openFile errors', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ openFile: vi.fn(async () => { throw new Error('missing'); }) });
    new DiffPanelManager(extUri, host).open('wt-1');
    await expect(panel.fire({ type: 'openFile', path: 'x' })).resolves.toBeUndefined();
  });

  it('drops the panel on dispose so reopening creates a fresh one', () => {
    const p1 = makePanel();
    const p2 = makePanel();
    window.createWebviewPanel.mockReturnValueOnce(p1).mockReturnValueOnce(p2);
    const mgr = new DiffPanelManager(extUri, makeHost());
    mgr.open('wt-1');
    p1.triggerDispose();
    mgr.open('wt-1');
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it('dispose() tears down every open panel', () => {
    const p1 = makePanel();
    const p2 = makePanel();
    window.createWebviewPanel.mockReturnValueOnce(p1).mockReturnValueOnce(p2);
    const mgr = new DiffPanelManager(extUri, makeHost());
    mgr.open('wt-1');
    mgr.open('wt-2');
    mgr.dispose();
    expect(p1.dispose).toHaveBeenCalled();
    expect(p2.dispose).toHaveBeenCalled();
  });
});
