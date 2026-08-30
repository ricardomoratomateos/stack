import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { WorktreeStore } from './worktree/WorktreeStore';
import { WorktreeManager } from './worktree/WorktreeManager';
import { PortAllocator } from './worktree/portAllocator';
import { ConfigManager } from './config/ConfigManager';
import { REPO_CONFIG_RELATIVE, readRepoConfig, renderRepoConfig, type RepoScopedKey } from './config/RepoConfig';
import { AgentSessionManager } from './session/AgentSessionManager';
import { AttentionNotifier } from './session/AttentionNotifier';
import { ProviderFactory } from './providers/ProviderFactory';
import { DockerMonitor } from './docker/DockerMonitor';
import { GitWatcher } from './git/GitWatcher';
import { HookServer } from './server/HookServer';
import { ForemanWebviewProvider } from './sidebar/ForemanWebviewProvider';
import { PrMonitor } from './pr/PrMonitor';
import { TmuxManager } from './session/TmuxManager';
import { WorktreeDimDecorationProvider } from './sidebar/WorktreeDimDecorationProvider';
import { TerminalFileLinkProvider } from './terminal/TerminalFileLinkProvider';
import { ImageDropCatcher } from './terminal/ImageDropCatcher';
import { looksLikeScreenshot } from './terminal/imageDrop';
import { GitCliAdapter } from './adapters/GitCliAdapter';
import { OsaNotifyAdapter } from './adapters/OsaNotifyAdapter';
import { VsCodeNotifyAdapter } from './adapters/VsCodeNotifyAdapter';
import { TabManager } from './worktree/TabManager';
import { BreakpointManager } from './worktree/BreakpointManager';
import { WorktreeApplicationService, IWorkspaceHost, HostTerminal } from './application/WorktreeApplicationService';
import { DiffPanelManager } from './diff/DiffPanelManager';
import { NewTaskPanelManager } from './newtask/NewTaskPanelManager';
import { SettingsPanelManager } from './settings/SettingsPanelManager';
import { detect, type DetectIo } from './settings/detect';
import { SCRIPT_TEMPLATES } from './settings/scriptTemplates';
import { installedProviders } from './providers/commandLookup';
import { SIDEBAR_VIEW_ID } from './constants';
import { PACKAGE_MANAGERS, tmuxInstallCommand } from './onboarding/tmuxGate';
import { TmuxGateView } from './onboarding/TmuxGateView';
import { findRepoRoot } from './worktree/findRepoRoot';
import { worktreesInRepo } from './worktree/worktreesInRepo';

/**
 * Surfaces a broken `.foreman/config.json` with a way to go fix it.
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
    `Foreman: ${REPO_CONFIG_RELATIVE} — ${head}${rest}`,
    ...(file ? ['Open file'] : []),
  );
  if (action === 'Open file' && file) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  }
}

/**
 * Writes `.foreman/config.json` from whatever is in effect right now.
 *
 * The point of the command is the handover: the person who made Foreman work
 * here has the answers in their own settings.json, and everyone who clones the
 * repo afterwards has none of them. This lifts them into a file that travels
 * with the code.
 */
