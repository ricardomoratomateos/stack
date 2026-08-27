import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import {
  WorktreeApplicationService,
  ACTIVE_WORKTREE_KEY,
  WORKTREE_ORDER_KEY,
  type IWorkspaceHost,
} from '../../src/application/WorktreeApplicationService';
import { VsCodeNotifyAdapter } from '../../src/adapters/VsCodeNotifyAdapter';
import { window, ProgressLocation, resetVscodeMock } from '../__mocks__/vscode';
import type { Worktree, UnmessConfig } from '../../src/types';
import type { SessionItem } from '../../src/webview/types';
import type { ProviderId } from '../../src/ports/IAgentProvider';
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
  /** Make git.fetchBranch reject, as a repo with no remote would. */
  fetchFails?: boolean;
  /** what agentManager.sendPromptToAgent resolves to (a live agent existed) */
  liveAgentAccepts?: boolean;
  /** persisted worktree display order (ids) */
  worktreeOrder?: string[];
  /** what dockerMonitor.refresh resolves to after a teardown (leftover containers) */
  containersLeftAfterDown?: Array<{ name: string; state: string }>;
  /** agents reported as runnable; defaults to none so tests never read the real PATH */
  installedProviders?: ProviderId[];
  /** omit the injection entirely and exercise the real PATH lookup */
  useRealInstalledProviders?: boolean;
  /** branches returned by git.listBranches */
  branches?: string[];
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
    focusMode: false,
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
    setSessionOrder: vi.fn((id: string, order: number[]) => { calls.push(`claude.setSessionOrder:${id}:${order.join(',')}`); }),
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
    openExternal: vi.fn(async (url: string) => { calls.push(`host.openExternal:${url}`); }),
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
    // Ports are free by default; tests that care override this.
    ensureFreePorts: vi.fn(async (wt: Worktree) => ({ worktree: wt })),
  };

  const gitWatcher = {
    watch: vi.fn((p: string, base?: string) => { calls.push(`gitWatcher.watch:${p}${base ? `:${base}` : ''}`); }),
    unwatch: vi.fn((p: string) => { calls.push(`gitWatcher.unwatch:${p}`); }),
    refreshNow: vi.fn(async (p: string) => { calls.push(`gitWatcher.refreshNow:${p}`); }),
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
    nudge: vi.fn((project: string) => { calls.push(`docker.nudge:${project}`); }),
    refresh: vi.fn((project: string) => {
      calls.push(`docker.refresh:${project}`);
      return Promise.resolve(o.containersLeftAfterDown ?? []);
    }),
  };
  const prMonitor = {
    startPolling: vi.fn((branch: string, id: string, cb: () => void) => { calls.push(`pr.startPolling:${branch}:${id}`); prCallbacks.set(id, cb); }),
    getStatus: vi.fn((): { number: number; state: string; url: string } | undefined => undefined),
    stopPolling: vi.fn((id: string) => { calls.push(`pr.stopPolling:${id}`); }),
  };
  const git = {
    currentBranch: vi.fn((): string => ''),
    diff: vi.fn(async () => o.diffOutput ?? ''),
    listBranches: vi.fn((): string[] => o.branches ?? []),
    // No remote counterpart unless a test says otherwise.
    remoteBranch: vi.fn((): string | undefined => undefined),
    mainBranch: vi.fn((): string | undefined => undefined),
    // A branch "exists" when it is in the harness's branch list.
    branchExists: vi.fn((b: string): boolean => (o.branches ?? []).includes(b)),
    fetchBranch: vi.fn(async (cwd: string, remote: string, branch: string) => {
      calls.push(`git.fetchBranch:${cwd}:${remote}/${branch}`);
      if (o.fetchFails) throw new Error('no such remote');
    }),
  };
  const globalState = {
    get: vi.fn(<T,>(k: string): T | undefined => {
      if (k === ACTIVE_WORKTREE_KEY) return o.persistedActiveId as T | undefined;
      if (k === WORKTREE_ORDER_KEY) return o.worktreeOrder as T | undefined;
      return undefined;
    }),
    update: vi.fn(async (k: string, v: unknown) => { calls.push(`globalState.update:${k}:${v}`); }),
  };
  const ui = {
    pushWebview: vi.fn(() => { calls.push('ui.pushWebview'); }),
    // Kept out of `calls` on purpose so exact call-order assertions stay focused.
    syncDecorations: vi.fn(),
    openDiffPanel: vi.fn((id: string) => { calls.push(`ui.openDiffPanel:${id}`); }),
  };
  const config = { get: vi.fn(() => cfg), setDefaultProvider: vi.fn().mockResolvedValue(undefined) };

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
    installedProviders: o.useRealInstalledProviders ? undefined : () => o.installedProviders ?? [],
  });
  if (o.withUi !== false) service.setUi(ui);

  return {
    service, calls, worktrees, viewers, makeViewer, claude, tabManager, breakpointManager, host, notify, store,
    manager, gitWatcher, dockerMonitor, prMonitor, git, globalState, ui, cfg, config,
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
    // The switch runs first — anchor on its last step (search scoping). The
    // target has no terminals, so the ONLY getOrCreateViewer comes from
    // focusTerminal itself, after the switch has finished.
    const scopingIdx = h.calls.indexOf('host.updateFolderSetting:/repo/zer/feat-b:search.exclude:clear');
    expect(scopingIdx).toBeGreaterThan(-1);
    expect(h.calls.indexOf('claude.getOrCreateViewer:b')).toBeGreaterThan(scopingIdx);
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


describe('activeWorktreeLabel', () => {
  it('returns undefined when no worktree is active', () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    expect(h.service.activeWorktreeLabel()).toBeUndefined();
  });

  it('returns undefined when the persisted active id no longer exists', () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], persistedActiveId: 'gone' });
    expect(h.service.activeWorktreeLabel()).toBeUndefined();
  });

  it('prefers the alias of the active worktree', () => {
    const h = makeHarness({
      worktrees: [makeWorktree({ id: 'a', alias: 'login fix' })],
      persistedActiveId: 'a',
    });
    expect(h.service.activeWorktreeLabel()).toBe('login fix');
  });

  it('falls back to the branch when there is no alias', () => {
    const h = makeHarness({
      worktrees: [makeWorktree({ id: 'a', branch: 'feat/drop' })],
      persistedActiveId: 'a',
    });
    expect(h.service.activeWorktreeLabel()).toBe('feat/drop');
  });
});

