import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import {
  WorktreeApplicationService,
  ACTIVE_WORKTREE_KEY,
  type IWorkspaceHost,
} from '../../src/application/WorktreeApplicationService';
import { VsCodeNotifyAdapter } from '../../src/adapters/VsCodeNotifyAdapter';
import { window, ProgressLocation, resetVscodeMock } from '../__mocks__/vscode';
import type { Worktree, UnmessConfig } from '../../src/types';
import type { SessionItem } from '../../src/webview/types';
import type { WorktreeManager } from '../../src/worktree/WorktreeManager';
import type { AgentSessionManager } from '../../src/session/AgentSessionManager';
import type { TabManager } from '../../src/worktree/TabManager';
import type { ConfigManager } from '../../src/config/ConfigManager';
import type { GitWatcher } from '../../src/git/GitWatcher';
import type { DockerMonitor } from '../../src/docker/DockerMonitor';
import type { PrMonitor } from '../../src/pr/PrMonitor';
import type { IGitPort } from '../../src/ports/IGitPort';
import type { IWorktreeRepository } from '../../src/ports/IWorktreeRepository';

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

function makeWorktree(over: Partial<Worktree> = {}): Worktree {
  const branch = over.branch ?? 'feat/a';
  return {
    id: 'id-a',
    branch,
    path: '/repo/zer/feat-a',
    repoRoot: '/repo',
    xdebugPort: 9899,
    dockerProjectName: branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
    createdAt: 1,
    ...over,
  };
}

interface HarnessOpts {
  worktrees?: Worktree[];
  persistedActiveId?: string;
  config?: Partial<UnmessConfig>;
  /** worktree ids that currently have an open viewer terminal */
  viewerIds?: string[];
  /** worktree ids for which hasTerminals() returns true */
  terminalIds?: string[];
  workspaceFolders?: string[];
  /** paths for which host.isDirectory returns true */
  gitDirs?: string[];
  /** paths for which host.exists returns true */
  existingPaths?: string[];
  withUi?: boolean;
  confirmResult?: string | undefined;
  sessions?: SessionItem[];
  /** unified diff returned by git.diff */
  diffOutput?: string;
  /** what agentManager.sendPromptToAgent resolves to (a live agent existed) */
  liveAgentAccepts?: boolean;
  /** path returned by host.findLatestScreenshot */
  latestScreenshot?: string;
}

function makeHarness(o: HarnessOpts = {}) {
  const calls: string[] = [];
  const worktrees = o.worktrees ?? [];
  const cfg: UnmessConfig = {
    worktreesDirectory: './zer',
    setupScript: '',
    teardownScript: '',
    defaultProvider: 'claude',
    claudeCommand: 'claude',
    scopeSearchToActiveWorktree: true,
    docker: {
      composeFile: 'docker-compose.yml',
      overrideFile: 'docker-compose.worktree.yml',
      ports: [],
      basePort: 20000,
      portStride: 100,
    },
    xdebugBasePort: 9898,
    debugTemplate: { type: 'php', request: 'launch', name: 'Unmess: Debug', port: '{{PORT}}' },
    ...o.config,
  };

  const viewers = new Map<string, { show: ReturnType<typeof vi.fn> }>();
  const makeViewer = (id: string) => {
    const v = { show: vi.fn(() => { calls.push(`viewer.show:${id}`); }) };
    viewers.set(id, v);
    return v;
  };
  for (const id of o.viewerIds ?? []) makeViewer(id);

  const dockerCallbacks = new Map<string, () => void>();
  const prCallbacks = new Map<string, () => void>();

  const claude = {
    launch: vi.fn((w: Worktree) => { calls.push(`claude.launch:${w.id}`); return Promise.resolve(); }),
    launchWithPrompt: vi.fn((w: Worktree, prompt: string) => { calls.push(`claude.launchWithPrompt:${w.id}:${prompt}`); return Promise.resolve(); }),
    openTerminal: vi.fn((w: Worktree) => { calls.push(`claude.openTerminal:${w.id}`); return Promise.resolve(); }),
    getOrCreateViewer: vi.fn(async (w: Worktree) => {
      calls.push(`claude.getOrCreateViewer:${w.id}`);
      return viewers.get(w.id) ?? makeViewer(w.id);
    }),
    focusWindow: vi.fn(async (w: Worktree, i: number) => { calls.push(`claude.focusWindow:${w.id}:${i}`); }),
    getSessions: vi.fn((_id: string) => o.sessions ?? []),
    killWindow: vi.fn(async (id: string, i: number) => { calls.push(`claude.killWindow:${id}:${i}`); }),
    pasteToActiveWindow: vi.fn(async (id: string, text: string) => { calls.push(`claude.pasteToActiveWindow:${id}:${text}`); }),
    getViewer: vi.fn((id: string) => viewers.get(id)),
    getState: vi.fn(() => 'idle'),
    getAgentCount: vi.fn(() => 2),
    getShellCount: vi.fn(() => 1),
    hasTerminals: vi.fn((id: string) => (o.terminalIds ?? []).includes(id)),
    closeViewer: vi.fn(async (id: string) => { calls.push(`claude.closeViewer:${id}`); }),
    killWorktreeSession: vi.fn(async (id: string) => { calls.push(`claude.killWorktreeSession:${id}`); }),
    register: vi.fn((id: string) => { calls.push(`claude.register:${id}`); }),
    reconnect: vi.fn(async () => { calls.push('claude.reconnect'); }),
    sendPromptToAgent: vi.fn(async (w: Worktree, prompt: string) => {
      calls.push(`claude.sendPromptToAgent:${w.id}:${prompt}`);
      return o.liveAgentAccepts ?? true;
    }),
  };

  const tabManager = {
    updateViewerState: vi.fn((wts: Array<{ id: string }>, ids: Set<string>) => {
      calls.push(`tab.updateViewerState:${wts.map(w => w.id).join(',')}:${[...ids].sort().join(',')}`);
    }),
    closeOtherTabs: vi.fn(async (id: string) => { calls.push(`tab.closeOtherTabs:${id}`); }),
    restoreTabs: vi.fn((id: string) => { calls.push(`tab.restoreTabs:${id}`); return Promise.resolve(); }),
  };
  const breakpointManager = { activate: vi.fn() };

  const folders = [...(o.workspaceFolders ?? [])];
  const terminalsCreated: Array<{ name: string; cwd: string; show: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn> }> = [];
  let activeTerminal: unknown;
  const host = {
    workspaceFolderPaths: vi.fn(() => [...folders]),
    removeWorkspaceFolder: vi.fn((i: number) => { calls.push(`host.removeWorkspaceFolder:${i}`); folders.splice(i, 1); }),
    addWorkspaceFolders: vi.fn((...fs: Array<{ path: string; name: string }>) => {
      calls.push(`host.addWorkspaceFolders:${fs.map(f => `${f.path}=${f.name}`).join('|')}`);
      folders.push(...fs.map(f => f.path));
    }),
    renameWorkspaceFolder: vi.fn((i: number, f: { path: string; name: string }) => {
      calls.push(`host.renameWorkspaceFolder:${i}:${f.path}=${f.name}`);
    }),
    saveAll: vi.fn(async (u: boolean) => { calls.push(`host.saveAll:${u}`); }),
    moveEditorToFirstInGroup: vi.fn(async () => { calls.push('host.moveEditorToFirstInGroup'); }),
    createTerminal: vi.fn((opts: { name: string; cwd: string }) => {
      const t = {
        name: opts.name,
        cwd: opts.cwd,
        show: vi.fn(() => { calls.push(`terminal.show:${opts.name}`); }),
        sendText: vi.fn((txt: string) => { calls.push(`terminal.sendText:${txt}`); }),
      };
      terminalsCreated.push(t);
      calls.push(`host.createTerminal:${opts.name}:${opts.cwd}`);
      return t;
    }),
    showInputBox: vi.fn(async (): Promise<string | undefined> => undefined),
    showQuickPick: vi.fn(async (): Promise<string | undefined> => undefined),
    updateFolderSetting: vi.fn(async (folderPath: string, section: string, value: unknown) => {
      calls.push(`host.updateFolderSetting:${folderPath}:${section}:${value === undefined ? 'clear' : JSON.stringify(value)}`);
    }),
    activeTerminal: vi.fn(() => activeTerminal),
    exists: vi.fn((p: string) => (o.existingPaths ?? []).includes(p)),
    isDirectory: vi.fn((p: string) => (o.gitDirs ?? []).includes(p)),
    writeClipboard: vi.fn(async (text: string) => { calls.push(`host.writeClipboard:${text}`); }),
    openFileInEditor: vi.fn(async (p: string, line?: number) => { calls.push(`host.openFileInEditor:${p}:${line ?? ''}`); }),
    findLatestScreenshot: vi.fn(async (): Promise<string | undefined> => o.latestScreenshot),
  };

  const notify = {
    showError: vi.fn((m: string) => { calls.push(`notify.showError:${m}`); }),
    showWarning: vi.fn((m: string) => { calls.push(`notify.showWarning:${m}`); }),
    showInfo: vi.fn(),
    confirm: vi.fn(async (m: string) => { calls.push(`notify.confirm:${m}`); return o.confirmResult; }),
    withProgress: vi.fn(async (title: string, task: (report: (m: string) => void) => Promise<unknown>) => {
      calls.push(`withProgress:${title}`);
      return task((m) => calls.push(`report:${m}`));
    }),
  };

  const store = {
    getAll: vi.fn(() => worktrees),
    get: vi.fn((id: string) => worktrees.find(w => w.id === id)),
    add: vi.fn(),
    patch: vi.fn(),
    setAlias: vi.fn(async (id: string, alias: string) => { calls.push(`store.setAlias:${id}:${alias}`); }),
    remove: vi.fn(),
    getPortRegistry: vi.fn(() => ({})),
  };

  const manager = {
    list: vi.fn(() => worktrees),
    reconcile: vi.fn(async (root: string) => {
      calls.push(`manager.reconcile:${root}`);
      return { adopted: [], removed: [], current: worktrees };
    }),
    create: vi.fn(),
    delete: vi.fn(async (id: string, db: boolean) => { calls.push(`manager.delete:${id}:${db}`); }),
  };

  const gitWatcher = {
    watch: vi.fn((p: string) => { calls.push(`gitWatcher.watch:${p}`); }),
    unwatch: vi.fn((p: string) => { calls.push(`gitWatcher.unwatch:${p}`); }),
    getStatus: vi.fn(() => ({ hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 })),
  };
  const dockerMonitor = {
    startPolling: vi.fn((project: string, cb: () => void) => { calls.push(`docker.startPolling:${project}`); dockerCallbacks.set(project, cb); }),
    stopPolling: vi.fn((name: string) => { calls.push(`docker.stopPolling:${name}`); }),
    getContainers: vi.fn((): Array<{ name: string; state: string }> => []),
    runCompose: vi.fn((name: string, cwd: string, args: string, env: Record<string, string>) => {
      calls.push(`docker.runCompose:${name}:${cwd}:${args}:${JSON.stringify(env)}`);
      return Promise.resolve();
    }),
  };
  const prMonitor = {
    startPolling: vi.fn((branch: string, id: string, cb: () => void) => { calls.push(`pr.startPolling:${branch}:${id}`); prCallbacks.set(id, cb); }),
    getStatus: vi.fn((): { number: number; state: string; url: string } | undefined => undefined),
  };
  const git = {
    currentBranch: vi.fn((): string => ''),
    diff: vi.fn(async () => o.diffOutput ?? ''),
  };
  const globalState = {
    get: vi.fn(<T,>(k: string): T | undefined => (k === ACTIVE_WORKTREE_KEY ? (o.persistedActiveId as T | undefined) : undefined)),
    update: vi.fn(async (k: string, v: unknown) => { calls.push(`globalState.update:${k}:${v}`); }),
  };
  const ui = {
    pushWebview: vi.fn(() => { calls.push('ui.pushWebview'); }),
    // Kept out of `calls` on purpose so exact call-order assertions stay focused.
    syncDecorations: vi.fn(),
    openDiffPanel: vi.fn((id: string) => { calls.push(`ui.openDiffPanel:${id}`); }),
  };
  const config = { get: vi.fn(() => cfg) };

  const service = new WorktreeApplicationService({
    manager: manager as unknown as WorktreeManager,
    agentManager: claude as unknown as AgentSessionManager,
    tabManager: tabManager as unknown as TabManager,
    breakpointManager: breakpointManager as unknown as import('../../src/worktree/BreakpointManager').BreakpointManager,
    store: store as unknown as IWorktreeRepository,
    config: config as unknown as ConfigManager,
    notify,
    host: host as unknown as IWorkspaceHost,
    git: git as unknown as IGitPort,
    gitWatcher: gitWatcher as unknown as GitWatcher,
    dockerMonitor: dockerMonitor as unknown as DockerMonitor,
    prMonitor: prMonitor as unknown as PrMonitor,
    globalState,
  });
  if (o.withUi !== false) service.setUi(ui);

  return {
    service, calls, worktrees, viewers, makeViewer, claude, tabManager, breakpointManager, host, notify, store,
    manager, gitWatcher, dockerMonitor, prMonitor, git, globalState, ui, cfg,
    dockerCallbacks, prCallbacks, terminalsCreated,
    setActiveTerminal: (t: unknown) => { activeTerminal = t; },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Hexagonal boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('hexagonal boundary', () => {
  it('WorktreeApplicationService has no vscode import', () => {
    const src = nodeFs.readFileSync(
      nodePath.resolve(__dirname, '../../src/application/WorktreeApplicationService.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]vscode['"]/);
    expect(src).not.toMatch(/require\(['"]vscode['"]\)/);
    expect(src).not.toMatch(/import\s+\*\s+as\s+vscode/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleMessage dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe('handleMessage launchAgent', () => {
  it('calls agentManager.launch for known worktree', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    await h.service.handleMessage({ type: 'launchAgent', worktreeId: 'a' });
    expect(h.claude.launch).toHaveBeenCalledWith(a, { provider: undefined });
  });

  it('does nothing for unknown worktreeId (no store fallback)', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    await h.service.handleMessage({ type: 'launchAgent', worktreeId: 'nope' });
    expect(h.claude.launch).not.toHaveBeenCalled();
  });
});

describe('handleMessage pickAgent', () => {
  it('offers every registered provider and launches the chosen one', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    h.host.showQuickPick.mockResolvedValue('opencode');
    await h.service.handleMessage({ type: 'pickAgent', worktreeId: 'a' });
    expect(h.host.showQuickPick).toHaveBeenCalledWith(['claude', 'opencode'], { placeHolder: 'Launch agent' });
    expect(h.claude.launch).toHaveBeenCalledWith(a, { provider: 'opencode' });
  });

  it('launches nothing when the picker is dismissed', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    h.host.showQuickPick.mockResolvedValue(undefined);
    await h.service.handleMessage({ type: 'pickAgent', worktreeId: 'a' });
    expect(h.claude.launch).not.toHaveBeenCalled();
  });

  it('does nothing for unknown worktreeId (no picker shown)', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    await h.service.handleMessage({ type: 'pickAgent', worktreeId: 'nope' });
    expect(h.host.showQuickPick).not.toHaveBeenCalled();
    expect(h.claude.launch).not.toHaveBeenCalled();
  });
});

describe('handleMessage openTerminal', () => {
  it('calls agentManager.openTerminal for known worktree', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    await h.service.handleMessage({ type: 'openTerminal', worktreeId: 'a' });
    expect(h.claude.openTerminal).toHaveBeenCalledWith(a);
  });

  it('does nothing for unknown worktreeId (no store fallback)', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    await h.service.handleMessage({ type: 'openTerminal', worktreeId: 'nope' });
    expect(h.claude.openTerminal).not.toHaveBeenCalled();
  });
});

describe('handleMessage focusTerminal', () => {
  it('runs the full switchToWorktree first, then shows the viewer', async () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', path: '/repo/zer/feat-b', branch: 'feat/b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'a' });
    await h.service.handleMessage({ type: 'focusTerminal', worktreeId: 'b' });
    await flushMicrotasks();
    // switch ran (target has no terminals so the ONLY getOrCreateViewer comes
    // from focusTerminal itself, after the switch's restoreTabs)
    expect(h.calls.indexOf('tab.restoreTabs:b')).toBeGreaterThan(-1);
    expect(h.calls.indexOf('claude.getOrCreateViewer:b')).toBeGreaterThan(h.calls.indexOf('tab.restoreTabs:b'));
    expect(h.viewers.get('b')!.show).toHaveBeenCalled();
  });

  it('swallows viewer creation failure', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], persistedActiveId: 'other' });
    h.claude.getOrCreateViewer.mockRejectedValue(new Error('boom'));
    await expect(h.service.handleMessage({ type: 'focusTerminal', worktreeId: 'a' })).resolves.toBeUndefined();
    await flushMicrotasks();
  });

  it('does not create a viewer for an unknown worktree', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    await h.service.handleMessage({ type: 'focusTerminal', worktreeId: 'nope' });
    expect(h.claude.getOrCreateViewer).not.toHaveBeenCalled();
  });
});

