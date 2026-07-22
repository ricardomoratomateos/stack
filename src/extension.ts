import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { exec } from 'node:child_process';
import { WorktreeStore } from './worktree/WorktreeStore';
import { WorktreeManager } from './worktree/WorktreeManager';
import { PortAllocator } from './worktree/portAllocator';
import { ConfigManager } from './config/ConfigManager';
import { AgentSessionManager } from './session/AgentSessionManager';
import { AttentionNotifier } from './session/AttentionNotifier';
import { ProviderFactory } from './providers/ProviderFactory';
import { DockerMonitor } from './docker/DockerMonitor';
import { GitWatcher } from './git/GitWatcher';
import { HookServer } from './server/HookServer';
import { UnmessWebviewProvider } from './sidebar/UnmessWebviewProvider';
import { PrMonitor } from './pr/PrMonitor';
import { TmuxManager } from './session/TmuxManager';
import { WorktreeDimDecorationProvider } from './sidebar/WorktreeDimDecorationProvider';
import { TerminalFileLinkProvider } from './terminal/TerminalFileLinkProvider';
import { GitCliAdapter } from './adapters/GitCliAdapter';
import { OsaNotifyAdapter } from './adapters/OsaNotifyAdapter';
import { VsCodeNotifyAdapter } from './adapters/VsCodeNotifyAdapter';
import { TabManager } from './worktree/TabManager';
import { BreakpointManager } from './worktree/BreakpointManager';
import { WorktreeApplicationService, IWorkspaceHost, HostTerminal } from './application/WorktreeApplicationService';
import { DiffPanelManager } from './diff/DiffPanelManager';
import { SIDEBAR_VIEW_ID } from './constants';
import { PACKAGE_MANAGERS, promptTmuxInstall } from './onboarding/tmuxGate';

/** Resolve which of the given binaries are on PATH (via `which`). */
function detectBinaries(bins: readonly string[]): Promise<Set<string>> {
  const present = new Set<string>();
  return Promise.all(
    bins.map((bin) => new Promise<void>((res) => exec(`which ${bin}`, (err) => {
      if (!err) present.add(bin);
      res();
    }))),
  ).then(() => present);
}