describe('attachDroppedFiles', () => {
  it('reveals the active worktree viewer and pastes all paths single-quoted, unsent', async () => {
    const h = makeHarness({
      worktrees: [makeWorktree({ id: 'a' }), makeWorktree({ id: 'b', branch: 'feat/b' })],
      persistedActiveId: 'a',
      terminalIds: ['a'],
    });
    await h.service.attachDroppedFiles(['/shots/a b.png', '/shots/two.png']);
    expect(h.claude.getOrCreateViewer).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(h.viewers.get('a')!.show).toHaveBeenCalled();
    expect(h.claude.pasteToActiveWindow).toHaveBeenCalledWith('a', "'/shots/a b.png' '/shots/two.png' ");
  });

  it('does nothing for an empty path list', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], persistedActiveId: 'a', terminalIds: ['a'] });
    await h.service.attachDroppedFiles([]);
    expect(h.claude.pasteToActiveWindow).not.toHaveBeenCalled();
    expect(h.notify.showWarning).not.toHaveBeenCalled();
  });

  it('falls back to the only worktree when none is active', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], terminalIds: ['a'] });
    await h.service.attachDroppedFiles(['/shots/x.png']);
    expect(h.claude.pasteToActiveWindow).toHaveBeenCalledWith('a', "'/shots/x.png' ");
    // The fallback switch makes it the active worktree for the next drop.
    expect(h.service.activeWorktreeLabel()).toBe('feat/a');
  });

  it('warns when no worktree is active and several exist', async () => {
    const h = makeHarness({
      worktrees: [makeWorktree({ id: 'a' }), makeWorktree({ id: 'b', branch: 'feat/b' })],
    });
    await h.service.attachDroppedFiles(['/shots/x.png']);
    expect(h.notify.showWarning).toHaveBeenCalledWith('Unmess: select a worktree first, then drop the image again.');
    expect(h.claude.pasteToActiveWindow).not.toHaveBeenCalled();
  });

  it('warns (with the alias) when the target worktree has no sessions', async () => {
    const h = makeHarness({
      worktrees: [makeWorktree({ id: 'a', alias: 'login fix' })],
      persistedActiveId: 'a',
    });
    await h.service.attachDroppedFiles(['/shots/x.png']);
    expect(h.notify.showWarning).toHaveBeenCalledWith(
      'Unmess: no agent session in login fix — launch one, then drop the image again.',
    );
    expect(h.claude.pasteToActiveWindow).not.toHaveBeenCalled();
  });

  it('warns with the branch when the session-less target has no alias', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a', branch: 'feat/a' })], persistedActiveId: 'a' });
    await h.service.attachDroppedFiles(['/shots/x.png']);
    expect(h.notify.showWarning).toHaveBeenCalledWith(
      'Unmess: no agent session in feat/a — launch one, then drop the image again.',
    );
  });

  it('still pastes when the viewer cannot be created', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], persistedActiveId: 'a', terminalIds: ['a'] });
    h.claude.getOrCreateViewer.mockRejectedValue(new Error('boom'));
    await h.service.attachDroppedFiles(['/shots/x.png']);
    expect(h.claude.pasteToActiveWindow).toHaveBeenCalledWith('a', "'/shots/x.png' ");
  });
});

describe('handleMessage reorderSessions', () => {
  it('persists the new session order and re-renders the webview', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], withUi: true });
    await h.service.handleMessage({ type: 'reorderSessions', worktreeId: 'a', orderedIndexes: [3, 1, 2] });
    expect(h.claude.setSessionOrder).toHaveBeenCalledWith('a', [3, 1, 2]);
    expect(h.ui.pushWebview).toHaveBeenCalled();
  });
});

describe('handleMessage listBranches', () => {
  const repoOpts = { workspaceFolders: ['/repo'], gitDirs: ['/repo/.git'], withUi: true };

  it('loads the branch list plus the current branch and pushes it to the webview', async () => {
    const h = makeHarness({ ...repoOpts, branches: ['feat/x', 'main', 'develop'] });
    h.git.currentBranch.mockReturnValue('main');
    await h.service.handleMessage({ type: 'listBranches' });
    expect(h.git.listBranches).toHaveBeenCalledWith('/repo');
    expect(h.ui.pushWebview).toHaveBeenCalled();
    const state = h.service.buildState();
    expect(state.branches).toEqual(['feat/x', 'main', 'develop']);
    expect(state.baseBranch).toBe('main');
  });

  it('falls back to an empty base branch when git is on a detached HEAD', async () => {
    const h = makeHarness({ ...repoOpts, branches: ['main'] });
    h.git.currentBranch.mockImplementation(() => { throw new Error('detached'); });
    await h.service.handleMessage({ type: 'listBranches' });
    expect(h.service.buildState().baseBranch).toBe('');
  });

  it('does nothing when there is no git repository in the workspace', async () => {
    const h = makeHarness({ withUi: true }); // no gitDirs → no repo root
    await h.service.handleMessage({ type: 'listBranches' });
    expect(h.git.listBranches).not.toHaveBeenCalled();
    expect(h.service.buildState().branches).toBeUndefined();
  });

  it('leaves branches undefined until the webview asks', () => {
    const h = makeHarness(repoOpts);
    const state = h.service.buildState();
    expect(state.branches).toBeUndefined();
    expect(state.baseBranch).toBeUndefined();
    expect(h.git.listBranches).not.toHaveBeenCalled();
  });
});