describe('handleMessage focusSession', () => {
  it('runs the full switchToWorktree first, then focuses the tmux window', async () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', path: '/repo/zer/feat-b', branch: 'feat/b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'a' });
    await h.service.handleMessage({ type: 'focusSession', worktreeId: 'b', kind: 'agent', index: 3 });
    await flushMicrotasks();
    expect(h.calls.indexOf('claude.focusWindow:b:3')).toBeGreaterThan(h.calls.indexOf('tab.restoreTabs:b'));
    expect(h.claude.focusWindow).toHaveBeenCalledWith(b, 3);
  });

  it('swallows focusWindow failure', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], persistedActiveId: 'other' });
    h.claude.focusWindow.mockRejectedValue(new Error('boom'));
    await expect(h.service.handleMessage({ type: 'focusSession', worktreeId: 'a', kind: 'agent', index: 0 })).resolves.toBeUndefined();
    await flushMicrotasks();
  });

  it('does nothing for unknown worktree', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    await h.service.handleMessage({ type: 'focusSession', worktreeId: 'nope', kind: 'agent', index: 0 });
    expect(h.claude.focusWindow).not.toHaveBeenCalled();
  });
});

describe('handleMessage killSession', () => {
  const sessions: SessionItem[] = [
    { name: 'claude', kind: 'agent', provider: 'claude', state: 'waiting', index: 1 },
    { name: 'shell', kind: 'shell', state: 'idle', index: 2 },
  ];

  it('asks "Kill claude session?" for agent windows with the exact modal detail and button', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], sessions, confirmResult: 'Kill' });
    await h.service.handleMessage({ type: 'killSession', worktreeId: 'a', index: 1 });
    expect(h.notify.confirm).toHaveBeenCalledWith(
      'Kill claude session?',
      'The running process will be terminated. This cannot be undone.',
      'Kill',
    );
  });

  it('falls back to "Kill agent session?" when the agent window has no provider', async () => {
    const bare: SessionItem[] = [{ name: 'claude', kind: 'agent', state: 'waiting', index: 1 }];
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], sessions: bare, confirmResult: 'Kill' });
    await h.service.handleMessage({ type: 'killSession', worktreeId: 'a', index: 1 });
    expect(h.notify.confirm).toHaveBeenCalledWith(
      'Kill agent session?',
      'The running process will be terminated. This cannot be undone.',
      'Kill',
    );
  });

  it('asks "Kill terminal?" for shell windows', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], sessions, confirmResult: 'Kill' });
    await h.service.handleMessage({ type: 'killSession', worktreeId: 'a', index: 2 });
    expect(h.notify.confirm).toHaveBeenCalledWith(
      'Kill terminal?',
      'The running process will be terminated. This cannot be undone.',
      'Kill',
    );
  });

  it('asks "Kill terminal?" when the session index is unknown', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], sessions, confirmResult: 'Kill' });
    await h.service.handleMessage({ type: 'killSession', worktreeId: 'a', index: 99 });
    expect(h.notify.confirm).toHaveBeenCalledWith(
      'Kill terminal?',
      'The running process will be terminated. This cannot be undone.',
      'Kill',
    );
  });

  it('calls agentManager.killWindow after confirm', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], sessions, confirmResult: 'Kill' });
    await h.service.handleMessage({ type: 'killSession', worktreeId: 'a', index: 1 });
    expect(h.claude.killWindow).toHaveBeenCalledWith('a', 1);
  });

  it('does nothing if confirm cancelled', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], sessions, confirmResult: undefined });
    await h.service.handleMessage({ type: 'killSession', worktreeId: 'a', index: 1 });
    expect(h.claude.killWindow).not.toHaveBeenCalled();
  });

  it('swallows killWindow failure', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], sessions, confirmResult: 'Kill' });
    h.claude.killWindow.mockRejectedValue(new Error('boom'));
    await expect(h.service.handleMessage({ type: 'killSession', worktreeId: 'a', index: 1 })).resolves.toBeUndefined();
    await flushMicrotasks();
  });
});

