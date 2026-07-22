import * as path from 'node:path';
import type { Worktree } from '../types';
import type { UnmessState, WorktreeItem, WebMessage } from '../webview/types';
import type { WorktreeManager } from '../worktree/WorktreeManager';
import type { AgentSessionManager } from '../session/AgentSessionManager';
import type { TabManager } from '../worktree/TabManager';
import type { BreakpointManager } from '../worktree/BreakpointManager';
import type { ConfigManager } from '../config/ConfigManager';
import type { GitWatcher } from '../git/GitWatcher';
import type { DockerMonitor } from '../docker/DockerMonitor';
import type { PrMonitor } from '../pr/PrMonitor';
import type { IWorktreeRepository } from '../ports/IWorktreeRepository';
import { PROVIDER_IDS, type ProviderId } from '../ports/IAgentProvider';
import { buildComposeArgs, composeProject, dockerEnv } from '../docker/dockerCompose';
import type { IGitPort, DiffBase } from '../ports/IGitPort';
import type { INotifyPort } from '../ports/INotifyPort';
import type { DiffPanelHost } from '../diff/DiffPanelManager';
import type { SendDestination, DiffComment } from '../diff/types';
import { buildCommentPrompt } from '../diff/commentPrompt';

export const ACTIVE_WORKTREE_KEY = 'unmess.activeWorktreeId';

/** A terminal created for setup/teardown scripts (structural subset of vscode.Terminal). */
export interface HostTerminal {
  show(): void;
  sendText(text: string): void;
}

/** All VSCode workspace/window operations the service needs, behind a port. */
export interface IWorkspaceHost {
  workspaceFolderPaths(): string[];
  removeWorkspaceFolder(index: number): void;
  addWorkspaceFolders(...folders: Array<{ path: string; name: string }>): void;
  renameWorkspaceFolder(index: number, folder: { path: string; name: string }): void;
  saveAll(includeUntitled: boolean): Promise<void>;
  moveEditorToFirstInGroup(): Promise<void>;
  createTerminal(options: { name: string; cwd: string }): HostTerminal;
  showInputBox(options: { prompt: string; value?: string; placeHolder?: string }): Promise<string | undefined>;
  showQuickPick(items: string[], options: { placeHolder: string }): Promise<string | undefined>;
  /** Set (or clear with undefined) a folder-scoped setting, e.g. 'search.exclude'. */
  updateFolderSetting(folderPath: string, section: string, value: unknown): Promise<void>;
  activeTerminal(): unknown;
  exists(p: string): boolean;
  isDirectory(p: string): boolean;
  writeClipboard(text: string): Promise<void>;
  /** Open a file in the editor, optionally revealing a 1-based line. */
  openFileInEditor(absPath: string, line?: number): Promise<void>;
}

/** Bridge to the VSCode UI surfaces (webview + explorer dimming). */
export interface UiBridge {
  pushWebview(): void;
  /** Refresh the explorer dimming for the given worktree list + active worktree. */
  syncDecorations(worktrees: Worktree[], activeWorktreeId: string | undefined): void;
  /** Open (or reveal) the diff-review panel for a worktree. */
  openDiffPanel(worktreeId: string): void;
}

interface GlobalStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): unknown;
}

export interface WorktreeAppDeps {
  manager: WorktreeManager;
  agentManager: AgentSessionManager;
  tabManager: TabManager;
  breakpointManager: BreakpointManager;
  store: IWorktreeRepository;
  config: ConfigManager;
  notify: INotifyPort;
  host: IWorkspaceHost;
  git: IGitPort;
  gitWatcher: GitWatcher;
  dockerMonitor: DockerMonitor;
  prMonitor: PrMonitor;
  globalState: GlobalStateLike;
}

const NO_UI: UiBridge = { pushWebview() {}, syncDecorations() {}, openDiffPanel() {} };

/** One strategy per webview message type; exhaustive over the WebMessage union. */
type MessageHandlers = {
  [K in WebMessage['type']]: (msg: Extract<WebMessage, { type: K }>) => void | Promise<void>;
};