/** IWorkspaceHost implemented over the live VSCode workspace/window APIs. */
class VsCodeWorkspaceHost implements IWorkspaceHost {
  workspaceFolderPaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }
  removeWorkspaceFolder(index: number): void {
    vscode.workspace.updateWorkspaceFolders(index, 1);
  }
  addWorkspaceFolders(...folders: Array<{ path: string; name: string }>): void {
    vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length ?? 0,
      0,
      ...folders.map((f) => ({ uri: vscode.Uri.file(f.path), name: f.name })),
    );
  }
  renameWorkspaceFolder(index: number, folder: { path: string; name: string }): void {
    vscode.workspace.updateWorkspaceFolders(index, 1, { uri: vscode.Uri.file(folder.path), name: folder.name });
  }
  async saveAll(includeUntitled: boolean): Promise<void> {
    await vscode.workspace.saveAll(includeUntitled);
  }
  async moveEditorToFirstInGroup(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.moveEditorToFirstInGroup');
  }
  createTerminal(options: { name: string; cwd: string }): HostTerminal {
    return vscode.window.createTerminal({ name: options.name, cwd: options.cwd });
  }
  showInputBox(options: { prompt: string; value?: string; placeHolder?: string }): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showInputBox(options));
  }
  showQuickPick(items: string[], options: { placeHolder: string }): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showQuickPick(items, options));
  }
  async updateFolderSetting(folderPath: string, section: string, value: unknown): Promise<void> {
    const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.fsPath === folderPath);
    if (!folder) return; // folder not (yet) in the workspace — re-applied on the next folders-changed event
    const dot = section.lastIndexOf('.');
    const config = vscode.workspace.getConfiguration(section.slice(0, dot), folder.uri);
    await config.update(section.slice(dot + 1), value, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  activeTerminal(): unknown {
    return vscode.window.activeTerminal;
  }
  exists(p: string): boolean {
    return fs.existsSync(p);
  }
  isDirectory(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }
  async writeClipboard(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
  }
  async openFileInEditor(absPath: string, line?: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(absPath);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line !== undefined) {
        const pos = new vscode.Position(Math.max(line - 1, 0), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch {
      vscode.window.showWarningMessage(`Unmess: could not open ${absPath}`);
    }
  }
}

export async function activate(ctx: vscode.ExtensionContext) {
  // Tmux is required for terminal session management — it's how agents survive
  // window reloads and get multiplexed per worktree. Without it there's nothing
  // meaningful to run, so we hard-gate: prompt the user to install it and abort
  // activation. Once installed, a window reload re-enters here with tmux present.
  if (!(await TmuxManager.isAvailable())) {
    const present = await detectBinaries(PACKAGE_MANAGERS);
    void promptTmuxInstall(process.platform, (bin) => present.has(bin));
    return;
  }

  const config = new ConfigManager();
  const store = new WorktreeStore(ctx);
  const portAllocator = new PortAllocator(store, config.get().xdebugBasePort);
  const providerFactory = new ProviderFactory(config, ctx.globalStorageUri.fsPath);
  const agentManager = new AgentSessionManager(providerFactory, ctx.globalState);
  const dockerMonitor = new DockerMonitor();
  const gitWatcher = new GitWatcher();
  const git = new GitCliAdapter();

  const hookServer = new HookServer(agentManager);
  const hookUrl = await hookServer.start();

  const manager = new WorktreeManager(store, portAllocator, config, agentManager);

  for (const provider of providerFactory.all()) provider.installHooks(hookUrl);

  const prMonitor = new PrMonitor();

  // Clickable file paths in unmess terminals — resolves the relative paths
  // Claude prints (src/foo.ts:12) against the terminal's worktree.
  const fileLinkProvider = new TerminalFileLinkProvider({
    resolveBase: (terminal) => {
      const worktreeId = agentManager.getWorktreeIdForTerminal(terminal);
      if (worktreeId) return manager.list().find((w) => w.id === worktreeId)?.path;
      const cwd = (terminal.creationOptions as vscode.TerminalOptions).cwd;
      return typeof cwd === 'string' ? cwd : cwd?.fsPath;
    },
    exists: (p) => fs.existsSync(p),
    open: async (absPath, line, column) => {
      const doc = await vscode.workspace.openTextDocument(absPath);
      const editor = await vscode.window.showTextDocument(doc);
      if (line !== undefined) {
        const pos = new vscode.Position(Math.max(line - 1, 0), Math.max((column ?? 1) - 1, 0));
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    },
  });
  ctx.subscriptions.push(vscode.window.registerTerminalLinkProvider(fileLinkProvider));

  // Dims non-active worktrees in the file explorer so the active one stands out.
  const dimProvider = new WorktreeDimDecorationProvider();
  ctx.subscriptions.push(vscode.window.registerFileDecorationProvider(dimProvider));

  const tabManager = new TabManager(ctx.globalState, () => manager.list());
  const breakpointManager = new BreakpointManager(ctx.globalState, () => manager.list());

  const service = new WorktreeApplicationService({
    manager,
    agentManager,
    tabManager,
    breakpointManager,
    store,
    config,
    notify: new VsCodeNotifyAdapter(),
    host: new VsCodeWorkspaceHost(),
    git,
    gitWatcher,
    dockerMonitor,
    prMonitor,
    globalState: ctx.globalState,
  });

  const diffPanelManager = new DiffPanelManager(ctx.extensionUri, service);

  const webviewProvider = new UnmessWebviewProvider(ctx.extensionUri, agentManager, gitWatcher, service);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // "The agent needs you": sidebar badge always; native OS notification only
  // when VSCode is in the background (inside the window the badge suffices).
  const osaNotify = new OsaNotifyAdapter();
  const attention = new AttentionNotifier({
    onStateChange: agentManager.onStateChange,
    labelFor: (id) => {
      const wt = manager.list().find((w) => w.id === id);
      return wt ? wt.alias ?? wt.branch : undefined;
    },
    sessionTitle: (id, index) => agentManager.getSessions(id).find((s) => s.index === index)?.title,
    isWatching: (id) =>
      vscode.window.state.focused &&
      vscode.window.activeTerminal !== undefined &&
      agentManager.getWorktreeIdForTerminal(vscode.window.activeTerminal) === id,
    enabled: () => config.get().notifyOnAttention,
    notify: (message) => {
      if (!vscode.window.state.focused) osaNotify.notify(message);
    },
  });
  attention.onAttentionChange((count) => webviewProvider.setBadge(count));
  // Clear a session's badge as soon as the user is looking at it — either by
  // switching to its terminal, or by refocusing the window while its terminal
  // is already active (the common "I answered right here" case that no
  // terminal-change event would otherwise catch).
  const acknowledgeActiveTerminal = () => {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) return;
    const id = agentManager.getWorktreeIdForTerminal(terminal);
    if (id) attention.acknowledge(id);
  };
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;
      const id = agentManager.getWorktreeIdForTerminal(terminal);
      if (id) attention.acknowledge(id);
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) acknowledgeActiveTerminal();
    }),
  );

  service.setUi({
    pushWebview: () => webviewProvider.push(),
    syncDecorations: (worktrees, activeWorktreeId) => dimProvider.update(worktrees, activeWorktreeId),
    openDiffPanel: (worktreeId) => diffPanelManager.open(worktreeId),
  });

  // React when the user opens a folder — load its worktrees if it's a git repo.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) =>
      service.handleAddedWorkspaceFolders(e.added.map((f) => f.uri.fsPath)),
    ),
  );

  // Commands.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('unmess.createWorktree', (opts?: { branch?: string; description?: string }) =>
      service.createWorktree(opts),
    ),
    vscode.commands.registerCommand('unmess.deleteWorktree', (item) => service.deleteWorktree(item?.worktree)),
    vscode.commands.registerCommand('unmess.renameWorktree', (item) => service.renameWorktree(item?.worktree)),
    vscode.commands.registerCommand('unmess.initWorktree', (item) => service.initWorktree(item?.worktree)),
    vscode.commands.registerCommand('unmess.openTerminal', (item) => service.openTerminal(item?.worktree)),
    vscode.commands.registerCommand('unmess.launchAgent', (item) => service.launchAgent(item?.worktree)),
    vscode.commands.registerCommand('unmess.focusNextWorktree', () => service.focusNextWorktree()),
    vscode.commands.registerCommand('unmess.focusPrevWorktree', () => service.focusPrevWorktree()),
    vscode.commands.registerCommand('unmess.focusSession', (terminal: vscode.Terminal | undefined) => terminal?.show()),
  );

  ctx.subscriptions.push({
    dispose: () => {
      attention.dispose();
      agentManager.dispose();
      gitWatcher.dispose();
      dockerMonitor.dispose();
      hookServer.dispose();
      prMonitor.dispose();
      dimProvider.dispose();
      diffPanelManager.dispose();
      for (const provider of providerFactory.all()) provider.uninstallHooks();
    },
  });

  // Load worktrees if a repo is already open (e.g. reload window). Fire-and-forget
  // so activation never blocks — the webview renders immediately and folder
  // mutations (which may reload the window) happen after activate() resolves.
  void service.start().catch((e) => {
    vscode.window.showErrorMessage(`Unmess failed to load worktrees: ${String(e)}`);
  });
}

export function deactivate() {}