describe('handleMessage attachScreenshot', () => {
  it('focuses the target window and pastes the single-quoted screenshot path unsent', async () => {
    const h = makeHarness({
      worktrees: [makeWorktree({ id: 'a' })],
      latestScreenshot: '/Users/me/Screenshots/shot.png',
    });
    await h.service.handleMessage({ type: 'attachScreenshot', worktreeId: 'a', index: 1 });
    expect(h.claude.focusWindow).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 1);
    expect(h.claude.pasteToActiveWindow).toHaveBeenCalledWith('a', "'/Users/me/Screenshots/shot.png' ");
  });

  it('warns and pastes nothing when no screenshot is found', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], latestScreenshot: undefined });
    await h.service.handleMessage({ type: 'attachScreenshot', worktreeId: 'a', index: 1 });
    expect(h.notify.showWarning).toHaveBeenCalledWith('Unmess: no screenshot found in your screenshot folder.');
    expect(h.claude.pasteToActiveWindow).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown worktree', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], latestScreenshot: '/x/shot.png' });
    await h.service.handleMessage({ type: 'attachScreenshot', worktreeId: 'nope', index: 1 });
    expect(h.host.findLatestScreenshot).not.toHaveBeenCalled();
    expect(h.claude.pasteToActiveWindow).not.toHaveBeenCalled();
  });

  it('swallows focusWindow failure and still pastes', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], latestScreenshot: '/x/shot.png' });
    h.claude.focusWindow.mockRejectedValue(new Error('boom'));
    await h.service.handleMessage({ type: 'attachScreenshot', worktreeId: 'a', index: 1 });
    expect(h.claude.pasteToActiveWindow).toHaveBeenCalledWith('a', "'/x/shot.png' ");
  });
});

describe('handleMessage dockerUp / dockerDown', () => {
  const dockerCfg = {
    docker: {
      composeFile: 'docker-compose.yml',
      overrideFile: 'docker-compose.worktree.yml',
      ports: ['HTTP_PORT'],
      basePort: 20000,
      portStride: 100,
    },
  };

  it('dockerUp opens a visible terminal and runs compose up with injected ports', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({
      worktrees: [b],
      config: dockerCfg,
      existingPaths: ['/repo/docker-compose.worktree.yml'], // override lives in the MAIN repo
    });
    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'b' });
    expect(h.host.createTerminal).toHaveBeenCalledWith({ name: 'Docker: feat/b', cwd: '/repo/zer/feat-b' });
    expect(h.calls).toContain(
      'terminal.sendText:HTTP_PORT=20000 docker compose -p "feat-b" -f "/repo/docker-compose.yml" -f "/repo/docker-compose.worktree.yml" up -d',
    );
  });

  it('prefers the worktree\'s own compose file when its branch carries .unmess', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({
      worktrees: [b],
      config: {
        docker: { composeFile: '.unmess/docker-compose.worktree.yml', overrideFile: '', ports: ['WORKTREE_PORT'], basePort: 8081, portStride: 1 },
      },
      existingPaths: ['/repo/zer/feat-b/.unmess/docker-compose.worktree.yml'],
    });
    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'b' });
    expect(h.calls).toContain(
      'terminal.sendText:WORKTREE_PORT=8081 docker compose -p "feat-b" -f "/repo/zer/feat-b/.unmess/docker-compose.worktree.yml" up -d',
    );
  });

  it('dockerUp falls back to the plain stack when the override file is absent', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [b], config: dockerCfg }); // no existingPaths -> override missing
    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'b' });
    expect(h.calls).toContain('terminal.sendText:HTTP_PORT=20000 docker compose -p "feat-b" -f "/repo/docker-compose.yml" up -d');
  });

  it('dockerUp on the main repo runs the plain stack with no injected ports', async () => {
    const main = makeWorktree({ id: 'm', branch: 'main', path: '/repo', isMain: true });
    const h = makeHarness({ worktrees: [main], config: dockerCfg });
    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'm' });
    expect(h.host.createTerminal).toHaveBeenCalledWith({ name: 'Docker: main', cwd: '/repo' });
    expect(h.calls).toContain('terminal.sendText:docker compose up -d');
  });

  it('dockerDown runs compose down headless via the monitor with the same ports', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({
      worktrees: [b],
      config: dockerCfg,
      existingPaths: ['/repo/docker-compose.worktree.yml'],
    });
    await h.service.handleMessage({ type: 'dockerDown', worktreeId: 'b' });
    await flushMicrotasks();
    expect(h.calls).toContain(
      'docker.runCompose:feat-b:/repo/zer/feat-b:-p "feat-b" -f "/repo/docker-compose.yml" -f "/repo/docker-compose.worktree.yml" down:{"HTTP_PORT":"20000","PWD":"/repo/zer/feat-b"}',
    );
  });

  it('does nothing for an unknown worktree', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'b' })], config: dockerCfg });
    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'nope' });
    await h.service.handleMessage({ type: 'dockerDown', worktreeId: 'nope' });
    expect(h.host.createTerminal).not.toHaveBeenCalled();
    expect(h.dockerMonitor.runCompose).not.toHaveBeenCalled();
  });
});

describe('handleMessage deleteWorktree / renameWorktree / initWorktree', () => {
  it('deleteWorktree routes to the service delete flow with the resolved worktree', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    const spy = vi.spyOn(h.service, 'deleteWorktree').mockResolvedValue(undefined);
    await h.service.handleMessage({ type: 'deleteWorktree', worktreeId: 'a' });
    expect(spy).toHaveBeenCalledWith(a);
  });

  it('deleteWorktree with unknown id passes undefined (command fallback to first store entry applies)', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    const spy = vi.spyOn(h.service, 'deleteWorktree').mockResolvedValue(undefined);
    await h.service.handleMessage({ type: 'deleteWorktree', worktreeId: 'nope' });
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it('renameWorktree routes to the service rename flow with the resolved worktree', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    const spy = vi.spyOn(h.service, 'renameWorktree').mockResolvedValue(undefined);
    await h.service.handleMessage({ type: 'renameWorktree', worktreeId: 'a' });
    expect(spy).toHaveBeenCalledWith(a);
  });

  it('initWorktree routes to the service init flow with the resolved worktree', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    const spy = vi.spyOn(h.service, 'initWorktree').mockImplementation(() => {});
    await h.service.handleMessage({ type: 'initWorktree', worktreeId: 'a' });
    expect(spy).toHaveBeenCalledWith(a);
  });
});

describe('handleMessage createWorktree', () => {
  it('routes to the service create flow with branch, title and description', async () => {
    const h = makeHarness();
    const spy = vi.spyOn(h.service, 'createWorktree').mockResolvedValue(undefined);
    await h.service.handleMessage({ type: 'createWorktree', branch: 'feat/x', title: 'My task', description: 'do it' });
    expect(spy).toHaveBeenCalledWith({ branch: 'feat/x', title: 'My task', description: 'do it' });
  });
});