/**
 * All worktree/session business logic, decoupled from VSCode. Every UI-facing
 * operation goes through injected ports (host, notify, ui bridge) so the whole
 * class is unit-testable with plain object doubles.
 */
export class WorktreeApplicationService implements DiffPanelHost {
  private currentWorktreeId?: string;
  private ui: UiBridge = NO_UI;
  /** Worktrees currently tearing down in the background — locked against interaction. */
  private deleting = new Set<string>();

  constructor(private readonly deps: WorktreeAppDeps) {
    this.currentWorktreeId = deps.globalState.get<string>(ACTIVE_WORKTREE_KEY);
  }

  setUi(ui: UiBridge): void {
    this.ui = ui;
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** Push the current worktree list + active worktree to the explorer dimming. */
  private refreshDecorations(): void {
    this.ui.syncDecorations(this.deps.manager.list(), this.currentWorktreeId);
  }

  private findWorktree(worktreeId: string): Worktree | undefined {
    return this.deps.manager.list().find((w) => w.id === worktreeId);
  }

  /** Command-palette invocations arrive without a tree item — fall back to the first stored worktree. */
  private resolveWorktree(worktree?: Worktree): Worktree | undefined {
    return worktree ?? this.deps.store.getAll()[0];
  }

  /**
   * Run a setup/teardown script in a visible host terminal registered to the
   * worktree. The script path is resolved against the repo (worktree-first,
   * then main), and the script gets UNMESS_* env plus the worktree's docker
   * ports so it can prepare deps and bring the stack up without guessing.
   */
  private runScriptTerminal(wt: Worktree, script: string, labelPrefix: string, doneMessage?: string): void {
    const config = this.deps.config.get();
    const resolved =
      this.locateRepoFile(wt, script) ?? (path.isAbsolute(script) ? script : path.join(wt.repoRoot, script));
    const env: Record<string, string> = {
      UNMESS_REPO_ROOT: wt.repoRoot,
      UNMESS_WORKTREE_PATH: wt.path,
      UNMESS_BRANCH: wt.branch,
      UNMESS_COMPOSE_PROJECT: composeProject(wt),
      ...(config.docker.ports.length > 0 ? dockerEnv(wt, config) : {}),
    };
    const prefix = Object.entries(env).map(([k, v]) => `${k}="${v}"`).join(' ');
    const terminal = this.deps.host.createTerminal({ name: `${labelPrefix}: ${wt.alias ?? wt.branch}`, cwd: wt.path });
    this.deps.agentManager.register(wt.id, terminal as never);
    terminal.show();
    const cmd = `${prefix} bash "${resolved}"`;
    terminal.sendText(doneMessage ? `${cmd} && echo "✓ ${doneMessage}"` : cmd);
  }

  /**
   * Resolve a repo-relative file, preferring the worktree's own copy (when its
   * branch carries `.unmess/`) and falling back to the main repo — where
   * `.unmess/` lives when the branch predates it. Returns undefined if neither
   * has it.
   */
  private locateRepoFile(wt: Worktree, file: string): string | undefined {
    if (path.isAbsolute(file)) return this.deps.host.exists(file) ? file : undefined;
    const inWorktree = path.join(wt.path, file);
    if (this.deps.host.exists(inWorktree)) return inWorktree;
    const inRoot = path.join(wt.repoRoot, file);
    return this.deps.host.exists(inRoot) ? inRoot : undefined;
  }

  private dockerComposePaths(wt: Worktree): { composePath: string; overridePath?: string } {
    const { composeFile, overrideFile } = this.deps.config.get().docker;
    // Default to the main-repo path even if missing, so docker errors visibly.
    const composePath = this.locateRepoFile(wt, composeFile) ?? path.join(wt.repoRoot, composeFile);
    const overridePath =
      overrideFile && overrideFile !== composeFile ? this.locateRepoFile(wt, overrideFile) : undefined;
    return { composePath, overridePath };
  }

  /**
   * Bring a worktree's docker stack up in a visible terminal (so the user sees
   * pull/build progress), with the auto-generated per-worktree ports injected.
   * Runs from the worktree dir so ${PWD} in the compose points at the worktree.
   */
  private dockerUp(wt: Worktree): void {
    const config = this.deps.config.get();
    const { composePath, overridePath } = this.dockerComposePaths(wt);
    const args = buildComposeArgs(wt, composePath, overridePath, 'up -d');
    const prefix = Object.entries(dockerEnv(wt, config)).map(([k, v]) => `${k}=${v}`).join(' ');
    const terminal = this.deps.host.createTerminal({ name: `Docker: ${wt.alias ?? wt.branch}`, cwd: wt.path });
    terminal.show();
    terminal.sendText(`${prefix ? prefix + ' ' : ''}docker compose ${args}`);
  }

  /** Bring a worktree's docker stack down silently, then refresh the monitor. */
  private async dockerDown(wt: Worktree): Promise<void> {
    const config = this.deps.config.get();
    const { composePath, overridePath } = this.dockerComposePaths(wt);
    const args = buildComposeArgs(wt, composePath, overridePath, 'down');
    const env = { ...dockerEnv(wt, config), PWD: wt.path };
    await this.deps.dockerMonitor.runCompose(composeProject(wt), wt.path, args, env).catch(() => {});
  }

  // ── Webview message dispatch ───────────────────────────────────────────────

  /**
   * One handler per message type — the mapped type forces exhaustiveness, so
   * adding a WebMessage variant without a handler is a compile error.
   * dropImage / pickImage are handled by the provider (macOS AppleScript glue).
   */
  private readonly messageHandlers: MessageHandlers = {
    launchAgent: (msg) => {
      const wt = this.findWorktree(msg.worktreeId);
      if (wt) this.deps.agentManager.launch(wt, { provider: msg.provider });
    },
    pickAgent: async (msg) => {
      const wt = this.findWorktree(msg.worktreeId);
      if (!wt) return;
      const choice = await this.deps.host.showQuickPick([...PROVIDER_IDS], { placeHolder: 'Launch agent' });
      if (choice) void this.deps.agentManager.launch(wt, { provider: choice as ProviderId });
    },
    openTerminal: (msg) => {
      const wt = this.findWorktree(msg.worktreeId);
      if (wt) this.deps.agentManager.openTerminal(wt);
    },
    focusTerminal: async (msg) => {
      await this.switchToWorktree(msg.worktreeId);
      const wt = this.findWorktree(msg.worktreeId);
      if (wt) this.deps.agentManager.getOrCreateViewer(wt).then((v) => v.show()).catch(() => {});
    },
    focusSession: async (msg) => {
      await this.switchToWorktree(msg.worktreeId);
      const wt = this.findWorktree(msg.worktreeId);
      if (wt) this.deps.agentManager.focusWindow(wt, msg.index).catch(() => {});
    },
    killSession: async (msg) => {
      const sessions = this.deps.agentManager.getSessions(msg.worktreeId);
      const session = sessions.find((s) => s.index === msg.index);
      const label = session?.kind === 'agent' ? `${session.provider ?? 'agent'} session` : 'terminal';
      const confirm = await this.deps.notify.confirm(
        `Kill ${label}?`,
        'The running process will be terminated. This cannot be undone.',
        'Kill',
      );
      if (confirm === 'Kill') this.deps.agentManager.killWindow(msg.worktreeId, msg.index).catch(() => {});
    },
    dockerUp: (msg) => {
      const wt = this.findWorktree(msg.worktreeId);
      if (wt) this.dockerUp(wt);
    },
    dockerDown: (msg) => {
      const wt = this.findWorktree(msg.worktreeId);
      if (wt) void this.dockerDown(wt);
    },
    deleteWorktree: (msg) => this.deleteWorktree(this.findWorktree(msg.worktreeId)),
    renameWorktree: (msg) => this.renameWorktree(this.findWorktree(msg.worktreeId)),
    initWorktree: (msg) => this.initWorktree(this.findWorktree(msg.worktreeId)),
    openDiff: (msg) => this.ui.openDiffPanel(msg.worktreeId),
    createWorktree: (msg) => this.createWorktree({ branch: msg.branch, title: msg.title, description: msg.description }),
    selectWorktree: (msg) => this.switchToWorktree(msg.worktreeId),
  };

  async handleMessage(msg: WebMessage): Promise<void> {
    // Ignore any action targeting a worktree that is tearing down.
    if ('worktreeId' in msg && this.deleting.has(msg.worktreeId)) return;
    const handler = this.messageHandlers[msg.type] as
      | ((m: WebMessage) => void | Promise<void>)
      | undefined;
    if (handler) await handler(msg);
  }

  // ── Worktree switch orchestration ──────────────────────────────────────────

  async switchToWorktree(worktreeId: string): Promise<void> {
    if (this.currentWorktreeId === worktreeId) return;
    const worktrees = this.deps.manager.list();
    const target = worktrees.find((w) => w.id === worktreeId);
    if (!target) return;

    console.log(`[unmess] switch to id=${worktreeId} path=${target.path} exists=${this.deps.host.exists(target.path)}`);
    this.currentWorktreeId = worktreeId;
    this.deps.globalState.update(ACTIVE_WORKTREE_KEY, worktreeId);
    // Push eagerly — the terminal-change event that normally syncs the webview
    // never fires for a worktree with no sessions to show.
    this.ui.pushWebview();

    const viewerOpenIds = new Set(
      worktrees.filter((wt) => this.deps.agentManager.getViewer(wt.id) !== undefined).map((wt) => wt.id),
    );
    this.deps.tabManager.updateViewerState(worktrees, viewerOpenIds);
    // Scope the Breakpoints panel to the target worktree, like the tabs above.
    this.deps.breakpointManager.activate(worktreeId, worktrees);

    await this.deps.host.saveAll(false);

    await Promise.all(
      worktrees.filter((wt) => wt.id !== worktreeId).map((wt) => this.deps.agentManager.closeViewer(wt.id)),
    );

    const viewer = this.deps.agentManager.hasTerminals(target.id)
      ? await this.deps.agentManager.getOrCreateViewer(target).catch(() => undefined)
      : undefined;
    viewer?.show();

    await this.deps.tabManager.closeOtherTabs(worktreeId, worktrees);
    this.deps.tabManager
      .restoreTabs(worktreeId)
      .then(async () => {
        if (!viewer) return;
        // Defer past the current microtask so the switch resolves first, then
        // re-show and pin the terminal tab to the front of the group.
        await this.delay(0);
        viewer.show();
        await this.delay(50);
        await this.deps.host.moveEditorToFirstInGroup();
      })
      .catch(() => {});

    this.refreshDecorations();
    this.syncSearchScoping();
  }

  // ── Selection sync ─────────────────────────────────────────────────────────

  handleActiveTerminalChange(terminal: unknown): void {
    if (!terminal) return;
    for (const wt of this.deps.manager.list()) {
      if (this.deps.agentManager.getViewer(wt.id) === terminal) {
        if (this.currentWorktreeId !== wt.id) {
          this.currentWorktreeId = wt.id;
          this.deps.globalState.update(ACTIVE_WORKTREE_KEY, wt.id);
          this.ui.pushWebview();
          this.refreshDecorations();
          this.syncSearchScoping();
        }
        break;
      }
    }
  }

  // ── State projection ───────────────────────────────────────────────────────

  buildState(): UnmessState {
    const worktrees = this.deps.manager.list();
    const items: WorktreeItem[] = worktrees.map((wt) => ({
      id: wt.id,
      branch: wt.branch,
      alias: wt.alias,
      path: wt.path,
      isMain: wt.isMain ?? false,
      deleting: this.deleting.has(wt.id),
      agent: this.deps.agentManager.getState(wt.id),
      agentCount: this.deps.agentManager.getAgentCount(wt.id),
      terminalCount: this.deps.agentManager.getShellCount(wt.id),
      sessions: this.deps.agentManager.getSessions(wt.id),
      git: this.deps.gitWatcher.getStatus(wt.path),
      docker: this.deps.dockerMonitor.getContainers(composeProject(wt)).map((c) => ({ name: c.name, state: c.state })),
      pr: this.deps.prMonitor.getStatus(wt.id) ?? null,
    }));
    const activeWorktreeId = worktrees.find((wt) => wt.id === this.currentWorktreeId)?.id;
    const config = this.deps.config.get();
    return {
      worktrees: items,
      activeWorktreeId,
      defaultProvider: config.defaultProvider,
      dockerEnabled: config.docker.ports.length > 0,
    };
  }

  // ── Diff review panel (DiffPanelHost) ──────────────────────────────────────

  getDiff(worktreeId: string, base: DiffBase): Promise<string> {
    const wt = this.findWorktree(worktreeId);
    if (!wt) return Promise.resolve('');
    return this.deps.git.diff(wt.path, { base });
  }

  getContext(worktreeId: string): { label: string; hasLiveAgent: boolean } | undefined {
    const wt = this.findWorktree(worktreeId);
    if (!wt) return undefined;
    return {
      label: wt.alias ?? wt.branch,
      hasLiveAgent: this.deps.agentManager.getAgentCount(wt.id) > 0,
    };
  }

  /** Turn review comments into a prompt and route it to the chosen destination. */
  async send(worktreeId: string, destination: SendDestination, comments: DiffComment[]): Promise<boolean> {
    const wt = this.findWorktree(worktreeId);
    if (!wt) return false;
    const prompt = buildCommentPrompt(comments);
    if (!prompt) return false;

    if (destination === 'clipboard') {
      await this.deps.host.writeClipboard(prompt);
      return true;
    }
    if (destination === 'live') {
      return this.deps.agentManager.sendPromptToAgent(wt, prompt);
    }
    // 'new' — launch a fresh agent seeded with the comments.
    await this.deps.agentManager.launchWithPrompt(wt, prompt);
    return true;
  }

  /** Open a diff file (path relative to the worktree) in the editor. */
  async openFile(worktreeId: string, relativePath: string, line?: number): Promise<void> {
    const wt = this.findWorktree(worktreeId);
    if (!wt) return;
    await this.deps.host.openFileInEditor(path.join(wt.path, relativePath), line);
  }

  // ── Repo discovery + activation ────────────────────────────────────────────

  findRepoRoot(folders: string[] = this.deps.host.workspaceFolderPaths()): string | undefined {
    for (const f of folders) {
      if (this.deps.host.isDirectory(path.join(f, '.git'))) return f;
    }
    return undefined;
  }

  async start(): Promise<void> {
    const root = this.findRepoRoot();
    if (root) await this.loadWorktreesForRepo(root);
  }

  async handleAddedWorkspaceFolders(paths: string[]): Promise<void> {
    for (const p of paths) {
      const gitDir = path.join(p, '.git');
      if (this.deps.host.exists(gitDir) && this.deps.host.isDirectory(gitDir)) {
        await this.loadWorktreesForRepo(p);
        break; // one repo at a time
      }
    }
    // Worktree folders register asynchronously after addWorkspaceFolders —
    // folder-scoped settings can only be written once the folder exists, so
    // re-apply the scoping whenever folders actually land in the workspace.
    this.syncSearchScoping();
  }

  /**
   * Folder-scoped search.exclude: every folder except the active one is hidden
   * from text search and Quick Open, so results come only from the folder the
   * user is working in (the main repo when no worktree is selected). This is
   * pure config — no language-server re-indexing; search is evaluated on demand.
   */
  private syncSearchScoping(): void {
    const enabled = this.deps.config.get().scopeSearchToActiveWorktree;
    const worktrees = this.deps.manager.list();
    // With no worktree selected, keep the main repo searchable as the fallback.
    const activeId = this.currentWorktreeId ?? worktrees.find((w) => w.isMain)?.id;
    for (const wt of worktrees) {
      const exclude = enabled && wt.id !== activeId ? { '**': true } : undefined;
      void this.deps.host.updateFolderSetting(wt.path, 'search.exclude', exclude).catch(() => {});
    }
  }

  async loadWorktreesForRepo(repoRoot: string): Promise<void> {
    const { current } = await this.deps.manager.reconcile(repoRoot);

    const validPaths = new Set([repoRoot, ...current.map((w) => w.path)]);
    const indicesToRemove = this.deps.host
      .workspaceFolderPaths()
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !validPaths.has(p))
      .map(({ i }) => i)
      .sort((a, b) => b - a);
    for (const idx of indicesToRemove) this.deps.host.removeWorkspaceFolder(idx);

    const existing = this.deps.host.workspaceFolderPaths();
    const toAdd = current.filter((wt) => !existing.some((p) => p === wt.path));
    if (toAdd.length > 0) {
      this.deps.host.addWorkspaceFolders(...toAdd.map((wt) => ({ path: wt.path, name: wt.alias ?? wt.branch })));
    }

    for (const wt of current) {
      this.deps.gitWatcher.watch(wt.path);
      this.deps.dockerMonitor.startPolling(composeProject(wt), () => this.ui.pushWebview());
      this.deps.prMonitor.startPolling(wt.branch, wt.id, () => this.ui.pushWebview());
    }

    await this.deps.agentManager.reconnect(current);
    this.ui.pushWebview();
    this.refreshDecorations();
    this.syncSearchScoping();
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async createWorktree(opts?: { branch?: string; title?: string; description?: string }): Promise<void> {
    const root = this.findRepoRoot();
    if (!root) {
      this.deps.notify.showError('No git repository found in workspace.');
      return;
    }
    const branch = opts?.branch ?? (await this.deps.host.showInputBox({
      prompt: 'Branch name',
      placeHolder: 'e.g. AS-7090-fix-payments',
    }));
    if (!branch) return;

    let createdWt: Worktree | undefined;
    try {
      createdWt = await this.deps.notify.withProgress(`Creating worktree "${branch}"`, async (report) => {
        report('Running git worktree add...');
        // Title → worktree alias; description stays as Claude's initial prompt.
        const wt = await this.deps.manager.create(branch, root, opts?.title?.trim() || undefined);

        report('Adding to workspace...');
        this.deps.host.addWorkspaceFolders({ path: wt.path, name: wt.alias ?? wt.branch });

        this.deps.gitWatcher.watch(wt.path);
        this.deps.dockerMonitor.startPolling(composeProject(wt), () => { /* no auto-refresh during create */ });
        this.deps.prMonitor.startPolling(wt.branch, wt.id, () => this.ui.pushWebview());
        this.ui.pushWebview();

        const setupScript = this.deps.config.get().setupScript;
        if (setupScript) {
          report('Running setup script...');
          this.runScriptTerminal(wt, setupScript, 'Init', 'Setup complete');
        }

        return wt;
      });
      this.ui.pushWebview();
      this.refreshDecorations();
    } catch (e) {
      this.deps.notify.showError(`Failed to create worktree: ${String(e)}`);
      return;
    }

    // Launch Claude after the progress notification closes so VSCode has settled
    // the workspace-folder update before we open a new terminal.
    if (createdWt) {
      const wt = createdWt;
      const description = opts?.description;
      setTimeout(() => {
        if (description) this.deps.agentManager.launchWithPrompt(wt, description);
        else this.deps.agentManager.launch(wt);
      }, 300);
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteWorktree(worktree?: Worktree): Promise<void> {
    const wt = this.resolveWorktree(worktree);
    if (!wt) return;
    if (this.deleting.has(wt.id)) return; // already tearing down

    const repoRoot = this.findRepoRoot();
    const pathExists = this.deps.host.exists(wt.path);
    const isActuallyMain = pathExists && !!repoRoot && path.normalize(wt.path) === path.normalize(repoRoot);
    if (isActuallyMain) {
      let isTrulyMain = true;
      try {
        const actualBranch = this.deps.git.currentBranch(wt.path);
        isTrulyMain = !actualBranch || actualBranch === wt.branch;
      } catch { /* git failed — assume main */ }
      if (isTrulyMain) {
        this.deps.notify.showWarning('Cannot delete the main worktree.');
        return;
      }
      // Stale store entry pointing at repoRoot with a mismatched branch — remove
      // from the store only. manager.delete swallows the git error.
      await this.deps.manager.delete(wt.id, false);
      this.ui.pushWebview();
      this.refreshDecorations();
      return;
    }

    const confirm = await this.deps.notify.confirm(
      `Delete worktree "${wt.branch}"?`,
      undefined,
      'Delete',
      'Delete + branch',
    );
    if (!confirm) return;

    // Lock the worktree and hand control straight back to the user — the actual
    // teardown (docker down, session kill, git remove) runs without blocking, and
    // the card renders as "deleting" until it finishes.
    this.deleting.add(wt.id);
    this.ui.pushWebview();

    try {
      this.deps.gitWatcher.unwatch(wt.path);
      this.deps.dockerMonitor.stopPolling(composeProject(wt));

      const teardownScript = this.deps.config.get().teardownScript;
      if (teardownScript && this.deps.host.exists(wt.path)) {
        this.runScriptTerminal(wt, teardownScript, 'Teardown', 'Teardown complete');
        await this.delay(2000);
      }

      await this.deps.agentManager.killWorktreeSession(wt.id);
      const folderIdx = this.deps.host.workspaceFolderPaths().findIndex((p) => p === wt.path);
      if (folderIdx !== -1) this.deps.host.removeWorkspaceFolder(folderIdx);
      await this.deps.manager.delete(wt.id, confirm === 'Delete + branch');
    } finally {
      this.deleting.delete(wt.id);
      this.ui.pushWebview();
      this.refreshDecorations();
    }
  }

  // ── Rename ─────────────────────────────────────────────────────────────────

  async renameWorktree(worktree?: Worktree): Promise<void> {
    const wt = this.resolveWorktree(worktree);
    if (!wt) return;

    const alias = await this.deps.host.showInputBox({
      prompt: 'Description / alias for this worktree',
      value: wt.alias ?? wt.branch,
      placeHolder: 'e.g. Fix rate-limit bug on Shopify',
    });
    if (alias === undefined) return;

    const finalAlias = alias || wt.branch;
    await this.deps.store.setAlias(wt.id, finalAlias);

    const idx = this.deps.host.workspaceFolderPaths().findIndex((p) => p === wt.path);
    if (idx !== -1) this.deps.host.renameWorkspaceFolder(idx, { path: wt.path, name: finalAlias });

    this.ui.pushWebview();
  }

  // ── Command helpers (item?.worktree ?? store[0] fallback) ──────────────────

  initWorktree(worktree?: Worktree): void {
    const wt = this.resolveWorktree(worktree);
    if (!wt) return;
    const setupScript = this.deps.config.get().setupScript;
    if (!setupScript) {
      this.deps.notify.showError('No setup script configured. Set "unmess.setupScript" in settings.');
      return;
    }
    this.runScriptTerminal(wt, setupScript, 'Init');
  }

  openTerminal(worktree?: Worktree): void {
    const wt = this.resolveWorktree(worktree);
    if (wt) this.deps.agentManager.openTerminal(wt);
  }

  launchAgent(worktree?: Worktree, provider?: ProviderId): void {
    const wt = this.resolveWorktree(worktree);
    if (wt) this.deps.agentManager.launch(wt, { provider });
  }

  // ── Cyclic navigation ──────────────────────────────────────────────────────

  focusNextWorktree(): void {
    this.cycleWorktree(1);
  }

  focusPrevWorktree(): void {
    this.cycleWorktree(-1);
  }

  private cycleWorktree(direction: 1 | -1): void {
    const worktrees = this.deps.manager.list();
    if (!worktrees.length) return;
    const active = this.deps.host.activeTerminal();
    let idx = -1;
    for (let i = 0; i < worktrees.length; i++) {
      if (this.deps.agentManager.getViewer(worktrees[i].id) === active) {
        idx = i;
        break;
      }
    }
    const n = worktrees.length;
    const nextIdx = (((idx + direction) % n) + n) % n;
    this.deps.agentManager.getViewer(worktrees[nextIdx].id)?.show();
  }
}
