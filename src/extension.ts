import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { WorktreeStore } from './worktree/WorktreeStore';
import { WorktreeManager } from './worktree/WorktreeManager';
import { PortAllocator } from './worktree/portAllocator';
import { ConfigManager } from './config/ConfigManager';
import { REPO_CONFIG_RELATIVE, renderRepoConfig } from './config/RepoConfig';
import { AgentSessionManager } from './session/AgentSessionManager';
import { AttentionNotifier } from './session/AttentionNotifier';
import { ProviderFactory } from './providers/ProviderFactory';
import { DockerMonitor } from './docker/DockerMonitor';
import { GitWatcher } from './git/GitWatcher';
import { HookServer } from './server/HookServer';
import { UnmessWebviewProvider } from './sidebar/UnmessWebviewProvider';
import { ScreenshotDropZone, DROP_ZONE_VIEW_ID } from './sidebar/ScreenshotDropZone';
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
import { NewTaskPanelManager } from './newtask/NewTaskPanelManager';
import { SIDEBAR_VIEW_ID } from './constants';
import { PACKAGE_MANAGERS, tmuxInstallCommand } from './onboarding/tmuxGate';
import { TmuxGateView } from './onboarding/TmuxGateView';
import { findRepoRoot } from './worktree/findRepoRoot';
import { worktreesInRepo } from './worktree/worktreesInRepo';

/**
 * Surfaces a broken `.unmess/config.json` with a way to go fix it.
 *
 * A warning rather than an error, and never a modal: whatever is wrong, the
 * extension is already running on the user's own settings, so this is news the
 * user needs rather than a wall to climb over.
 */
async function reportRepoConfigProblems(config: ConfigManager, problems: string[]): Promise<void> {
  const file = config.repoConfigPath();
  const head = problems[0] ?? '';
  const rest = problems.length > 1 ? ` (+${problems.length - 1} more)` : '';
  const action = await vscode.window.showWarningMessage(
    `Unmess: ${REPO_CONFIG_RELATIVE} — ${head}${rest}`,
    ...(file ? ['Open file'] : []),
  );
  if (action === 'Open file' && file) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  }
}

/**
 * Writes `.unmess/config.json` from whatever is in effect right now.
 *
 * The point of the command is the handover: the person who made Unmess work
 * here has the answers in their own settings.json, and everyone who clones the
 * repo afterwards has none of them. This lifts them into a file that travels
 * with the code.
 */
async function createRepoConfig(config: ConfigManager, root: string | undefined): Promise<void> {
  if (!root) {
    vscode.window.showWarningMessage('Unmess: open a git repository first.');
    return;
  }
  const file = path.join(root, REPO_CONFIG_RELATIVE);
  if (fs.existsSync(file)) {
    // Never silently overwritten: this file is committed and shared, so the
    // copy on disk may well be a teammate's work rather than a stale draft.
    const overwrite = await vscode.window.showWarningMessage(
      `Unmess: ${REPO_CONFIG_RELATIVE} already exists.`,
      'Open it',
      'Overwrite',
    );
    if (overwrite === 'Open it') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
      return;
    }
    if (overwrite !== 'Overwrite') return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderRepoConfig(config.get()));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  vscode.window.showInformationMessage(
    `Unmess: wrote ${REPO_CONFIG_RELATIVE}. Commit it and your team gets the same setup.`,
  );
}

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

/** The folder macOS saves screenshots to (custom location, else ~/Desktop). */
function screenshotDir(): Promise<string> {
  return new Promise((resolve) => {
    exec('defaults read com.apple.screencapture location', (err, stdout) => {
      const loc = !err && stdout.trim() ? stdout.trim() : path.join(os.homedir(), 'Desktop');
      resolve(loc.replace(/^~(?=\/|$)/, os.homedir()));
    });
  });
}