describe('handleMessage selectWorktree', () => {
  it('calls switchToWorktree', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    const spy = vi.spyOn(h.service, 'switchToWorktree').mockResolvedValue(undefined);
    await h.service.handleMessage({ type: 'selectWorktree', worktreeId: 'a' });
    expect(spy).toHaveBeenCalledWith('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// switchToWorktree — exact orchestration
// ─────────────────────────────────────────────────────────────────────────────

describe('switchToWorktree', () => {
  function switchHarness(over: HarnessOpts = {}) {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const c = makeWorktree({ id: 'c', branch: 'feat/c', path: '/repo/zer/feat-c' });
    return { a, b, c, h: makeHarness({ worktrees: [a, b, c], persistedActiveId: 'a', ...over }) };
  }

  it('no-ops when target is already the current worktree', async () => {
    const { h } = switchHarness();
    await h.service.switchToWorktree('a');
    expect(h.calls).toEqual([]);
    expect(h.globalState.update).not.toHaveBeenCalled();
  });

  it('scopes the breakpoints panel to the target worktree', async () => {
    const { h } = switchHarness();
    await h.service.switchToWorktree('b');
    expect(h.breakpointManager.activate).toHaveBeenCalledWith('b', h.worktrees);
  });

  it('no-ops when target id does not exist', async () => {
    const { h } = switchHarness();
    await h.service.switchToWorktree('nope');
    expect(h.calls).toEqual([]);
    expect(h.globalState.update).not.toHaveBeenCalled();
  });

  it('persists activeWorktreeId under unmess.activeWorktreeId before any UI work', async () => {
    const { h } = switchHarness();
    await h.service.switchToWorktree('b');
    expect(h.calls[0]).toBe('globalState.update:unmess.activeWorktreeId:b');
  });

  it('snapshots hadViewer for ALL worktrees BEFORE closing viewers', async () => {
    const { h } = switchHarness({ viewerIds: ['a', 'c'] });
    await h.service.switchToWorktree('b');
    const snapshotIdx = h.calls.indexOf('tab.updateViewerState:a,b,c:a,c');
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(snapshotIdx).toBeLessThan(h.calls.indexOf('claude.closeViewer:a'));
    expect(snapshotIdx).toBeLessThan(h.calls.indexOf('claude.closeViewer:c'));
  });

  it('calls saveAll(false) before closing any tab or viewer', async () => {
    const { h } = switchHarness({ viewerIds: ['a'] });
    await h.service.switchToWorktree('b');
    const saveIdx = h.calls.indexOf('host.saveAll:false');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(h.calls.indexOf('claude.closeViewer:a'));
    expect(saveIdx).toBeLessThan(h.calls.indexOf('tab.closeOtherTabs:b'));
  });

  it('closes all other worktrees viewers (and only those)', async () => {
    const { h } = switchHarness({ viewerIds: ['a', 'c'] });
    await h.service.switchToWorktree('b');
    expect(h.claude.closeViewer).toHaveBeenCalledWith('a');
    expect(h.claude.closeViewer).toHaveBeenCalledWith('c');
    expect(h.claude.closeViewer).not.toHaveBeenCalledWith('b');
  });

  it('creates viewer only when target hasTerminals', async () => {
    const { h } = switchHarness({ terminalIds: ['b'] });
    await h.service.switchToWorktree('b');
    expect(h.claude.getOrCreateViewer).toHaveBeenCalledTimes(1);
    expect(h.viewers.get('b')!.show).toHaveBeenCalled();
  });

  it('does not create a viewer when target has no terminals', async () => {
    const { h } = switchHarness();
    await h.service.switchToWorktree('b');
    expect(h.claude.getOrCreateViewer).not.toHaveBeenCalled();
  });

  it('tolerates viewer creation failure and continues the switch', async () => {
    const { h } = switchHarness({ terminalIds: ['b'] });
    h.claude.getOrCreateViewer.mockRejectedValue(new Error('boom'));
    await h.service.switchToWorktree('b');
    expect(h.tabManager.closeOtherTabs).toHaveBeenCalledWith('b', h.worktrees);
    expect(h.tabManager.restoreTabs).toHaveBeenCalledWith('b');
  });

  it('order: persist → pushWebview → updateViewerState → saveAll → closeViewers → viewer → closeOtherTabs → restoreTabs', async () => {
    vi.useFakeTimers();
    const { h } = switchHarness({ viewerIds: ['a'], terminalIds: ['b'] });
    await h.service.switchToWorktree('b');
    expect(h.calls).toEqual([
      'globalState.update:unmess.activeWorktreeId:b',
      'ui.pushWebview',
      'tab.updateViewerState:a,b,c:a',
      'host.saveAll:false',
      'claude.closeViewer:a',
      'claude.closeViewer:c',
      'claude.getOrCreateViewer:b',
      'viewer.show:b',
      'tab.closeOtherTabs:b',
      'tab.restoreTabs:b',
      'host.updateFolderSetting:/repo/zer/feat-a:search.exclude:{"**":true}',
      'host.updateFolderSetting:/repo/zer/feat-b:search.exclude:clear',
      'host.updateFolderSetting:/repo/zer/feat-c:search.exclude:{"**":true}',
    ]);
  });

  it('after restore: shows viewer again, waits 50ms, and runs moveEditorToFirstInGroup', async () => {
    vi.useFakeTimers();
    const { h } = switchHarness({ terminalIds: ['b'] });
    await h.service.switchToWorktree('b');
    const showCount = h.viewers.get('b')!.show.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.viewers.get('b')!.show.mock.calls.length).toBe(showCount + 1);
    expect(h.host.moveEditorToFirstInGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.host.moveEditorToFirstInGroup).toHaveBeenCalledTimes(1);
  });

  it('skips moveEditorToFirstInGroup when there is no viewer', async () => {
    const { h } = switchHarness();
    await h.service.switchToWorktree('b');
    await flushMicrotasks();
    expect(h.host.moveEditorToFirstInGroup).not.toHaveBeenCalled();
  });

  it('swallows restoreTabs failure without breaking the switch', async () => {
    const { h } = switchHarness();
    h.tabManager.restoreTabs.mockRejectedValue(new Error('restore boom'));
    await expect(h.service.switchToWorktree('b')).resolves.toBeUndefined();
    await flushMicrotasks();
    expect(h.host.moveEditorToFirstInGroup).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// activeTerminal sync
// ─────────────────────────────────────────────────────────────────────────────

describe('activeTerminal sync', () => {
  it('selects the owning worktree when its viewer terminal gains focus', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'a', viewerIds: ['a', 'b'] });
    h.service.handleActiveTerminalChange(h.viewers.get('b'));
    expect(h.globalState.update).toHaveBeenCalledWith(ACTIVE_WORKTREE_KEY, 'b');
    expect(h.service.buildState().activeWorktreeId).toBe('b');
  });

  it('does NOT trigger switchToWorktree (selection only — no tab churn)', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'a', viewerIds: ['a', 'b'] });
    const spy = vi.spyOn(h.service, 'switchToWorktree');
    h.service.handleActiveTerminalChange(h.viewers.get('b'));
    expect(spy).not.toHaveBeenCalled();
    expect(h.tabManager.updateViewerState).not.toHaveBeenCalled();
    expect(h.tabManager.closeOtherTabs).not.toHaveBeenCalled();
    expect(h.host.saveAll).not.toHaveBeenCalled();
  });

  it('persists the new activeWorktreeId and pushes state', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'a', viewerIds: ['b'] });
    h.service.handleActiveTerminalChange(h.viewers.get('b'));
    expect(h.calls).toEqual([
      `globalState.update:${ACTIVE_WORKTREE_KEY}:b`,
      'ui.pushWebview',
      'host.updateFolderSetting:/repo/zer/feat-a:search.exclude:{"**":true}',
      'host.updateFolderSetting:/repo/zer/feat-b:search.exclude:clear',
    ]);
  });

  it('does not re-persist when the terminal owner is already selected', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], persistedActiveId: 'a', viewerIds: ['a'] });
    h.service.handleActiveTerminalChange(h.viewers.get('a'));
    expect(h.globalState.update).not.toHaveBeenCalled();
    expect(h.ui.pushWebview).not.toHaveBeenCalled();
  });

  it('ignores terminals that are not unmess viewers', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], persistedActiveId: undefined, viewerIds: ['a'] });
    h.service.handleActiveTerminalChange({ name: 'random terminal' });
    expect(h.globalState.update).not.toHaveBeenCalled();
    expect(h.ui.pushWebview).not.toHaveBeenCalled();
  });

  it('ignores undefined terminals', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    h.service.handleActiveTerminalChange(undefined);
    expect(h.globalState.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// explorer dimming sync
// ─────────────────────────────────────────────────────────────────────────────

describe('explorer dimming (syncDecorations)', () => {
  it('syncs decorations with the worktree list and new active worktree on switch', async () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'a' });
    await h.service.switchToWorktree('b');
    expect(h.ui.syncDecorations).toHaveBeenLastCalledWith([a, b], 'b');
  });

  it('syncs decorations when the active terminal selects another worktree', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'a', viewerIds: ['b'] });
    h.service.handleActiveTerminalChange(h.viewers.get('b'));
    expect(h.ui.syncDecorations).toHaveBeenCalledWith([a, b], 'b');
  });

  it('syncs decorations after loading a repo', async () => {
    const a = makeWorktree({ id: 'a', path: '/repo', branch: 'main', isMain: true });
    const h = makeHarness({ worktrees: [a], workspaceFolders: ['/repo'] });
    await h.service.loadWorktreesForRepo('/repo');
    expect(h.ui.syncDecorations).toHaveBeenCalledWith([a], undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildState
// ─────────────────────────────────────────────────────────────────────────────

describe('buildState', () => {
  it('maps worktrees to WorktreeItems with claude/git/docker/pr data', () => {
    const a = makeWorktree({ id: 'a', alias: 'My task', isMain: true });
    const h = makeHarness({ worktrees: [a], persistedActiveId: 'a' });
    h.dockerMonitor.getContainers.mockReturnValue([{ name: 'db', state: 'running', extra: 'stripped' } as never]);
    h.prMonitor.getStatus.mockReturnValue({ number: 7, state: 'OPEN', url: 'u' });
    const state = h.service.buildState();
    expect(state).toEqual({
      worktrees: [{
        id: 'a',
        branch: 'feat/a',
        alias: 'My task',
        path: '/repo/zer/feat-a',
        isMain: true,
        deleting: false,
        agent: 'idle',
        agentCount: 2,
        terminalCount: 1,
        sessions: [],
        git: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 },
        docker: [{ name: 'db', state: 'running' }],
        pr: { number: 7, state: 'OPEN', url: 'u' },
      }],
      activeWorktreeId: 'a',
      defaultProvider: 'claude',
      dockerEnabled: false,
    });
    expect(h.dockerMonitor.getContainers).toHaveBeenCalledWith(a.dockerProjectName);
    expect(h.gitWatcher.getStatus).toHaveBeenCalledWith(a.path);
  });

  it('maps missing PR status to null', () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    expect(h.service.buildState().worktrees[0].pr).toBeNull();
  });

  it('returns undefined activeWorktreeId when persisted id no longer exists', () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], persistedActiveId: 'zombie' });
    expect(h.service.buildState().activeWorktreeId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selection restore after reload
// ─────────────────────────────────────────────────────────────────────────────

describe('selection restore after reload', () => {
  it('constructor hydrates currentWorktreeId from unmess.activeWorktreeId', () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], persistedActiveId: 'a' });
    expect(h.globalState.get).toHaveBeenCalledWith(ACTIVE_WORKTREE_KEY);
    expect(h.service.buildState().activeWorktreeId).toBe('a');
  });

  it('buildState sends the persisted selection to the webview', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'b' });
    expect(h.service.buildState().activeWorktreeId).toBe('b');
  });

  it('activeTerminal claim during reload re-syncs selection to the terminal owner', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], persistedActiveId: 'a', viewerIds: ['b'] });
    h.service.handleActiveTerminalChange(h.viewers.get('b'));
    expect(h.service.buildState().activeWorktreeId).toBe('b');
    expect(h.globalState.update).toHaveBeenCalledWith(ACTIVE_WORKTREE_KEY, 'b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findRepoRoot / start / one-repo-at-a-time
// ─────────────────────────────────────────────────────────────────────────────

describe('findRepoRoot', () => {
  it('returns the first workspace folder whose .git is a directory', () => {
    const h = makeHarness({
      workspaceFolders: ['/linked-wt', '/main-repo'],
      gitDirs: ['/main-repo/.git'],
    });
    expect(h.service.findRepoRoot()).toBe('/main-repo');
  });

  it('skips folders whose .git is a file (linked worktrees)', () => {
    const h = makeHarness({ workspaceFolders: ['/linked-wt'], gitDirs: [] });
    expect(h.service.findRepoRoot()).toBeUndefined();
  });

  it('accepts explicit folder paths', () => {
    const h = makeHarness({ gitDirs: ['/x/.git'] });
    expect(h.service.findRepoRoot(['/x'])).toBe('/x');
    expect(h.service.findRepoRoot([])).toBeUndefined();
  });
});

describe('start', () => {
  it('loads worktrees when a repo is already open', async () => {
    const h = makeHarness({ workspaceFolders: ['/repo'], gitDirs: ['/repo/.git'] });
    const spy = vi.spyOn(h.service, 'loadWorktreesForRepo').mockResolvedValue(undefined);
    await h.service.start();
    expect(spy).toHaveBeenCalledWith('/repo');
  });

  it('does nothing when no repo is open', async () => {
    const h = makeHarness({ workspaceFolders: ['/not-a-repo'] });
    const spy = vi.spyOn(h.service, 'loadWorktreesForRepo').mockResolvedValue(undefined);
    await h.service.start();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('handleAddedWorkspaceFolders (one repo at a time)', () => {
  it('loads the first added git repo only', async () => {
    const h = makeHarness({
      existingPaths: ['/repo1/.git', '/repo2/.git'],
      gitDirs: ['/repo1/.git', '/repo2/.git'],
    });
    const spy = vi.spyOn(h.service, 'loadWorktreesForRepo').mockResolvedValue(undefined);
    await h.service.handleAddedWorkspaceFolders(['/repo1', '/repo2']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('/repo1');
  });

  it('skips non-git folders and .git files', async () => {
    const h = makeHarness({
      existingPaths: ['/linked/.git'], // exists but is a FILE
      gitDirs: [],
    });
    const spy = vi.spyOn(h.service, 'loadWorktreesForRepo').mockResolvedValue(undefined);
    await h.service.handleAddedWorkspaceFolders(['/plain', '/linked']);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadWorktreesForRepo
// ─────────────────────────────────────────────────────────────────────────────

describe('loadWorktreesForRepo', () => {
  it('runs reconcile → clean stale folders (descending) → batch-add → watchers → reconnect → tree ready/refresh → push', async () => {
    const a = makeWorktree({ id: 'a', path: '/repo', branch: 'main', isMain: true });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    // '/stale-1' (idx 1) and '/stale-2' (idx 3) must be removed in DESCENDING order;
    // b's folder is missing and must be batch-added.
    const h = makeHarness({
      worktrees: [a, b],
      workspaceFolders: ['/repo', '/stale-1', '/other-keep', '/stale-2'],
    });
    // '/other-keep' is stale too — everything not repoRoot or a worktree path goes
    h.service.setUi(h.ui);
    await h.service.loadWorktreesForRepo('/repo');
    expect(h.calls).toEqual([
      'manager.reconcile:/repo',
      'host.removeWorkspaceFolder:3',
      'host.removeWorkspaceFolder:2',
      'host.removeWorkspaceFolder:1',
      'host.addWorkspaceFolders:/repo/zer/feat-b=feat/b',
      'gitWatcher.watch:/repo',
      'docker.startPolling:repo',
      'pr.startPolling:main:a',
      'gitWatcher.watch:/repo/zer/feat-b',
      'docker.startPolling:feat-b',
      'pr.startPolling:feat/b:b',
      'claude.reconnect',
      'ui.pushWebview',
      'host.updateFolderSetting:/repo:search.exclude:clear',
      'host.updateFolderSetting:/repo/zer/feat-b:search.exclude:{"**":true}',
    ]);
    expect(h.claude.reconnect).toHaveBeenCalledWith(h.worktrees);
  });

  it('uses alias as workspace folder display name when present', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b', alias: 'Nice name' });
    const h = makeHarness({ worktrees: [b], workspaceFolders: ['/repo'] });
    await h.service.loadWorktreesForRepo('/repo');
    expect(h.calls).toContain('host.addWorkspaceFolders:/repo/zer/feat-b=Nice name');
  });

  it('does not call addWorkspaceFolders when nothing is missing', async () => {
    const a = makeWorktree({ id: 'a', path: '/repo', branch: 'main', isMain: true });
    const h = makeHarness({ worktrees: [a], workspaceFolders: ['/repo'] });
    await h.service.loadWorktreesForRepo('/repo');
    expect(h.host.addWorkspaceFolders).not.toHaveBeenCalled();
    expect(h.host.removeWorkspaceFolder).not.toHaveBeenCalled();
  });

  it('docker poll callback pushes webview state; pr poll callback pushes too', async () => {
    const a = makeWorktree({ id: 'a', path: '/repo', branch: 'main', isMain: true });
    const h = makeHarness({ worktrees: [a], workspaceFolders: ['/repo'] });
    await h.service.loadWorktreesForRepo('/repo');
    h.calls.length = 0;
    h.dockerCallbacks.get('repo')!(); // composeProject = basename('/repo')
    expect(h.calls).toEqual(['ui.pushWebview']);
    h.calls.length = 0;
    h.prCallbacks.get('a')!();
    expect(h.calls).toEqual(['ui.pushWebview']);
  });

  it('works before setUi is wired (default no-op UI)', async () => {
    const a = makeWorktree({ id: 'a', path: '/repo', branch: 'main', isMain: true });
    const h = makeHarness({ worktrees: [a], workspaceFolders: ['/repo'], withUi: false });
    await expect(h.service.loadWorktreesForRepo('/repo')).resolves.toBeUndefined();
    expect(h.calls).not.toContain('ui.pushWebview');
    // The default no-op UI also absorbs openDiff without a wired panel.
    await expect(h.service.handleMessage({ type: 'openDiff', worktreeId: 'a' })).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// search scoping (search.exclude per worktree folder)
// ─────────────────────────────────────────────────────────────────────────────

describe('search scoping', () => {
  const main = () => makeWorktree({ id: 'm', path: '/repo', branch: 'main', isMain: true });
  const wtB = () => makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
  const wtC = () => makeWorktree({ id: 'c', branch: 'feat/c', path: '/repo/zer/feat-c' });

  const excludeCalls = (h: ReturnType<typeof makeHarness>) =>
    h.host.updateFolderSetting.mock.calls.map(([p, , v]) => `${p}:${v === undefined ? 'clear' : JSON.stringify(v)}`);

  it('on load with no selection, keeps the main repo searchable and hides every worktree', async () => {
    const h = makeHarness({ worktrees: [main(), wtB(), wtC()], workspaceFolders: ['/repo'] });
    await h.service.loadWorktreesForRepo('/repo');
    expect(excludeCalls(h)).toEqual([
      '/repo:clear',
      '/repo/zer/feat-b:{"**":true}',
      '/repo/zer/feat-c:{"**":true}',
    ]);
  });

  it('scopes to the active worktree, hiding the main repo and the other worktrees', async () => {
    const h = makeHarness({ worktrees: [main(), wtB(), wtC()], persistedActiveId: 'm', viewerIds: ['b'] });
    await h.service.switchToWorktree('b');
    expect(excludeCalls(h)).toEqual([
      '/repo:{"**":true}',
      '/repo/zer/feat-b:clear',
      '/repo/zer/feat-c:{"**":true}',
    ]);
  });

  it('clears all excludes when the feature is disabled', async () => {
    const h = makeHarness({
      worktrees: [main(), wtB(), wtC()],
      workspaceFolders: ['/repo'],
      config: { scopeSearchToActiveWorktree: false },
    });
    await h.service.loadWorktreesForRepo('/repo');
    expect(excludeCalls(h)).toEqual(['/repo:clear', '/repo/zer/feat-b:clear', '/repo/zer/feat-c:clear']);
  });

  it('re-applies scoping after workspace folders change (worktree folders register async)', async () => {
    const h = makeHarness({ worktrees: [main(), wtB()], persistedActiveId: 'b' });
    await h.service.handleAddedWorkspaceFolders([]);
    expect(excludeCalls(h)).toEqual(['/repo:{"**":true}', '/repo/zer/feat-b:clear']);
  });

  it('swallows a folder-setting write failure', async () => {
    const h = makeHarness({ worktrees: [main(), wtB()], workspaceFolders: ['/repo'] });
    h.host.updateFolderSetting.mockRejectedValue(new Error('no such folder'));
    await expect(h.service.loadWorktreesForRepo('/repo')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createWorktree flow
// ─────────────────────────────────────────────────────────────────────────────

describe('createWorktree', () => {
  const root = '/repo';
  function createHarness(o: HarnessOpts = {}) {
    const created = makeWorktree({ id: 'new', branch: 'feat/x', path: '/repo/zer/feat-x' });
    const h = makeHarness({ workspaceFolders: [root], gitDirs: ['/repo/.git'], ...o });
    h.manager.create.mockImplementation(async (branch: string, r: string) => {
      h.calls.push(`manager.create:${branch}:${r}`);
      return created;
    });
    return { h, created };
  }

  it('shows an error when no git repository is found', async () => {
    const { h } = createHarness({ workspaceFolders: ['/nope'], gitDirs: [] });
    await h.service.createWorktree({ branch: 'feat/x' });
    expect(h.notify.showError).toHaveBeenCalledWith('No git repository found in workspace.');
    expect(h.manager.create).not.toHaveBeenCalled();
  });

  it('falls back to an input box when no branch is given', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    h.host.showInputBox.mockResolvedValue('feat/x');
    await h.service.createWorktree();
    expect(h.host.showInputBox).toHaveBeenCalledWith({
      prompt: 'Branch name',
      placeHolder: 'e.g. AS-7090-fix-payments',
    });
    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined);
  });

  it('passes the title as the worktree alias (trimmed), keeping the description as the prompt', async () => {
    vi.useFakeTimers();
    const { h, created } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x', title: '  My task  ', description: 'do the thing' });
    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, 'My task');
    await vi.advanceTimersByTimeAsync(300);
    expect(h.claude.launchWithPrompt).toHaveBeenCalledWith(created, 'do the thing');
  });

  it('passes undefined alias when no title is given', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x', description: 'only a prompt' });
    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined);
  });

  it('aborts silently when the input box is cancelled', async () => {
    const { h } = createHarness();
    h.host.showInputBox.mockResolvedValue(undefined);
    await h.service.createWorktree();
    expect(h.manager.create).not.toHaveBeenCalled();
    expect(h.notify.withProgress).not.toHaveBeenCalled();
  });

  it('runs the create inside withProgress with exact title and progress messages', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x' });
    expect(h.calls).toEqual([
      'withProgress:Creating worktree "feat/x"',
      'report:Running git worktree add...',
      'manager.create:feat/x:/repo',
      'report:Adding to workspace...',
      'host.addWorkspaceFolders:/repo/zer/feat-x=feat/x',
      'gitWatcher.watch:/repo/zer/feat-x',
      'docker.startPolling:feat-x',
      'pr.startPolling:feat/x:new',
      'ui.pushWebview',
      'ui.pushWebview',
    ]);
  });

  it('uses the created alias as folder display name when present', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    h.manager.create.mockResolvedValue(makeWorktree({ id: 'new', branch: 'feat/x', path: '/repo/zer/feat-x', alias: 'Aliased' }));
    await h.service.createWorktree({ branch: 'feat/x' });
    expect(h.calls).toContain('host.addWorkspaceFolders:/repo/zer/feat-x=Aliased');
  });

  it('the docker polling callback registered on create is a no-op (no auto-refresh)', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x' });
    h.calls.length = 0;
    h.dockerCallbacks.get('feat-x')!();
    expect(h.calls).toEqual([]);
  });

  it('the pr polling callback registered on create pushes webview state', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x' });
    h.calls.length = 0;
    h.prCallbacks.get('new')!();
    expect(h.calls).toEqual(['ui.pushWebview']);
  });

  it('runs the setup script in a visible terminal when configured', async () => {
    vi.useFakeTimers();
    const { h } = createHarness({ config: { setupScript: '/scripts/setup.sh' } });
    await h.service.createWorktree({ branch: 'feat/x' });
    expect(h.calls).toContain('report:Running setup script...');
    expect(h.calls).toContain('host.createTerminal:Init: feat/x:/repo/zer/feat-x');
    expect(h.calls).toContain('claude.register:new');
    expect(h.calls).toContain('terminal.show:Init: feat/x');
    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-x" UNMESS_BRANCH="feat/x" UNMESS_COMPOSE_PROJECT="feat-x" bash "/scripts/setup.sh" && echo "✓ Setup complete"',
    );
  });

  it('skips the setup script when not configured', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x' });
    expect(h.host.createTerminal).not.toHaveBeenCalled();
  });

  it('shows an error and aborts when creation fails (no deferred launch)', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    h.manager.create.mockRejectedValue(new Error('git failed'));
    await h.service.createWorktree({ branch: 'feat/x' });
    expect(h.notify.showError).toHaveBeenCalledWith('Failed to create worktree: Error: git failed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.claude.launch).not.toHaveBeenCalled();
    expect(h.claude.launchWithPrompt).not.toHaveBeenCalled();
  });

  it('defers the Claude launch by exactly 300ms after progress closes', async () => {
    vi.useFakeTimers();
    const { h, created } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x' });
    expect(h.claude.launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(h.claude.launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.claude.launch).toHaveBeenCalledWith(created);
  });

  it('launches Claude with the description as initial prompt when given', async () => {
    vi.useFakeTimers();
    const { h, created } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x', description: 'Fix the bug' });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.claude.launchWithPrompt).toHaveBeenCalledWith(created, 'Fix the bug');
    expect(h.claude.launch).not.toHaveBeenCalled();
  });

  it('schedules no launch when withProgress resolves without a worktree', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    h.notify.withProgress.mockResolvedValue(undefined);
    await h.service.createWorktree({ branch: 'feat/x' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.claude.launch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteWorktree flow
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteWorktree', () => {
  it('does nothing when no worktree given and store is empty', async () => {
    const h = makeHarness();
    await h.service.deleteWorktree(undefined);
    expect(h.calls).toEqual([]);
  });

  it('falls back to the first store entry when called without a worktree', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], confirmResult: undefined });
    await h.service.deleteWorktree(undefined);
    expect(h.notify.confirm).toHaveBeenCalledWith('Delete worktree "feat/a"?', undefined, 'Delete', 'Delete + branch');
  });

  it('refuses to delete a truly-main worktree', async () => {
    const main = makeWorktree({ id: 'm', path: '/repo', branch: 'main', isMain: true });
    const h = makeHarness({
      worktrees: [main],
      workspaceFolders: ['/repo'],
      gitDirs: ['/repo/.git'],
      existingPaths: ['/repo'],
    });
    h.git.currentBranch.mockReturnValue('main');
    await h.service.deleteWorktree(main);
    expect(h.notify.showWarning).toHaveBeenCalledWith('Cannot delete the main worktree.');
    expect(h.manager.delete).not.toHaveBeenCalled();
  });

  it('treats a detached HEAD (empty currentBranch) as truly main', async () => {
    const main = makeWorktree({ id: 'm', path: '/repo', branch: 'main' });
    const h = makeHarness({
      worktrees: [main], workspaceFolders: ['/repo'], gitDirs: ['/repo/.git'], existingPaths: ['/repo'],
    });
    h.git.currentBranch.mockReturnValue('');
    await h.service.deleteWorktree(main);
    expect(h.notify.showWarning).toHaveBeenCalledWith('Cannot delete the main worktree.');
  });

  it('assumes main when git currentBranch fails', async () => {
    const main = makeWorktree({ id: 'm', path: '/repo', branch: 'main' });
    const h = makeHarness({
      worktrees: [main], workspaceFolders: ['/repo'], gitDirs: ['/repo/.git'], existingPaths: ['/repo'],
    });
    h.git.currentBranch.mockImplementation(() => { throw new Error('not a repo'); });
    await h.service.deleteWorktree(main);
    expect(h.notify.showWarning).toHaveBeenCalledWith('Cannot delete the main worktree.');
  });

  it('removes a stale store entry (path === repoRoot, branch mismatch) from the store only, without confirm', async () => {
    const stale = makeWorktree({ id: 's', path: '/repo', branch: 'old-branch' });
    const h = makeHarness({
      worktrees: [stale], workspaceFolders: ['/repo'], gitDirs: ['/repo/.git'], existingPaths: ['/repo'],
    });
    h.git.currentBranch.mockReturnValue('main');
    await h.service.deleteWorktree(stale);
    expect(h.git.currentBranch).toHaveBeenCalledWith('/repo');
    expect(h.notify.confirm).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['manager.delete:s:false', 'ui.pushWebview']);
  });

  it('a worktree whose path no longer exists skips the main check and goes to the confirm flow', async () => {
    const gone = makeWorktree({ id: 'g', path: '/repo', branch: 'main' });
    const h = makeHarness({
      worktrees: [gone], workspaceFolders: ['/repo'], gitDirs: ['/repo/.git'],
      existingPaths: [], confirmResult: undefined,
    });
    await h.service.deleteWorktree(gone);
    expect(h.git.currentBranch).not.toHaveBeenCalled();
    expect(h.notify.confirm).toHaveBeenCalled();
  });

  it('does nothing when the confirm dialog is cancelled', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], confirmResult: undefined });
    await h.service.deleteWorktree(a);
    expect(h.manager.delete).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['notify.confirm:Delete worktree "feat/a"?']);
    expect(h.service.buildState().worktrees[0].deleting).toBe(false);
  });

  it('"Delete" keeps the branch; "Delete + branch" deletes it', async () => {
    const a = makeWorktree({ id: 'a' });
    let h = makeHarness({ worktrees: [a], confirmResult: 'Delete' });
    await h.service.deleteWorktree(a);
    expect(h.manager.delete).toHaveBeenCalledWith('a', false);

    h = makeHarness({ worktrees: [a], confirmResult: 'Delete + branch' });
    await h.service.deleteWorktree(a);
    expect(h.manager.delete).toHaveBeenCalledWith('a', true);
  });

  it('marks deleting + pushes immediately, then runs the teardown cascade in the background', async () => {
    const a = makeWorktree({ id: 'a', alias: 'My task' });
    const h = makeHarness({ worktrees: [a], confirmResult: 'Delete' });
    await h.service.deleteWorktree(a);
    expect(h.calls).toEqual([
      'notify.confirm:Delete worktree "feat/a"?',
      // control handed back immediately — card flips to "deleting"
      'ui.pushWebview',
      // then the cascade
      'gitWatcher.unwatch:/repo/zer/feat-a',
      'docker.stopPolling:feat-a',
      'claude.killWorktreeSession:a',
      'manager.delete:a:false',
      // finally: cleared + refreshed
      'ui.pushWebview',
    ]);
  });

  it('runs the teardown script and waits a fixed 2s before killing the session', async () => {
    vi.useFakeTimers();
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      config: { teardownScript: '/scripts/teardown.sh' },
      existingPaths: [a.path],
    });
    const done = h.service.deleteWorktree(a);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toContain(`host.createTerminal:Teardown: feat/a:${a.path}`);
    expect(h.calls).toContain('claude.register:a');
    expect(h.calls).toContain('terminal.show:Teardown: feat/a');
    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-a" UNMESS_BRANCH="feat/a" UNMESS_COMPOSE_PROJECT="feat-a" bash "/scripts/teardown.sh" && echo "✓ Teardown complete"',
    );
    expect(h.claude.killWorktreeSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.claude.killWorktreeSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.claude.killWorktreeSession).toHaveBeenCalledWith('a');
  });

  it('skips the teardown script when the worktree path is gone', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      config: { teardownScript: '/scripts/teardown.sh' },
      existingPaths: [],
    });
    await h.service.deleteWorktree(a);
    expect(h.host.createTerminal).not.toHaveBeenCalled();
  });

  it('removes the workspace folder when present', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      workspaceFolders: ['/repo', a.path],
    });
    await h.service.deleteWorktree(a);
    expect(h.host.removeWorkspaceFolder).toHaveBeenCalledWith(1);
    // order: kill session → remove folder → manager.delete
    expect(h.calls.indexOf('claude.killWorktreeSession:a')).toBeLessThan(h.calls.indexOf('host.removeWorkspaceFolder:1'));
    expect(h.calls.indexOf('host.removeWorkspaceFolder:1')).toBeLessThan(h.calls.indexOf('manager.delete:a:false'));
  });

  it('flags the worktree as deleting during teardown and clears it when done', async () => {
    vi.useFakeTimers();
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      config: { teardownScript: '/scripts/teardown.sh' },
      existingPaths: [a.path],
    });
    const done = h.service.deleteWorktree(a);
    await vi.advanceTimersByTimeAsync(0);
    // mid-teardown (paused on the 2s wait): locked
    expect(h.service.buildState().worktrees[0].deleting).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(h.service.buildState().worktrees[0].deleting).toBe(false);
  });

  it('ignores actions targeting a worktree that is tearing down', async () => {
    vi.useFakeTimers();
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      config: { teardownScript: '/scripts/teardown.sh' },
      existingPaths: [a.path],
    });
    const done = h.service.deleteWorktree(a);
    await vi.advanceTimersByTimeAsync(0); // now mid-teardown
    await h.service.handleMessage({ type: 'launchAgent', worktreeId: 'a' });
    await h.service.handleMessage({ type: 'openTerminal', worktreeId: 'a' });
    expect(h.claude.launch).not.toHaveBeenCalled();
    expect(h.claude.openTerminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await done;
  });

  it('does not start a second teardown if delete is triggered again while tearing down', async () => {
    vi.useFakeTimers();
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      config: { teardownScript: '/scripts/teardown.sh' },
      existingPaths: [a.path],
    });
    const done = h.service.deleteWorktree(a);
    await vi.advanceTimersByTimeAsync(0);
    await h.service.deleteWorktree(a); // ignored — already deleting
    expect(h.notify.confirm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renameWorktree flow
// ─────────────────────────────────────────────────────────────────────────────

describe('renameWorktree', () => {
  it('does nothing when no worktree given and store is empty', async () => {
    const h = makeHarness();
    await h.service.renameWorktree(undefined);
    expect(h.host.showInputBox).not.toHaveBeenCalled();
  });

  it('falls back to the first store entry when called without a worktree', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    await h.service.renameWorktree(undefined);
    expect(h.host.showInputBox).toHaveBeenCalled();
  });

  it('prompts with the current alias (or branch) pre-filled', async () => {
    const a = makeWorktree({ id: 'a', alias: 'Old alias' });
    const h = makeHarness({ worktrees: [a] });
    await h.service.renameWorktree(a);
    expect(h.host.showInputBox).toHaveBeenCalledWith({
      prompt: 'Description / alias for this worktree',
      value: 'Old alias',
      placeHolder: 'e.g. Fix rate-limit bug on Shopify',
    });
  });

  it('aborts when the input box is cancelled', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    h.host.showInputBox.mockResolvedValue(undefined);
    await h.service.renameWorktree(a);
    expect(h.store.setAlias).not.toHaveBeenCalled();
  });

  it('persists the alias and syncs the workspace folder display name', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], workspaceFolders: ['/repo', a.path] });
    h.host.showInputBox.mockResolvedValue('New alias');
    await h.service.renameWorktree(a);
    expect(h.calls).toEqual([
      'store.setAlias:a:New alias',
      `host.renameWorkspaceFolder:1:${a.path}=New alias`,
      'ui.pushWebview',
    ]);
  });

  it('empty alias falls back to the branch name', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], workspaceFolders: [a.path] });
    h.host.showInputBox.mockResolvedValue('');
    await h.service.renameWorktree(a);
    expect(h.store.setAlias).toHaveBeenCalledWith('a', 'feat/a');
    expect(h.host.renameWorkspaceFolder).toHaveBeenCalledWith(0, { path: a.path, name: 'feat/a' });
  });

  it('skips the folder rename when the worktree has no workspace folder', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], workspaceFolders: ['/repo'] });
    h.host.showInputBox.mockResolvedValue('x');
    await h.service.renameWorktree(a);
    expect(h.host.renameWorkspaceFolder).not.toHaveBeenCalled();
    expect(h.ui.pushWebview).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// initWorktree / openTerminal / launchClaude commands