describe('handleMessage reorderWorktrees', () => {
  it('persists the new worktree order and re-renders the webview', async () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], withUi: true });
    await h.service.handleMessage({ type: 'reorderWorktrees', orderedIds: ['b', 'a', 'c'] });
    expect(h.globalState.update).toHaveBeenCalledWith(WORKTREE_ORDER_KEY, ['b', 'a', 'c']);
    expect(h.ui.pushWebview).toHaveBeenCalled();
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
    const spy = vi.spyOn(h.service, 'initWorktree').mockImplementation(async () => {});
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

  // ── default path: reveal, never rebuild ──────────────────────────────────
  describe('reveal (default, focusMode off)', () => {
    it('tears down nothing: no saveAll, no closeViewer, no tab churn', async () => {
      const { h } = switchHarness({ viewerIds: ['a', 'c'], terminalIds: ['b'] });
      await h.service.switchToWorktree('b');
      expect(h.host.saveAll).not.toHaveBeenCalled();
      expect(h.claude.closeViewer).not.toHaveBeenCalled();
      expect(h.tabManager.closeOtherTabs).not.toHaveBeenCalled();
      expect(h.tabManager.restoreTabs).not.toHaveBeenCalled();
      expect(h.tabManager.updateViewerState).not.toHaveBeenCalled();
      expect(h.host.moveEditorToFirstInGroup).not.toHaveBeenCalled();
    });

    it('order: persist → pushWebview → reveal the session terminal → scoping', async () => {
      const { h } = switchHarness({ viewerIds: ['a'], terminalIds: ['b'] });
      await h.service.switchToWorktree('b');
      expect(h.calls).toEqual([
        'globalState.update:unmess.activeWorktreeId:b',
        'ui.pushWebview',
        'claude.getOrCreateViewer:b',
        'viewer.show:b',
        'host.updateFolderSetting:/repo/zer/feat-a:search.exclude:{"**":true}',
        'host.updateFolderSetting:/repo/zer/feat-b:search.exclude:clear',
        'host.updateFolderSetting:/repo/zer/feat-c:search.exclude:{"**":true}',
      ]);
    });

    it('opens no file: the terminal and the editor must not fight for the foreground', async () => {
      const { h } = switchHarness({ terminalIds: ['b'], existingPaths: ['/repo/zer/feat-b/src/foo.ts'] });
      await h.service.switchToWorktree('b');
      expect(h.host.openFileInEditor).not.toHaveBeenCalled();
    });

    it('still finishes the switch (dimming + scoping) when the worktree has no sessions', async () => {
      const { h } = switchHarness();
      await h.service.switchToWorktree('b');
      expect(h.claude.getOrCreateViewer).not.toHaveBeenCalled();
      expect(h.ui.syncDecorations).toHaveBeenCalled();
      expect(h.host.updateFolderSetting).toHaveBeenCalled();
    });

    it('tolerates viewer creation failure without breaking the switch', async () => {
      const { h } = switchHarness({ terminalIds: ['b'] });
      h.claude.getOrCreateViewer.mockRejectedValue(new Error('boom'));
      await expect(h.service.switchToWorktree('b')).resolves.toBeUndefined();
      expect(h.ui.syncDecorations).toHaveBeenCalled();
    });
  });

  // ── unmess.focusMode: the clean-slate teardown behaviour ─────────────────
  describe('focusMode (clean slate)', () => {
    const focus = (over: HarnessOpts = {}) =>
      switchHarness({ ...over, config: { focusMode: true, ...(over.config ?? {}) } });

    it('snapshots hadViewer for ALL worktrees BEFORE closing viewers', async () => {
      const { h } = focus({ viewerIds: ['a', 'c'] });
      await h.service.switchToWorktree('b');
      const snapshotIdx = h.calls.indexOf('tab.updateViewerState:a,b,c:a,c');
      expect(snapshotIdx).toBeGreaterThan(-1);
      expect(snapshotIdx).toBeLessThan(h.calls.indexOf('claude.closeViewer:a'));
      expect(snapshotIdx).toBeLessThan(h.calls.indexOf('claude.closeViewer:c'));
    });

    it('calls saveAll(false) before closing any tab or viewer', async () => {
      const { h } = focus({ viewerIds: ['a'] });
      await h.service.switchToWorktree('b');
      const saveIdx = h.calls.indexOf('host.saveAll:false');
      expect(saveIdx).toBeGreaterThan(-1);
      expect(saveIdx).toBeLessThan(h.calls.indexOf('claude.closeViewer:a'));
      expect(saveIdx).toBeLessThan(h.calls.indexOf('tab.closeOtherTabs:b'));
    });

    it('closes all other worktrees viewers (and only those)', async () => {
      const { h } = focus({ viewerIds: ['a', 'c'] });
      await h.service.switchToWorktree('b');
      expect(h.claude.closeViewer).toHaveBeenCalledWith('a');
      expect(h.claude.closeViewer).toHaveBeenCalledWith('c');
      expect(h.claude.closeViewer).not.toHaveBeenCalledWith('b');
    });

    it('tolerates viewer creation failure and continues the switch', async () => {
      const { h } = focus({ terminalIds: ['b'] });
      h.claude.getOrCreateViewer.mockRejectedValue(new Error('boom'));
      await h.service.switchToWorktree('b');
      expect(h.tabManager.closeOtherTabs).toHaveBeenCalledWith('b', h.worktrees);
      expect(h.tabManager.restoreTabs).toHaveBeenCalledWith('b');
    });

    it('order: persist → pushWebview → updateViewerState → saveAll → closeViewers → viewer → closeOtherTabs → restoreTabs', async () => {
      vi.useFakeTimers();
      const { h } = focus({ viewerIds: ['a'], terminalIds: ['b'] });
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
      const { h } = focus({ terminalIds: ['b'] });
      await h.service.switchToWorktree('b');
      const showCount = h.viewers.get('b')!.show.mock.calls.length;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.viewers.get('b')!.show.mock.calls.length).toBe(showCount + 1);
      expect(h.host.moveEditorToFirstInGroup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      expect(h.host.moveEditorToFirstInGroup).toHaveBeenCalledTimes(1);
    });

    it('skips moveEditorToFirstInGroup when there is no viewer', async () => {
      const { h } = focus();
      await h.service.switchToWorktree('b');
      await flushMicrotasks();
      expect(h.host.moveEditorToFirstInGroup).not.toHaveBeenCalled();
    });

    it('swallows restoreTabs failure without breaking the switch', async () => {
      const { h } = focus();
      h.tabManager.restoreTabs.mockRejectedValue(new Error('restore boom'));
      await expect(h.service.switchToWorktree('b')).resolves.toBeUndefined();
      await flushMicrotasks();
      expect(h.host.moveEditorToFirstInGroup).not.toHaveBeenCalled();
    });
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
        // Empty because the default config names no ports; the derivation is
        // covered on its own below.
        ports: [],
        pr: { number: 7, state: 'OPEN', url: 'u' },
      }],
      activeWorktreeId: 'a',
      defaultProvider: 'claude',
      // The harness config leaves the *Command settings unset, so nothing
      // resolves on PATH and the card would dim every agent.
      installedProviders: [],
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

  it('applies the saved worktree order, always pinning main first', () => {
    const main = makeWorktree({ id: 'main', isMain: true });
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b' });
    const c = makeWorktree({ id: 'c' });
    const h = makeHarness({ worktrees: [a, b, c, main], worktreeOrder: ['c', 'a', 'b'] });
    expect(h.service.buildState().worktrees.map((w) => w.id)).toEqual(['main', 'c', 'a', 'b']);
  });

  it('places worktrees missing from the saved order at the end (stable)', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b' });
    const c = makeWorktree({ id: 'c' });
    const h = makeHarness({ worktrees: [a, b, c], worktreeOrder: ['c'] });
    expect(h.service.buildState().worktrees.map((w) => w.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps natural order when no order is persisted', () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b' });
    const h = makeHarness({ worktrees: [a, b] });
    expect(h.service.buildState().worktrees.map((w) => w.id)).toEqual(['a', 'b']);
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
    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, undefined);
  });

  it('passes the title as the worktree alias (trimmed), keeping the description as the prompt', async () => {
    vi.useFakeTimers();
    const { h, created } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x', title: '  My task  ', description: 'do the thing' });
    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, 'My task', undefined);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.claude.launchWithPrompt).toHaveBeenCalledWith(created, 'do the thing');
  });

  it('passes undefined alias when no title is given', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x', description: 'only a prompt' });
    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, undefined);
  });

  it('forwards the chosen base branch from the webview message', async () => {
    vi.useFakeTimers();
    const { h } = createHarness();
    await h.service.handleMessage({
      type: 'createWorktree', branch: 'feat/x', title: 'T', description: 'd', baseBranch: 'develop',
    });
    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, 'T', 'develop');
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

  it('the docker polling callback registered on create pushes webview state', async () => {
    // It used to be a deliberate no-op, which is why a worktree's containers
    // only appeared in the sidebar after reloading the window: the setup script
    // brought the stack up minutes later and nothing ever repainted.
    vi.useFakeTimers();
    const { h } = createHarness();
    await h.service.createWorktree({ branch: 'feat/x' });
    h.calls.length = 0;
    h.dockerCallbacks.get('feat-x')!();
    expect(h.calls).toEqual(['ui.pushWebview']);
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

  it('starts the setup script BEFORE the workspace/monitor wiring', async () => {
    vi.useFakeTimers();
    const { h } = createHarness({ config: { setupScript: '/scripts/setup.sh' } });
    await h.service.createWorktree({ branch: 'feat/x' });
    const setupIdx = h.calls.indexOf('host.createTerminal:Init: feat/x:/repo/zer/feat-x');
    const wiringIdx = h.calls.findIndex((c) => c.startsWith('host.addWorkspaceFolders'));
    expect(setupIdx).toBeGreaterThan(-1);
    expect(wiringIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeLessThan(wiringIdx);
  });

  it.each([
    ['addWorkspaceFolders', (h: ReturnType<typeof createHarness>['h']) => h.host.addWorkspaceFolders],
    ['gitWatcher.watch', (h: ReturnType<typeof createHarness>['h']) => h.gitWatcher.watch],
    ['dockerMonitor.startPolling', (h: ReturnType<typeof createHarness>['h']) => h.dockerMonitor.startPolling],
    ['prMonitor.startPolling', (h: ReturnType<typeof createHarness>['h']) => h.prMonitor.startPolling],
  ])('still runs the setup script when %s throws (worktree must not be left bare)', async (_name, pick) => {
    vi.useFakeTimers();
    const { h } = createHarness({ config: { setupScript: '/scripts/setup.sh' } });
    pick(h).mockImplementation(() => { throw new Error('boom'); });
    await h.service.createWorktree({ branch: 'feat/x' });
    expect(h.calls).toContain('host.createTerminal:Init: feat/x:/repo/zer/feat-x');
    // A wiring failure is not a creation failure.
    expect(h.notify.showError).not.toHaveBeenCalled();
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
      'pr.stopPolling:a',
      'claude.killWorktreeSession:a',
      'manager.delete:a:false',
      // finally: cleared + refreshed
      'ui.pushWebview',
    ]);
  });

  it('runs the teardown script, then awaits its own compose down before deleting', async () => {
    // The script goes to a terminal that cannot be awaited. It used to get a
    // flat 2s head start, which is far less than one `compose down`, so
    // `git worktree remove` yanked the directory and the containers survived.
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      config: {
        teardownScript: '/scripts/teardown.sh',
        docker: { composeFile: 'docker-compose.yml', overrideFile: '', ports: ['HTTP_PORT'], basePort: 20000, portStride: 100 },
      },
      existingPaths: [a.path],
    });

    await h.service.deleteWorktree(a);

    expect(h.calls).toContain(`host.createTerminal:Teardown: feat/a:${a.path}`);
    const downAt = h.calls.findIndex((c) => c.startsWith('docker.runCompose:feat-a') && c.includes(' down'));
    const deleteAt = h.calls.indexOf('manager.delete:a:false');
    expect(downAt).toBeGreaterThanOrEqual(0);
    // The stack must be down BEFORE the worktree directory goes away.
    expect(downAt).toBeLessThan(deleteAt);
    expect(h.claude.killWorktreeSession).toHaveBeenCalledWith('a');
  });

  it('warns when containers outlive the teardown instead of reporting success', async () => {
    // A stack registered under a different compose project name than the one
    // derived from the directory is invisible to `compose down` — which then
    // succeeds having removed nothing.
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      config: { docker: { composeFile: 'docker-compose.yml', overrideFile: '', ports: ['HTTP_PORT'], basePort: 20000, portStride: 100 } },
      containersLeftAfterDown: [{ name: 'feat-a-web-1', state: 'running' }],
    });

    await h.service.deleteWorktree(a);

    expect(h.notify.showWarning).toHaveBeenCalledWith(expect.stringContaining('left 1 container(s) running'));
  });

  it('says nothing when the stack really did come down', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a],
      confirmResult: 'Delete',
      config: { docker: { composeFile: 'docker-compose.yml', overrideFile: '', ports: ['HTTP_PORT'], basePort: 20000, portStride: 100 } },
    });

    await h.service.deleteWorktree(a);

    expect(h.notify.showWarning).not.toHaveBeenCalled();
  });

  it('skips compose entirely when docker is not configured', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], confirmResult: 'Delete' });

    await h.service.deleteWorktree(a);

    expect(h.calls.some((c) => c.startsWith('docker.runCompose'))).toBe(false);
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
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a], confirmResult: 'Delete',
      config: { teardownScript: '/scripts/teardown.sh', docker: { composeFile: 'docker-compose.yml', overrideFile: '', ports: ['HTTP_PORT'], basePort: 20000, portStride: 100 } },
      existingPaths: [a.path],
    });
    // Hold the delete on its one real await — the compose down.
    let release!: () => void;
    h.dockerMonitor.runCompose.mockReturnValue(new Promise<void>((r) => { release = r; }));

    const done = h.service.deleteWorktree(a);
    await Promise.resolve();

    expect(h.service.buildState().worktrees[0].deleting).toBe(true);
    release();
    await done;
    expect(h.service.buildState().worktrees[0].deleting).toBe(false);
  });

  it('ignores actions targeting a worktree that is tearing down', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a], confirmResult: 'Delete',
      config: { teardownScript: '/scripts/teardown.sh', docker: { composeFile: 'docker-compose.yml', overrideFile: '', ports: ['HTTP_PORT'], basePort: 20000, portStride: 100 } },
      existingPaths: [a.path],
    });
    let release!: () => void;
    h.dockerMonitor.runCompose.mockReturnValue(new Promise<void>((r) => { release = r; }));

    const done = h.service.deleteWorktree(a);
    await Promise.resolve();

    await h.service.handleMessage({ type: 'launchAgent', worktreeId: 'a' });
    await h.service.handleMessage({ type: 'openTerminal', worktreeId: 'a' });
    expect(h.claude.launch).not.toHaveBeenCalled();
    expect(h.claude.openTerminal).not.toHaveBeenCalled();

    release();
    await done;
  });

  it('does not start a second teardown if delete is triggered again while tearing down', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({
      worktrees: [a], confirmResult: 'Delete',
      config: { teardownScript: '/scripts/teardown.sh', docker: { composeFile: 'docker-compose.yml', overrideFile: '', ports: ['HTTP_PORT'], basePort: 20000, portStride: 100 } },
      existingPaths: [a.path],
    });
    let release!: () => void;
    h.dockerMonitor.runCompose.mockReturnValue(new Promise<void>((r) => { release = r; }));

    const done = h.service.deleteWorktree(a);
    await Promise.resolve();

    await h.service.deleteWorktree(a); // ignored — already deleting
    expect(h.notify.confirm).toHaveBeenCalledTimes(1);

    release();
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
  it('does nothing when no worktree given and store is empty', async () => {
    const h = makeHarness();
    await h.service.initWorktree(undefined);
    expect(h.notify.showError).not.toHaveBeenCalled();
  });

  it('targets the ACTIVE worktree when invoked with no argument (command palette)', async () => {
    const a = makeWorktree({ id: 'a' });
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [a, b], config: { setupScript: '/scripts/setup.sh' } });
    await h.service.switchToWorktree('b');
    await h.service.initWorktree(undefined);
    // Not 'a', which is merely first in the store — that would run a heavy setup
    // against a worktree the user is not even looking at.
    expect(h.calls).toContain('host.createTerminal:Init: feat/b:/repo/zer/feat-b');
  });

  it('falls back to the first worktree when nothing is active yet', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: '/scripts/setup.sh' } });
    await h.service.initWorktree(undefined);
    expect(h.calls).toContain('host.createTerminal:Init: feat/a:/repo/zer/feat-a');
  });

  it('shows an error when no setup script is configured', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a] });
    await h.service.initWorktree(a);
    expect(h.notify.showError).toHaveBeenCalledWith('No setup script configured. Set "unmess.setupScript" in settings.');
    expect(h.host.createTerminal).not.toHaveBeenCalled();
  });

  it('re-runs the setup script in a visible terminal (no completion echo)', async () => {
    const a = makeWorktree({ id: 'a', alias: 'My task' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: '/scripts/setup.sh' } });
    await h.service.initWorktree(a);
    expect(h.calls).toEqual([
      'host.createTerminal:Init: My task:/repo/zer/feat-a',
      'claude.register:a',
      'terminal.show:Init: My task',
      'terminal.sendText:UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-a" UNMESS_BRANCH="feat/a" UNMESS_COMPOSE_PROJECT="feat-a" bash "/scripts/setup.sh"',
    ]);
  });

  it('resolves a relative setup script in the worktree and injects the docker ports', async () => {
    const a = makeWorktree({ id: 'a', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({
      worktrees: [a],
      config: {
        setupScript: '.unmess/setup.sh',
        docker: { composeFile: '.unmess/docker-compose.worktree.yml', overrideFile: '', ports: ['WORKTREE_PORT'], basePort: 8081, portStride: 1 },
      },
      existingPaths: ['/repo/zer/feat-b/.unmess/setup.sh'],
    });
    await h.service.initWorktree(a);
    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-b" UNMESS_BRANCH="feat/b" UNMESS_COMPOSE_PROJECT="feat-b" WORKTREE_PORT="8081" bash "/repo/zer/feat-b/.unmess/setup.sh"',
    );
  });

  it('uses an absolute setup script path as-is when it exists', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: '/abs/setup.sh' }, existingPaths: ['/abs/setup.sh'] });
    await h.service.initWorktree(a);
    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-a" UNMESS_BRANCH="feat/a" UNMESS_COMPOSE_PROJECT="feat-a" bash "/abs/setup.sh"',
    );
  });

  it('falls back to the repo root for a relative setup script the branch does not carry', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: 'scripts/setup.sh' } }); // present in neither
    await h.service.initWorktree(a);
    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-a" UNMESS_BRANCH="feat/a" UNMESS_COMPOSE_PROJECT="feat-a" bash "/repo/scripts/setup.sh"',
    );
  });

  it('falls back to the first store entry', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], config: { setupScript: '/s.sh' } });
    await h.service.initWorktree(undefined);
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