/** Absolute path of the most-recently-modified image in the screenshot folder. */
async function findLatestScreenshot(): Promise<string | undefined> {
  const dir = await screenshotDir();
  let entries: string[];
  try { entries = await fs.promises.readdir(dir); } catch { return undefined; }
  const images = entries.filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => path.join(dir, f));
  let latest: string | undefined;
  let latestMs = 0;
  for (const f of images) {
    try {
      const ms = (await fs.promises.stat(f)).mtimeMs;
      if (ms > latestMs) { latestMs = ms; latest = f; }
    } catch { /* skip unreadable */ }
  }
  return latest;
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
  workspaceFolderName(path: string): string | undefined {
    return (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.fsPath === path)?.name;
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
  async openExternal(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
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
  // meaningful to run, so we hard-gate and abort the rest of activation. Rather
  // than leave the panel spinning on an empty shell behind a toast that's easy to
  // miss, we register a gate view that states the requirement and installs tmux in
  // one click. Once installed, a window reload re-enters here with tmux present.
  if (!(await TmuxManager.isAvailable())) {
    const present = await detectBinaries(PACKAGE_MANAGERS);
    const install = tmuxInstallCommand(process.platform, (bin) => present.has(bin));
    // Hides the screenshot drop-zone view (its `when` clause), which is useless
    // until the extension is really running and otherwise renders a bare
    // "no data provider registered" placeholder.
    void vscode.commands.executeCommand('setContext', 'unmess.tmuxMissing', true);
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, new TmuxGateView(install)),
    );
    return;
  }
  void vscode.commands.executeCommand('setContext', 'unmess.tmuxMissing', false);

  // Resolved per read, not captured: the user can add or remove the folder that
  // holds the repository at any point in a window's life.
  const repoRootOf = () =>
    findRepoRoot(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    );

  const config = new ConfigManager({
    repoRoot: repoRootOf,
    onProblems: (problems) => void reportRepoConfigProblems(config, problems),
  });
  const store = new WorktreeStore(ctx);
  // The config getter lets the allocator probe the whole derived docker block,
  // not just the debug port, before handing a slot out.
  const portAllocator = new PortAllocator(store, config.get().debugBasePort, {
    config: () => config.get(),
  });
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

  // Scoped to this window's repository, like everything else that answers
  // "what is in front of the user". Both managers attribute an open file to a
  // worktree by path prefix, so handing them the global store let a file opened
  // in another project's worktree be saved under that worktree's id — in a
  // window that does not manage it, into state its own window then restores.
  const worktreesHere = () => worktreesInRepo(manager.list(), repoRootOf());

  const tabManager = new TabManager(ctx.globalState, worktreesHere);
  const breakpointManager = new BreakpointManager(ctx.globalState, worktreesHere);

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

  const newTaskPanel = new NewTaskPanelManager(ctx.extensionUri, {
    branchOptions: () => service.newTaskBranchOptions(),
    createWorktree: (opts) => service.createWorktree(opts),
  });
  ctx.subscriptions.push(newTaskPanel);

  const webviewProvider = new UnmessWebviewProvider(ctx.extensionUri, agentManager, gitWatcher, service);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // OS-file drop target. The sidebar webview can't receive OS drags (sandboxed
  // iframe) and the editor-area viewer terminal lets VS Code's editor
  // drop-target open the file instead — a tree view with a drag-and-drop
  // controller declaring `text/uri-list` + `files` is the sidebar surface the
  // workbench routes external file drops to.
  const dropZone = new ScreenshotDropZone({
    targetLabel: () => service.activeWorktreeLabel(),
    attach: (paths) => service.attachDroppedFiles(paths),
    saveTempFile: async (name, data) => {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unmess-drop-'));
      const file = path.join(dir, name || 'dropped-image.png');
      await fs.promises.writeFile(file, data);
      return file;
    },
    warn: (message) => void vscode.window.showWarningMessage(message),
  });
  ctx.subscriptions.push(
    vscode.window.createTreeView(DROP_ZONE_VIEW_ID, {
      treeDataProvider: dropZone,
      dragAndDropController: dropZone,
    }),
    dropZone,
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
    pushWebview: () => {
      webviewProvider.push();
      dropZone.refresh(); // keep the "→ target" hint in sync with the active worktree
    },
    syncDecorations: (worktrees, activeWorktreeId) => dimProvider.update(worktrees, activeWorktreeId),
    openDiffPanel: (worktreeId) => diffPanelManager.open(worktreeId),
    openNewTask: () => newTaskPanel.open(),
  });

  // React when the user opens a folder — load its worktrees if it's a git repo.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      void service.handleAddedWorkspaceFolders(e.added.map((f) => f.uri.fsPath));
      // Folders have actually registered by the time this fires, so the main
      // repo's folder can now be relabelled to its branch (the async add in
      // loadWorktreesForRepo still reads a count of 1 and can't).
      service.syncMainFolderLabel();
    }),
  );

  // Commands.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('unmess.createWorktree', (opts?: { branch?: string; description?: string }) =>
      service.createWorktree(opts),
    ),
    // The "+" in the view header: opens the webview's rich new-task modal
    // (title, branch, base branch, description) rather than a bare input box.
    vscode.commands.registerCommand('unmess.newTask', () => newTaskPanel.open()),
    vscode.commands.registerCommand('unmess.createRepoConfig', () => createRepoConfig(config, repoRootOf())),
    vscode.commands.registerCommand('unmess.deleteWorktree', (item) => service.deleteWorktree(item?.worktree)),
    vscode.commands.registerCommand('unmess.renameWorktree', (item) => service.renameWorktree(item?.worktree)),
    vscode.commands.registerCommand('unmess.initWorktree', (item) => service.initWorktree(item?.worktree)),
    vscode.commands.registerCommand('unmess.openTerminal', (item) => service.openTerminal(item?.worktree)),
    vscode.commands.registerCommand('unmess.launchAgent', (item) => service.launchAgent(item?.worktree)),
    vscode.commands.registerCommand('unmess.focusNextWorktree', () => service.focusNextWorktree()),
    vscode.commands.registerCommand('unmess.focusPrevWorktree', () => service.focusPrevWorktree()),
    vscode.commands.registerCommand('unmess.focusSession', (terminal: vscode.Terminal | undefined) => terminal?.show()),
    vscode.commands.registerCommand('unmess.attachLatestScreenshot', async () => {
      const term = vscode.window.activeTerminal;
      const worktreeId = term ? agentManager.getWorktreeIdForTerminal(term) : undefined;
      if (!worktreeId) {
        vscode.window.showWarningMessage('Unmess: focus an agent terminal first, then attach the screenshot.');
        return;
      }
      const shot = await findLatestScreenshot();
      if (!shot) {
        vscode.window.showWarningMessage('Unmess: no screenshot found in your screenshot folder.');
        return;
      }
      // Paste the path single-quoted (as a terminal file-drop does), unsent, so
      // the agent picks up the image and you can still add prompt text.
      await agentManager.pasteToActiveWindow(worktreeId, `'${shot}' `);
    }),
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

  // Greet an empty editor with the New agent panel — the same spirit as the
  // sidebar's empty state, but keyed on open tabs rather than worktrees so it
  // never shoves a real tab aside. `onStartupFinished` runs after VSCode has
  // restored the previous session's tabs, so an empty editor here means the user
  // genuinely has nothing open. Gated on a git repo: there's nothing to create a
  // worktree in otherwise.
  const noTabsOpen = vscode.window.tabGroups.all.every((g) => g.tabs.length === 0);
  if (repoRootOf() && noTabsOpen) newTaskPanel.open();
}

export function deactivate() {}