// ─────────────────────────────────────────────────────────────────────────────

describe('initWorktree', () => {
  it('does nothing when no worktree given and store is empty', () => {
    const h = makeHarness();
    h.service.initWorktree(undefined);
    expect(h.notify.showError).not.toHaveBeenCalled();
  });

  it('shows an error when no setup script is configured', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    h.service.initWorktree(a);
    expect(h.notify.showError).toHaveBeenCalledWith('No setup script configured. Set "unmess.setupScript" in settings.');
    expect(h.host.createTerminal).not.toHaveBeenCalled();
  });

  it('re-runs the setup script in a visible terminal (no completion echo)', () => {
    const a = makeWorktree({ id: 'a', alias: 'My task' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: '/scripts/setup.sh' } });
    h.service.initWorktree(a);
    expect(h.calls).toEqual([
      'host.createTerminal:Init: My task:/repo/zer/feat-a',
      'claude.register:a',
      'terminal.show:Init: My task',
      'terminal.sendText:UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-a" UNMESS_BRANCH="feat/a" UNMESS_COMPOSE_PROJECT="feat-a" bash "/scripts/setup.sh"',
    ]);
  });

  it('resolves a relative setup script in the worktree and injects the docker ports', () => {
    const a = makeWorktree({ id: 'a', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({
      worktrees: [a],
      config: {
        setupScript: '.unmess/setup.sh',
        docker: { composeFile: '.unmess/docker-compose.worktree.yml', overrideFile: '', ports: ['WORKTREE_PORT'], basePort: 8081, portStride: 1 },
      },
      existingPaths: ['/repo/zer/feat-b/.unmess/setup.sh'],
    });
    h.service.initWorktree(a);
    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-b" UNMESS_BRANCH="feat/b" UNMESS_COMPOSE_PROJECT="feat-b" WORKTREE_PORT="8081" bash "/repo/zer/feat-b/.unmess/setup.sh"',
    );
  });

  it('uses an absolute setup script path as-is when it exists', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: '/abs/setup.sh' }, existingPaths: ['/abs/setup.sh'] });
    h.service.initWorktree(a);
    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-a" UNMESS_BRANCH="feat/a" UNMESS_COMPOSE_PROJECT="feat-a" bash "/abs/setup.sh"',
    );
  });

  it('falls back to the repo root for a relative setup script the branch does not carry', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: 'scripts/setup.sh' } }); // present in neither
    h.service.initWorktree(a);
    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-a" UNMESS_BRANCH="feat/a" UNMESS_COMPOSE_PROJECT="feat-a" bash "/repo/scripts/setup.sh"',
    );
  });

  it('falls back to the first store entry', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: '/s.sh' } });
    h.service.initWorktree(undefined);
    expect(h.host.createTerminal).toHaveBeenCalledWith({ name: 'Init: feat/a', cwd: a.path });
  });
});