// ─────────────────────────────────────────────────────────────────────────────
// Port re-check before bringing a stack up
// ─────────────────────────────────────────────────────────────────────────────

describe('port re-check before setup / compose up', () => {
  const dockerCfg = {
    docker: {
      composeFile: '.unmess/docker-compose.worktree.yml',
      overrideFile: '',
      ports: ['WORKTREE_PORT', 'XDEBUG_PORT'],
      basePort: 8081,
      portStride: 1,
    },
  };

  /** Make the manager report the worktree's block as stolen and hand back a new slot. */
  function reassignTo(h: ReturnType<typeof makeHarness>, xdebugPort: number, movedFrom: number) {
    h.manager.ensureFreePorts.mockImplementation(async (wt: Worktree) => ({
      worktree: { ...wt, xdebugPort },
      movedFrom,
    }));
  }

  it('brings the stack up on the reassigned ports, not the stolen ones', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b', xdebugPort: 9901 });
    const h = makeHarness({ worktrees: [b], config: dockerCfg });
    reassignTo(h, 9903, 8083); // 8083 held by a foreign container

    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'b' });

    // Slot 4 → WORKTREE_PORT 8085. The old 8083 must appear nowhere.
    expect(h.calls).toContain(
      'terminal.sendText:WORKTREE_PORT=8085 XDEBUG_PORT=9903 docker compose -p "feat-b" -f "/repo/.unmess/docker-compose.worktree.yml" up -d',
    );
  });

  it('names the busy port and the new block so the user can see what moved', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b', xdebugPort: 9901 });
    const h = makeHarness({ worktrees: [b], config: dockerCfg });
    reassignTo(h, 9903, 8083);

    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'b' });

    expect(h.notify.showWarning).toHaveBeenCalledWith(
      'Port 8083 is already in use — "feat/b" moved to 9903, 8085.',
    );
  });

  it('says nothing when the ports were still free', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [b], config: dockerCfg });

    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'b' });

    expect(h.notify.showWarning).not.toHaveBeenCalled();
  });

  it('re-runs setup with the reassigned ports, so the .env it writes matches the stack', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b', xdebugPort: 9901 });
    const h = makeHarness({ worktrees: [b], config: { ...dockerCfg, setupScript: '/s.sh' } });
    reassignTo(h, 9903, 8083);

    await h.service.initWorktree(b);

    expect(h.terminalsCreated[0].sendText).toHaveBeenCalledWith(
      'UNMESS_REPO_ROOT="/repo" UNMESS_WORKTREE_PATH="/repo/zer/feat-b" UNMESS_BRANCH="feat/b" ' +
        'UNMESS_COMPOSE_PROJECT="feat-b" WORKTREE_PORT="8085" XDEBUG_PORT="9903" bash "/s.sh"',
    );
  });

  it('leaves teardown on the original ports — it must address the stack that is actually up', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b', xdebugPort: 9901 });
    const h = makeHarness({
      worktrees: [b],
      config: { ...dockerCfg, teardownScript: '/t.sh' },
      confirmResult: 'Delete',
    });

    await h.service.deleteWorktree(b);

    expect(h.manager.ensureFreePorts).not.toHaveBeenCalled();
  });

  it('falls back to the current ports when the re-check itself fails, rather than blocking the user', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [b], config: dockerCfg });
    h.manager.ensureFreePorts.mockRejectedValue(new Error('no free slot in range'));

    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'b' });

    // Still brings the stack up; docker reports the collision itself if it comes.
    expect(h.calls).toContain(
      'terminal.sendText:WORKTREE_PORT=8081 XDEBUG_PORT=9899 docker compose -p "feat-b" -f "/repo/.unmess/docker-compose.worktree.yml" up -d',
    );
    expect(h.notify.showWarning).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unmess.defaultBaseBranch — where new worktrees branch from
