import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, Uri } from '../__mocks__/vscode';
import { SettingsPanelManager, type SettingsPanelHost } from '../../src/settings/SettingsPanelManager';
import type { SettingsExtMessage, SettingsMessage, SettingsSnapshot } from '../../src/settings/types';

function makePanel() {
  let handler: ((m: SettingsMessage) => void) | undefined;
  let disposer: (() => void) | undefined;
  const posted: SettingsExtMessage[] = [];
  return {
    webview: {
      cspSource: 'vscode-webview:',
      html: '',
      asWebviewUri: (u: Uri) => u,
      onDidReceiveMessage: (h: (m: SettingsMessage) => void) => { handler = h; return { dispose() {} }; },
      postMessage: (m: SettingsExtMessage) => { posted.push(m); return Promise.resolve(true); },
    },
    reveal: vi.fn(),
    dispose: vi.fn(() => disposer?.()),
    onDidDispose: (h: () => void) => { disposer = h; return { dispose() {} }; },
    posted,
    fire: (m: SettingsMessage) => handler?.(m) as unknown as Promise<void> | void,
  };
}

const snapshot: SettingsSnapshot = {
  repoRoot: '/repo',
  project: {
    worktreesDirectory: '.worktrees', defaultBaseBranch: 'main', setupScript: '', teardownScript: '',
    docker: { composeFile: 'docker-compose.yml', overrideFile: 'docker-compose.worktree.yml', ports: [], basePort: 20000, portStride: 100 },
    debugBasePort: 9898, debugTemplate: { type: 'node', request: 'attach', name: 'Foreman: Debug', port: '{{PORT}}' },
  },
  projectFile: { path: '/repo/.foreman/config.json', present: false, problems: [] },
  personalOverrides: [],
  user: {
    defaultProvider: 'claude', claudeCommand: 'claude', codexCommand: 'codex', opencodeCommand: 'opencode',
    notifyOnAttention: true, focusMode: false, scopeSearchToActiveWorktree: true,
  },
  installedProviders: ['claude'],
  branches: ['main', 'develop'],
  detected: { composeFiles: [], portVars: [] },
};

function makeHost(over: Partial<SettingsPanelHost> = {}): SettingsPanelHost {
  return {
    snapshot: vi.fn(() => snapshot),
    pickFile: vi.fn(async () => 'docker/compose.yml'),
    createScript: vi.fn(async (kind) => `.foreman/${kind}.sh`),
    saveProject: vi.fn(async () => []),
    saveUser: vi.fn(async () => {}),
    clearPersonalOverrides: vi.fn(async () => {}),
    openProjectFile: vi.fn(async () => {}),
    ...over,
  };
}

const extUri = Uri.file('/ext');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { window.createWebviewPanel.mockReset(); });

describe('SettingsPanelManager', () => {
  it('opens one panel with the settings bundle and reveals it on a second open', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const m = new SettingsPanelManager(extUri, makeHost());
    m.open();
    m.open();
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(window.createWebviewPanel.mock.calls[0][1]).toBe('Foreman settings');
    expect(panel.webview.html).toContain('settingsPanel.js');
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });

  it('answers ready with a snapshot', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    new SettingsPanelManager(extUri, makeHost()).open();
    await panel.fire({ type: 'ready' });
    expect(panel.posted).toEqual([{ type: 'snapshot', snapshot }]);
  });

  it('relays a picked file to the field that asked, and nothing when the dialog is cancelled', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ pickFile: vi.fn(async (field) => (field === 'composeFile' ? 'compose.yml' : undefined)) });
    new SettingsPanelManager(extUri, host).open();
    await panel.fire({ type: 'pickFile', field: 'composeFile' });
    await panel.fire({ type: 'pickFile', field: 'setupScript' });
    await flush();
    expect(panel.posted).toEqual([{ type: 'picked', field: 'composeFile', path: 'compose.yml' }]);
  });

  it('creates a starter script and fills the matching field', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    new SettingsPanelManager(extUri, makeHost()).open();
    await panel.fire({ type: 'createScript', kind: 'teardown' });
    await flush();
    expect(panel.posted).toEqual([{ type: 'picked', field: 'teardownScript', path: '.foreman/teardown.sh' }]);
  });

  it('saves the project, reports the problems the file reads back with, then pushes a fresh snapshot', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ saveProject: vi.fn(async () => ['"docker.basePort" must be a whole number']) });
    new SettingsPanelManager(extUri, host).open();
    await panel.fire({ type: 'saveProject', values: snapshot.project });
    await flush();
    expect(host.saveProject).toHaveBeenCalledWith(snapshot.project);
    expect(panel.posted).toEqual([
      { type: 'saved', scope: 'project', problems: ['"docker.basePort" must be a whole number'] },
      { type: 'snapshot', snapshot },
    ]);
  });

  it('turns a thrown save into a problem instead of a dead button', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ saveUser: vi.fn(async () => { throw new Error('EACCES'); }) });
    new SettingsPanelManager(extUri, host).open();
    await panel.fire({ type: 'saveUser', values: snapshot.user });
    await flush();
    expect(panel.posted[0]).toEqual({ type: 'saved', scope: 'user', problems: ['Error: EACCES'] });
  });

  it('forgets a disposed panel so the next open creates a new one', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const m = new SettingsPanelManager(extUri, makeHost());
    m.open();
    panel.dispose();
    m.open();
    expect(window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it('createScript for setup reports the setup field', async () => {
    // The teardown side is covered above; this is the other half of the ternary
    // that decides which field the panel fills in.
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ createScript: vi.fn(async () => '.foreman/setup.sh') });
    new SettingsPanelManager(extUri, host).open();

    await panel.fire({ type: 'createScript', kind: 'setup' });
    await flush();
    expect(panel.posted).toContainEqual({
      type: 'picked', field: 'setupScript', path: '.foreman/setup.sh',
    });
  });

  it('clearPersonalOverrides clears and re-reads, so the panel shows the project values', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost();
    new SettingsPanelManager(extUri, host).open();
    panel.posted.length = 0;

    await panel.fire({ type: 'clearPersonalOverrides' });
    await flush();
    expect(host.clearPersonalOverrides).toHaveBeenCalled();
    expect(panel.posted).toContainEqual({ type: 'snapshot', snapshot });
  });

  it('still refreshes when clearing the overrides fails', async () => {
    // Whatever is on screen is now of unknown accuracy either way; re-reading is
    // the only thing that can make it true again.
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ clearPersonalOverrides: vi.fn(async () => { throw new Error('nope'); }) });
    new SettingsPanelManager(extUri, host).open();
    panel.posted.length = 0;

    await panel.fire({ type: 'clearPersonalOverrides' });
    await flush();
    expect(panel.posted).toContainEqual({ type: 'snapshot', snapshot });
  });

  it('openProjectFile opens it, and survives it not being there', async () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const host = makeHost({ openProjectFile: vi.fn(async () => { throw new Error('missing'); }) });
    new SettingsPanelManager(extUri, host).open();

    await expect(panel.fire({ type: 'openProjectFile' })).resolves.not.toThrow();
    expect(host.openProjectFile).toHaveBeenCalled();
  });

  it('dispose closes an open panel and is a no-op without one', () => {
    const panel = makePanel();
    window.createWebviewPanel.mockReturnValue(panel);
    const mgr = new SettingsPanelManager(extUri, makeHost());

    expect(() => mgr.dispose()).not.toThrow();
    mgr.open();
    mgr.dispose();
    expect(panel.dispose).toHaveBeenCalled();
    expect(() => mgr.dispose()).not.toThrow();
  });
});