describe('openTerminal command', () => {
  it('opens a terminal for the given worktree', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    h.service.openTerminal(a);
    expect(h.claude.openTerminal).toHaveBeenCalledWith(a);
  });

  it('falls back to the first store entry; no-ops when store empty', () => {
    const a = makeWorktree({ id: 'a' });
    let h = makeHarness({ worktrees: [a] });
    h.service.openTerminal(undefined);
    expect(h.claude.openTerminal).toHaveBeenCalledWith(a);

    h = makeHarness();
    h.service.openTerminal(undefined);
    expect(h.claude.openTerminal).not.toHaveBeenCalled();
  });
});

describe('launchAgent command', () => {
  it('launches Claude for the given worktree', () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    h.service.launchAgent(a);
    expect(h.claude.launch).toHaveBeenCalledWith(a, { provider: undefined });
  });

  it('falls back to the first store entry; no-ops when store empty', () => {
    const a = makeWorktree({ id: 'a' });
    let h = makeHarness({ worktrees: [a] });
    h.service.launchAgent(undefined);
    expect(h.claude.launch).toHaveBeenCalledWith(a, { provider: undefined });

    h = makeHarness();
    h.service.launchAgent(undefined);
    expect(h.claude.launch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// focusNext / focusPrev cyclic navigation
// ─────────────────────────────────────────────────────────────────────────────

describe('focusNextWorktree / focusPrevWorktree', () => {
  function navHarness() {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const c = makeWorktree({ id: 'c', branch: 'feat/c', path: '/repo/zer/feat-c' });
    const h = makeHarness({ worktrees: [a, b, c], viewerIds: ['a', 'b', 'c'] });
    return { a, b, c, h };
  }

  it('does nothing with an empty worktree list', () => {
    const h = makeHarness();
    h.service.focusNextWorktree();
    h.service.focusPrevWorktree();
    expect(h.claude.getViewer).not.toHaveBeenCalled();
  });

  it('no active-terminal match → index -1 → next lands on the FIRST worktree', () => {
    const { h } = navHarness();
    h.setActiveTerminal({ name: 'unrelated' });
    h.service.focusNextWorktree();
    expect(h.viewers.get('a')!.show).toHaveBeenCalledTimes(1);
    expect(h.viewers.get('b')!.show).not.toHaveBeenCalled();
  });

  it('advances cyclically from the active viewer', () => {
    const { h } = navHarness();
    h.setActiveTerminal(h.viewers.get('c'));
    h.service.focusNextWorktree();
    expect(h.viewers.get('a')!.show).toHaveBeenCalledTimes(1); // wraps around
  });

  it('goes backwards cyclically (prev from first wraps to last)', () => {
    const { h } = navHarness();
    h.setActiveTerminal(h.viewers.get('a'));
    h.service.focusPrevWorktree();
    expect(h.viewers.get('c')!.show).toHaveBeenCalledTimes(1);
  });

  it('prev with no match → index -1 → shows the LAST worktree (-2 mod n)', () => {
    const { h } = navHarness();
    h.setActiveTerminal({ name: 'unrelated' });
    h.service.focusPrevWorktree();
    // (-1 - 1 + 3) % 3 === 1 → worktree b (real code behavior)
    expect(h.viewers.get('b')!.show).toHaveBeenCalledTimes(1);
  });

  it('only shows the viewer — never runs switchToWorktree (no tab churn)', () => {
    const { h } = navHarness();
    const spy = vi.spyOn(h.service, 'switchToWorktree');
    h.setActiveTerminal(h.viewers.get('a'));
    h.service.focusNextWorktree();
    expect(spy).not.toHaveBeenCalled();
    expect(h.tabManager.closeOtherTabs).not.toHaveBeenCalled();
    expect(h.host.saveAll).not.toHaveBeenCalled();
  });

  it('tolerates a target worktree without a viewer', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], viewerIds: ['a'] });
    h.setActiveTerminal(h.viewers.get('a'));
    expect(() => h.service.focusNextWorktree()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VsCodeNotifyAdapter (thin vscode.window adapter used by the service)
// ─────────────────────────────────────────────────────────────────────────────

describe('VsCodeNotifyAdapter', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('showError → vscode.window.showErrorMessage', () => {
    new VsCodeNotifyAdapter().showError('bad');
    expect(window.showErrorMessage).toHaveBeenCalledWith('bad');
  });

  it('showWarning → vscode.window.showWarningMessage', () => {
    new VsCodeNotifyAdapter().showWarning('careful');
    expect(window.showWarningMessage).toHaveBeenCalledWith('careful');
  });

  it('showInfo → vscode.window.showInformationMessage', () => {
    new VsCodeNotifyAdapter().showInfo('fyi');
    expect(window.showInformationMessage).toHaveBeenCalledWith('fyi');
  });

  it('confirm shows a modal warning with detail and items, returning the choice', async () => {
    window.showWarningMessage.mockResolvedValue('Kill');
    const res = await new VsCodeNotifyAdapter().confirm('Kill terminal?', 'details here', 'Kill');
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'Kill terminal?',
      { modal: true, detail: 'details here' },
      'Kill',
    );
    expect(res).toBe('Kill');
  });

  it('confirm passes undefined detail through (delete flow has no detail)', async () => {
    window.showWarningMessage.mockResolvedValue(undefined);
    const res = await new VsCodeNotifyAdapter().confirm('Delete worktree "x"?', undefined, 'Delete', 'Delete + branch');
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'Delete worktree "x"?',
      { modal: true, detail: undefined },
      'Delete',
      'Delete + branch',
    );
    expect(res).toBeUndefined();
  });

  it('withProgress uses a non-cancellable notification and maps report(message)', async () => {
    const reportSpy = vi.fn();
    window.withProgress.mockImplementation(async (_opts: unknown, task: (p: { report: (v: unknown) => void }) => Promise<unknown>) =>
      task({ report: reportSpy }));
    const result = await new VsCodeNotifyAdapter().withProgress('Doing things', async (report) => {
      report('step 1');
      return 42;
    });
    expect(result).toBe(42);
    expect(window.withProgress).toHaveBeenCalledWith(
      { location: ProgressLocation.Notification, title: 'Doing things', cancellable: false },
      expect.any(Function),
    );
    expect(reportSpy).toHaveBeenCalledWith({ message: 'step 1' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diff review panel (DiffPanelHost)
// ─────────────────────────────────────────────────────────────────────────────

describe('diff review panel', () => {
  const wtA = { id: 'wt-a', branch: 'feat/x', alias: 'Fix X', path: '/repo/zer/wt-a', repoRoot: '/repo', xdebugPort: 9898, dockerProjectName: 'wt-a', createdAt: 0 } as unknown as Worktree;

  it('openDiff message opens the panel for the worktree', async () => {
    const h = makeHarness({ worktrees: [wtA] });
    await h.service.handleMessage({ type: 'openDiff', worktreeId: 'wt-a' });
    expect(h.ui.openDiffPanel).toHaveBeenCalledWith('wt-a');
  });

  it('getContext reports label and live-agent presence', () => {
    const h = makeHarness({ worktrees: [wtA] });
    h.claude.getAgentCount.mockReturnValue(2);
    expect(h.service.getContext('wt-a')).toEqual({ label: 'Fix X', hasLiveAgent: true });
    h.claude.getAgentCount.mockReturnValue(0);
    expect(h.service.getContext('wt-a')).toEqual({ label: 'Fix X', hasLiveAgent: false });
    expect(h.service.getContext('nope')).toBeUndefined();
  });

  it('getContext falls back to the branch when the worktree has no alias', () => {
    const noAlias = { ...wtA, id: 'wt-b', alias: undefined, branch: 'feat/y' } as unknown as Worktree;
    const h = makeHarness({ worktrees: [noAlias] });
    expect(h.service.getContext('wt-b')?.label).toBe('feat/y');
  });

  it('getDiff delegates to git.diff with the worktree path', async () => {
    const h = makeHarness({ worktrees: [wtA], diffOutput: 'DIFF!' });
    expect(await h.service.getDiff('wt-a', 'branch')).toBe('DIFF!');
    expect(h.git.diff).toHaveBeenCalledWith('/repo/zer/wt-a', { base: 'branch' });
    expect(await h.service.getDiff('missing', 'branch')).toBe('');
  });

  const comment = { file: 'src/foo.ts', side: 'new' as const, line: 10, code: 'x', body: 'do it' };

  it('send → live pastes into the running agent', async () => {
    const h = makeHarness({ worktrees: [wtA], liveAgentAccepts: true });
    expect(await h.service.send('wt-a', 'live', [comment])).toBe(true);
    expect(h.claude.sendPromptToAgent).toHaveBeenCalled();
  });

  it('send → live returns false when no agent is running', async () => {
    const h = makeHarness({ worktrees: [wtA], liveAgentAccepts: false });
    expect(await h.service.send('wt-a', 'live', [comment])).toBe(false);
  });

  it('send → new launches a fresh agent with the prompt', async () => {
    const h = makeHarness({ worktrees: [wtA] });
    expect(await h.service.send('wt-a', 'new', [comment])).toBe(true);
    expect(h.claude.launchWithPrompt).toHaveBeenCalled();
  });

  it('send → clipboard writes the prompt', async () => {
    const h = makeHarness({ worktrees: [wtA] });
    expect(await h.service.send('wt-a', 'clipboard', [comment])).toBe(true);
    expect(h.host.writeClipboard).toHaveBeenCalledWith(expect.stringContaining('src/foo.ts:10'));
  });

  it('send returns false with no comments (empty prompt)', async () => {
    const h = makeHarness({ worktrees: [wtA] });
    expect(await h.service.send('wt-a', 'new', [])).toBe(false);
    expect(h.claude.launchWithPrompt).not.toHaveBeenCalled();
  });

  it('send returns false for an unknown worktree', async () => {
    const h = makeHarness({ worktrees: [wtA] });
    expect(await h.service.send('nope', 'new', [comment])).toBe(false);
    expect(h.claude.launchWithPrompt).not.toHaveBeenCalled();
  });

  it('openFile resolves the path against the worktree and opens it (with line)', async () => {
    const h = makeHarness({ worktrees: [wtA] });
    await h.service.openFile('wt-a', 'src/foo.ts', 42);
    expect(h.host.openFileInEditor).toHaveBeenCalledWith('/repo/zer/wt-a/src/foo.ts', 42);
  });

  it('openFile is a no-op for an unknown worktree', async () => {
    const h = makeHarness({ worktrees: [wtA] });
    await h.service.openFile('nope', 'src/foo.ts');
    expect(h.host.openFileInEditor).not.toHaveBeenCalled();
  });
});