async function createRepoConfig(config: ConfigManager, root: string | undefined): Promise<void> {
  if (!root) {
    vscode.window.showWarningMessage('Foreman: open a git repository first.');
    return;
  }
  const file = path.join(root, REPO_CONFIG_RELATIVE);
  if (fs.existsSync(file)) {
    // Never silently overwritten: this file is committed and shared, so the
    // copy on disk may well be a teammate's work rather than a stale draft.
    const overwrite = await vscode.window.showWarningMessage(
      `Foreman: ${REPO_CONFIG_RELATIVE} already exists.`,
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
    `Foreman: wrote ${REPO_CONFIG_RELATIVE}. Commit it and your team gets the same setup.`,
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
      vscode.window.showWarningMessage(`Foreman: could not open ${absPath}`);
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
    // Hides the settings gear in the view header (its menu `when` clause): the
    // command behind it is only registered once the extension really runs.
    void vscode.commands.executeCommand('setContext', 'foreman.tmuxMissing', true);
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, new TmuxGateView(install)),
    );
    return;
  }
  void vscode.commands.executeCommand('setContext', 'foreman.tmuxMissing', false);
  // Ticks the walkthrough's first step; the gate above never sets it.
  void vscode.commands.executeCommand('setContext', 'foreman.tmuxReady', true);

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

  // Clickable file paths in foreman terminals — resolves the relative paths
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

  const webviewProvider = new ForemanWebviewProvider(ctx.extensionUri, agentManager, gitWatcher, service);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Settings panel: the project half round-trips through `.foreman/config.json`
  // (written here, read back through the same validator the extension uses, so
  // the panel reports exactly what the extension would), the personal half
  // through VS Code's own settings at global scope.
  const REPO_KEYS: RepoScopedKey[] = [
    'worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'teardownScript', 'docker', 'debugBasePort', 'debugTemplate',
  ];
  const detectIo: DetectIo = {
    readdir: (dir) => fs.readdirSync(dir),
    exists: (p) => fs.existsSync(p),
    read: (p) => fs.readFileSync(p, 'utf8'),
  };
  const relativeToRepo = (root: string | undefined, abs: string) =>
    root && abs.startsWith(root + path.sep) ? path.relative(root, abs) : abs;
  const settingsPanel = new SettingsPanelManager(ctx.extensionUri, {
    snapshot: () => {
      const root = repoRootOf();
      const effective = config.get();
      const cfg = vscode.workspace.getConfiguration('foreman');
      const repoFile = readRepoConfig(root);
      return {
        repoRoot: root,
        project: {
          worktreesDirectory: effective.worktreesDirectory,
          defaultBaseBranch: effective.defaultBaseBranch,
          setupScript: effective.setupScript,
          teardownScript: effective.teardownScript,
          docker: effective.docker,
          debugBasePort: effective.debugBasePort,
          debugTemplate: effective.debugTemplate,
        },
        projectFile: { path: config.repoConfigPath(), present: repoFile.present, problems: repoFile.problems },
        personalOverrides: REPO_KEYS.filter((key) => {
          const seen = cfg.inspect(key);
          return seen?.globalValue !== undefined || seen?.workspaceValue !== undefined || seen?.workspaceFolderValue !== undefined;
        }),
        user: {
          defaultProvider: effective.defaultProvider,
          claudeCommand: effective.claudeCommand,
          codexCommand: effective.codexCommand,
          grokCommand: effective.grokCommand,
          opencodeCommand: effective.opencodeCommand,
          notifyOnAttention: effective.notifyOnAttention,
          focusMode: effective.focusMode,
          scopeSearchToActiveWorktree: effective.scopeSearchToActiveWorktree,
        },
        installedProviders: installedProviders(effective),
        branches: root ? git.listBranches(root) : [],
        detected: root ? detect(root, detectIo) : { composeFiles: [], portVars: [] },
      };
    },
    pickFile: async (field) => {
      const root = repoRootOf();
      const isCompose = field === 'composeFile' || field === 'overrideFile';
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFolders: false,
        defaultUri: root ? vscode.Uri.file(root) : undefined,
        openLabel: 'Use this file',
        filters: isCompose
          ? { 'Compose files': ['yml', 'yaml'] }
          : { Scripts: ['sh', 'bash', 'zsh', 'js', 'ts', 'py'], 'All files': ['*'] },
      });
      const abs = picked?.[0]?.fsPath;
      return abs ? relativeToRepo(root, abs) : undefined;
    },
    createScript: async (kind) => {
      const root = repoRootOf();
      if (!root) throw new Error('Open a git repository first.');
      const rel = path.join('.foreman', `${kind}.sh`);
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, SCRIPT_TEMPLATES[kind], { mode: 0o755 });
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(abs), {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
      return rel;
    },
    saveProject: async (values) => {
      const root = repoRootOf();
      if (!root) return ['Open a git repository first.'];
      const file = path.join(root, REPO_CONFIG_RELATIVE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderRepoConfig({ ...config.get(), ...values }));
      webviewProvider.push();
      return readRepoConfig(root).problems;
    },
    saveUser: async (values) => {
      const cfg = vscode.workspace.getConfiguration('foreman');
      for (const [key, value] of Object.entries(values)) {
        await cfg.update(key, value, vscode.ConfigurationTarget.Global);
      }
      webviewProvider.push();
    },
    clearPersonalOverrides: async () => {
      const cfg = vscode.workspace.getConfiguration('foreman');
      for (const key of REPO_KEYS) {
        await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
        // Workspace scope only exists inside a workspace; elsewhere the update throws.
        await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace).then(undefined, () => {});
      }
      webviewProvider.push();
    },
    openProjectFile: async () => {
      const file = config.repoConfigPath();
      if (file && fs.existsSync(file)) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
      }
    },
  });
  ctx.subscriptions.push(settingsPanel);

  // Dropping a screenshot on an agent's terminal: VS Code opens it as a tab in
  // that group; this hands it to the agent in that group instead.
  // Resolved once, up front: the check must stay synchronous so the tab can be
  // closed in the same tick it appears (see ImageDropCatcher).
  let shotsDir: string | undefined;
  void screenshotDir().then((dir) => { shotsDir = dir; });
  ctx.subscriptions.push(new ImageDropCatcher({
    worktreeIdForTerminalName: (name) => agentManager.getWorktreeIdForTerminalName(name),
    hasTerminals: (id) => agentManager.hasTerminals(id),
    labelFor: (id) => { const wt = manager.list().find((w) => w.id === id); return wt ? wt.alias ?? wt.branch : undefined; },
    activeWorktreeId: () => service.activeWorktreeId(),
    isScreenshotLike: (file) => {
      let mtimeMs: number | undefined;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return false; }
      return looksLikeScreenshot({ file, mtimeMs, nowMs: Date.now(), screenshotDir: shotsDir });
    },
    attach: (id, paths) => service.attachDroppedFiles(paths, id),
    notify: (message, reopen) => {
      void vscode.window.showInformationMessage(message, 'Open instead').then((pick) => { if (pick === 'Open instead') reopen(); });
    },
  }));

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
    vscode.commands.registerCommand('foreman.createWorktree', (opts?: { branch?: string; description?: string }) =>
      service.createWorktree(opts),
    ),
    // The "+" in the view header: opens the webview's rich new-task modal
    // (title, branch, base branch, description) rather than a bare input box.
    vscode.commands.registerCommand('foreman.newTask', () => newTaskPanel.open()),
    vscode.commands.registerCommand('foreman.openSettings', () => settingsPanel.open()),
    vscode.commands.registerCommand('foreman.gettingStarted', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'foreman.foreman#foreman.gettingStarted', false),
    ),
    vscode.commands.registerCommand('foreman.createRepoConfig', () => createRepoConfig(config, repoRootOf())),
    vscode.commands.registerCommand('foreman.deleteWorktree', (item) => service.deleteWorktree(item?.worktree)),
    vscode.commands.registerCommand('foreman.renameWorktree', (item) => service.renameWorktree(item?.worktree)),
    vscode.commands.registerCommand('foreman.initWorktree', (item) => service.initWorktree(item?.worktree)),
    vscode.commands.registerCommand('foreman.openTerminal', (item) => service.openTerminal(item?.worktree)),
    vscode.commands.registerCommand('foreman.launchAgent', (item) => service.launchAgent(item?.worktree)),
    vscode.commands.registerCommand('foreman.focusNextWorktree', () => service.focusNextWorktree()),
    vscode.commands.registerCommand('foreman.focusPrevWorktree', () => service.focusPrevWorktree()),
    vscode.commands.registerCommand('foreman.focusSession', (terminal: vscode.Terminal | undefined) => terminal?.show()),
    vscode.commands.registerCommand('foreman.attachLatestScreenshot', async () => {
      const term = vscode.window.activeTerminal;
      const worktreeId = term ? agentManager.getWorktreeIdForTerminal(term) : undefined;
      if (!worktreeId) {
        vscode.window.showWarningMessage('Foreman: focus an agent terminal first, then attach the screenshot.');
        return;
      }
      const shot = await findLatestScreenshot();
      if (!shot) {
        vscode.window.showWarningMessage('Foreman: no screenshot found in your screenshot folder.');
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
    vscode.window.showErrorMessage(`Foreman failed to load worktrees: ${String(e)}`);
  });

  // Greet an empty editor with the New agent panel — the same spirit as the
  // sidebar's empty state, but keyed on open tabs rather than worktrees so it
  // never shoves a real tab aside. `onStartupFinished` runs after VSCode has
  // restored the previous session's tabs, so an empty editor here means the user
  // genuinely has nothing open. Gated on a git repo: there's nothing to create a
  // worktree in otherwise.
  const noTabsOpen = vscode.window.tabGroups.all.every((g) => g.tabs.length === 0);
  if (repoRootOf() && noTabsOpen) newTaskPanel.open();

  // First look at a repository that could use the heavier setup — a compose
  // file, or a PHP stack that wants Xdebug — offer the settings panel once.
  // Then never again for this repo: it lives behind the gear from here on, and
  // a repo that already has `.foreman/config.json` was set up by someone.
  void (async () => {
    const root = repoRootOf();
    if (!root) return;
    const key = `foreman.setupNudged:${root}`;
    if (ctx.globalState.get<boolean>(key)) return;
    if (readRepoConfig(root).present) { await ctx.globalState.update(key, true); return; }
    const found = detect(root, detectIo);
    if (found.composeFiles.length === 0 && found.stack !== 'php') return;
    await ctx.globalState.update(key, true);
    const what = found.composeFiles.length > 0 ? `\`${found.composeFiles[0]}\`` : 'a PHP stack';
    const pick = await vscode.window.showInformationMessage(
      `Foreman: this repo has ${what}. Set up a Docker stack and debugger per worktree?`,
      'Open settings',
      'Not now',
    );
    if (pick === 'Open settings') settingsPanel.open();
  })();
}

export function deactivate() {}