// ─────────────────────────────────────────────────────────────────────────────

describe('defaultBaseBranch', () => {
  const root = '/repo';
  function harness(o: HarnessOpts = {}) {
    const created = makeWorktree({ id: 'new', branch: 'feat/x', path: '/repo/zer/feat-x' });
    const h = makeHarness({ workspaceFolders: [root], gitDirs: ['/repo/.git'], ...o });
    h.manager.create.mockResolvedValue(created);
    return h;
  }

  describe('preselection in the New Task form', () => {
    it('preselects the configured branch instead of whatever the repo is parked on', async () => {
      // The old behaviour preselected currentBranch, so leaving the main
      // checkout on a feature branch made every new worktree its child.
      const h = harness({
        config: { defaultBaseBranch: 'develop' },
        branches: ['develop', 'main', 'AS-1-something'],
      });
      h.git.currentBranch.mockReturnValue('AS-1-something');

      await h.service.handleMessage({ type: 'listBranches' });

      expect(h.service.buildState().baseBranch).toBe('develop');
    });

    it('falls back to the current branch when the configured one is not in the repo', async () => {
      // Ships with a "develop" default, so a main-only repo must keep working.
      const h = harness({ config: { defaultBaseBranch: 'develop' }, branches: ['main'] });
      h.git.currentBranch.mockReturnValue('main');

      await h.service.handleMessage({ type: 'listBranches' });

      expect(h.service.buildState().baseBranch).toBe('main');
    });

    it('falls back to the current branch when the setting is blank', async () => {
      const h = harness({ config: { defaultBaseBranch: '   ' }, branches: ['main'] });
      h.git.currentBranch.mockReturnValue('main');

      await h.service.handleMessage({ type: 'listBranches' });

      expect(h.service.buildState().baseBranch).toBe('main');
    });

    it('survives a detached HEAD, where currentBranch throws', async () => {
      const h = harness({ config: { defaultBaseBranch: 'develop' }, branches: ['main'] });
      h.git.currentBranch.mockImplementation(() => { throw new Error('detached'); });

      await h.service.handleMessage({ type: 'listBranches' });

      expect(h.service.buildState().baseBranch).toBe('');
    });
  });

  describe('the base actually handed to git', () => {
    it('uses the configured branch when invoked from the command palette (no base given)', async () => {
      // This path used to pass no base at all, so git silently used HEAD.
      const h = harness({ config: { defaultBaseBranch: 'develop' }, branches: ['develop'] });
      h.git.currentBranch.mockReturnValue('AS-1-something');

      await h.service.createWorktree({ branch: 'feat/x' });

      expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, 'develop');
    });

    it('lets an explicit pick from the form win over the default', async () => {
      const h = harness({ config: { defaultBaseBranch: 'develop' }, branches: ['develop', 'main'] });

      await h.service.createWorktree({ branch: 'feat/x', baseBranch: 'main' });

      expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, 'main');
    });

    it('passes undefined (git uses HEAD) when neither the setting nor git resolve a branch', async () => {
      const h = harness({ config: { defaultBaseBranch: '' }, branches: [] });
      h.git.currentBranch.mockReturnValue('');

      await h.service.createWorktree({ branch: 'feat/x' });

      expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, undefined);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider dropdown: choosing the primary, and the not-installed path
// ─────────────────────────────────────────────────────────────────────────────

describe('handleMessage pickDefaultProvider', () => {
  it('offers every registered provider and persists the choice', async () => {
    const h = makeHarness();
    h.host.showQuickPick.mockResolvedValue('grok');

    await h.service.handleMessage({ type: 'pickDefaultProvider' });

    expect(h.host.showQuickPick).toHaveBeenCalledWith(
      ['claude', 'codex', 'grok', 'opencode'],
      { placeHolder: 'Agent launched by the main button' },
    );
    expect(h.config.setDefaultProvider).toHaveBeenCalledWith('grok');
  });

  it('persists nothing when the picker is dismissed', async () => {
    const h = makeHarness();
    h.host.showQuickPick.mockResolvedValue(undefined);

    await h.service.handleMessage({ type: 'pickDefaultProvider' });

    expect(h.config.setDefaultProvider).not.toHaveBeenCalled();
  });
});

describe('handleMessage showProviderInstall', () => {
  it('names the agent and offers to copy a verified install command', async () => {
    const h = makeHarness({ confirmResult: undefined });

    await h.service.handleMessage({ type: 'showProviderInstall', provider: 'codex' });

    expect(h.notify.confirm).toHaveBeenCalledWith(
      'Codex CLI is not on your PATH',
      expect.stringContaining('npm i -g @openai/codex'),
      'Copy command',
    );
  });

  it('copies the command when the user accepts', async () => {
    const h = makeHarness({ confirmResult: 'Copy command' });

    await h.service.handleMessage({ type: 'showProviderInstall', provider: 'grok' });

    expect(h.host.writeClipboard).toHaveBeenCalledWith('npm i -g @xai-official/grok');
  });

  it('copies nothing when the user dismisses', async () => {
    const h = makeHarness({ confirmResult: undefined });

    await h.service.handleMessage({ type: 'showProviderInstall', provider: 'grok' });

    expect(h.host.writeClipboard).not.toHaveBeenCalled();
  });
});

describe('installedProviders in the pushed state', () => {
  it('forwards what the detector reports, so the card can dim the rest', () => {
    const h = makeHarness({ installedProviders: ['claude', 'grok'] });
    expect(h.service.buildState().installedProviders).toEqual(['claude', 'grok']);
  });
});

describe('installedProviders fallback', () => {
  it('uses the real PATH lookup when nothing is injected', () => {
    // Commands that cannot exist, so the answer is the same on every machine.
    const h = makeHarness({
      useRealInstalledProviders: true,
      config: {
        claudeCommand: '/nope/claude', codexCommand: '/nope/codex',
        grokCommand: '/nope/grok', opencodeCommand: '/nope/opencode',
      },
    });
    expect(h.service.buildState().installedProviders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Docker state reaching the sidebar without a window reload
// ─────────────────────────────────────────────────────────────────────────────

describe('docker state refresh', () => {
  const dockerCfg = {
    docker: { composeFile: 'docker-compose.yml', overrideFile: '', ports: ['HTTP_PORT'], basePort: 20000, portStride: 100 },
  };

  it('dockerUp nudges the monitor, because compose runs in a terminal we cannot await', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [b], config: dockerCfg });

    await h.service.handleMessage({ type: 'dockerUp', worktreeId: 'b' });

    expect(h.dockerMonitor.nudge).toHaveBeenCalledWith('feat-b');
  });

  it('dockerDown pushes state, so a stopped stack stops showing as running', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [b], config: dockerCfg });
    h.calls.length = 0;

    await h.service.handleMessage({ type: 'dockerDown', worktreeId: 'b' });

    expect(h.calls).toContain('ui.pushWebview');
  });

  it('dockerDown still pushes state when compose itself failed', async () => {
    const b = makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/feat-b' });
    const h = makeHarness({ worktrees: [b], config: dockerCfg });
    h.dockerMonitor.runCompose.mockRejectedValue(new Error('no such project'));
    h.calls.length = 0;

    await h.service.handleMessage({ type: 'dockerDown', worktreeId: 'b' });

    // Otherwise a failed teardown leaves the badge frozen with no way back.
    expect(h.calls).toContain('ui.pushWebview');
  });
});

describe('deleteWorktree stops every poller', () => {
  it('stops the PR poll, not just docker and the git watcher', async () => {
    // Nothing called prMonitor.stopPolling: each deleted worktree left a
    // `gh pr list` running against a dead branch every 5 minutes until reload.
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], confirmResult: 'Delete' });

    await h.service.deleteWorktree(a);

    expect(h.calls).toContain('pr.stopPolling:a');
    expect(h.calls).toContain('docker.stopPolling:feat-a');
    expect(h.calls).toContain('gitWatcher.unwatch:/repo/zer/feat-a');
  });
});

describe('the ready handshake', () => {
  it('pushes state when the webview says it is listening', async () => {
    // The first push races the bundle load. Without an answer to `ready`, a
    // quiet repo can sit on the loading dots forever: nothing polls.
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    h.calls.length = 0;

    await h.service.handleMessage({ type: 'ready' });

    expect(h.calls).toEqual(['ui.pushWebview']);
  });
});

describe('deleteWorktree when git refuses', () => {
  it('tells the user and leaves the card in place', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], confirmResult: 'Delete' });
    h.manager.delete.mockRejectedValue(new Error('is locked'));

    await h.service.deleteWorktree(a);

    expect(h.notify.showError).toHaveBeenCalledWith(
      expect.stringContaining('still registered with git'),
    );
  });

  it('clears the deleting lock so the worktree stays usable', async () => {
    const a = makeWorktree({ id: 'a' });
    const h = makeHarness({ worktrees: [a], confirmResult: 'Delete' });
    h.manager.delete.mockRejectedValue(new Error('is locked'));

    await h.service.deleteWorktree(a);

    // A failed delete must not leave the card frozen in "deleting" forever.
    expect(h.service.buildState().worktrees[0].deleting).toBe(false);
  });
});

describe('defaultBaseBranch in a repo that does not use it', () => {
  const root = '/repo';
  function harness(o: HarnessOpts = {}) {
    const h = makeHarness({ workspaceFolders: [root], gitDirs: ['/repo/.git'], ...o });
    h.manager.create.mockResolvedValue(makeWorktree({ id: 'new' }));
    return h;
  }

  it('uses the repo\'s own main line when the configured branch is absent', async () => {
    // Shipping "develop" as the default is right for the repo this was written
    // for and wrong for everyone else's. Rather than branch from whatever the
    // checkout happens to be on, ask git which main line the repo actually has.
    const h = harness({ config: { defaultBaseBranch: 'develop' }, branches: ['main'] });
    h.git.mainBranch.mockReturnValue('main');
    h.git.currentBranch.mockReturnValue('some-feature');

    await h.service.createWorktree({ branch: 'feat/x' });

    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, 'main');
  });

  it('works it out when the setting is empty', async () => {
    const h = harness({ config: { defaultBaseBranch: '' }, branches: ['master'] });
    h.git.mainBranch.mockReturnValue('master');

    await h.service.createWorktree({ branch: 'feat/x' });

    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, 'master');
  });

  it('still prefers the configured branch when the repo has it', async () => {
    const h = harness({ config: { defaultBaseBranch: 'develop' }, branches: ['develop', 'main'] });
    h.git.mainBranch.mockReturnValue('main');

    await h.service.createWorktree({ branch: 'feat/x' });

    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, 'develop');
  });

  it('falls back to the current branch in a repo with no main line at all', async () => {
    const h = harness({ config: { defaultBaseBranch: '' }, branches: [] });
    h.git.mainBranch.mockReturnValue(undefined);
    h.git.currentBranch.mockReturnValue('only-branch');

    await h.service.createWorktree({ branch: 'feat/x' });

    expect(h.manager.create).toHaveBeenCalledWith('feat/x', root, undefined, 'only-branch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ports on the card
// ─────────────────────────────────────────────────────────────────────────────

describe('worktree ports', () => {
  const portsCfg = {
    docker: {
      composeFile: 'docker-compose.yml',
      overrideFile: 'docker-compose.worktree.yml',
      ports: ['HTTP_PORT', 'DB_PORT', 'XDEBUG_PORT'],
      basePort: 20000,
      portStride: 100,
    },
  };

  it('are empty when the user has configured none', () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })] });
    expect(h.service.buildState().worktrees[0]?.ports).toEqual([]);
  });

  it('carry the same numbers the compose env is given', () => {
    // Derived, not stored: the card cannot drift from what the container
    // actually publishes, because both come out of one function.
    const a = makeWorktree({ id: 'a', xdebugPort: 9899 });
    const h = makeHarness({ worktrees: [a], config: portsCfg });

    expect(h.service.buildState().worktrees[0]?.ports).toEqual([
      { name: 'HTTP_PORT', port: 20000, openable: true },
      { name: 'DB_PORT', port: 20001, openable: true },
      // Special-cased to the worktree's own debug port, and not a URL.
      { name: 'XDEBUG_PORT', port: 9899, openable: false },
    ]);
  });

  it('move with the worktree when it lands on another slot', () => {
    const a = makeWorktree({ id: 'a', xdebugPort: 9901 });
    const h = makeHarness({ worktrees: [a], config: portsCfg });

    expect(h.service.buildState().worktrees[0]?.ports).toEqual([
      { name: 'HTTP_PORT', port: 20200, openable: true },
      { name: 'DB_PORT', port: 20201, openable: true },
      { name: 'XDEBUG_PORT', port: 9901, openable: false },
    ]);
  });

  it('open on localhost, which is where compose published them', () => {
    const h = makeHarness({ worktrees: [makeWorktree({ id: 'a' })], config: portsCfg });
    void h.service.handleMessage({ type: 'openPort', port: 20200 });
    expect(h.host.openExternal).toHaveBeenCalledWith('http://localhost:20200');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift against the base branch
// ─────────────────────────────────────────────────────────────────────────────

describe('base-branch drift', () => {
  it('watches a worktree against the base it was cut from', async () => {
    // Recorded at creation, so it survives the setting moving on afterwards.
    const a = makeWorktree({ id: 'a', branch: 'feat/a', baseBranch: 'release/3.2' });
    const h = makeHarness({ worktrees: [a], workspaceFolders: ['/repo'] });

    await h.service.loadWorktreesForRepo('/repo');

    expect(h.calls).toContain(`gitWatcher.watch:${a.path}:release/3.2`);
  });

  it('falls back to the configured base for a worktree with no record of one', async () => {
    // Adopted from git, or created before the base was stored.
    const a = makeWorktree({ id: 'a', branch: 'feat/a' });
    const h = makeHarness({
      worktrees: [a],
      workspaceFolders: ['/repo'],
      config: { defaultBaseBranch: 'develop' },
      branches: ['develop'],
    });

    await h.service.loadWorktreesForRepo('/repo');

    expect(h.calls).toContain(`gitWatcher.watch:${a.path}:develop`);
  });

  it('measures nothing for the main worktree', async () => {
    const main = makeWorktree({ id: 'm', path: '/repo', branch: 'develop', isMain: true });
    const h = makeHarness({ worktrees: [main], workspaceFolders: ['/repo'], branches: ['develop'] });

    await h.service.loadWorktreesForRepo('/repo');

    expect(h.calls).toContain('gitWatcher.watch:/repo');
    expect(h.calls).not.toContain('gitWatcher.watch:/repo:develop');
  });

  it('measures nothing for a worktree sitting on the base itself', async () => {
    // A row of zeroes against your own branch is noise, not information.
    const a = makeWorktree({ id: 'a', branch: 'develop', baseBranch: 'develop' });
    const h = makeHarness({ worktrees: [a], workspaceFolders: ['/repo'] });

    await h.service.loadWorktreesForRepo('/repo');

    expect(h.calls).toContain(`gitWatcher.watch:${a.path}`);
    expect(h.calls).not.toContain(`gitWatcher.watch:${a.path}:develop`);
  });

  it('fetches just the base branch and re-reads, on request', async () => {
    const a = makeWorktree({ id: 'a', branch: 'feat/a', baseBranch: 'develop' });
    const h = makeHarness({ worktrees: [a] });

    await h.service.handleMessage({ type: 'refreshDrift', worktreeId: 'a' });

    // One branch from one remote, not the whole thing.
    expect(h.calls).toContain(`git.fetchBranch:${a.path}:origin/develop`);
    expect(h.calls).toContain(`gitWatcher.refreshNow:${a.path}`);
    expect(h.ui.pushWebview).toHaveBeenCalled();
  });

  it('still re-reads when the fetch fails', async () => {
    // No remote, no network, no credentials: the local comparison is still worth
    // redoing, and a toast for a fetch nobody watched would be noise.
    const a = makeWorktree({ id: 'a', branch: 'feat/a', baseBranch: 'develop' });
    const h = makeHarness({ worktrees: [a], fetchFails: true });

    await h.service.handleMessage({ type: 'refreshDrift', worktreeId: 'a' });

    expect(h.calls).toContain(`gitWatcher.refreshNow:${a.path}`);
    expect(h.notify.showError).not.toHaveBeenCalled();
  });

  it('does nothing for a worktree with no base to compare against', async () => {
    const main = makeWorktree({ id: 'm', path: '/repo', branch: 'develop', isMain: true });
    const h = makeHarness({ worktrees: [main] });

    await h.service.handleMessage({ type: 'refreshDrift', worktreeId: 'm' });

    expect(h.git.fetchBranch).not.toHaveBeenCalled();
  });

  it('does nothing for a worktree that no longer exists', async () => {
    const h = makeHarness({ worktrees: [] });
    await h.service.handleMessage({ type: 'refreshDrift', worktreeId: 'gone' });
    expect(h.git.fetchBranch).not.toHaveBeenCalled();
  });
});

