import * as path from 'node:path';
import type { UnmessConfig, Worktree } from '../types';
import type { UnmessState, WorktreeItem, WebMessage, PortMapping } from '../webview/types';
import type { WorktreeManager } from '../worktree/WorktreeManager';
import type { AgentSessionManager } from '../session/AgentSessionManager';
import type { TabManager } from '../worktree/TabManager';
import type { BreakpointManager } from '../worktree/BreakpointManager';
import type { ConfigManager } from '../config/ConfigManager';
import type { GitWatcher } from '../git/GitWatcher';
import type { DockerMonitor } from '../docker/DockerMonitor';
import type { PrMonitor } from '../pr/PrMonitor';
import type { IWorktreeRepository } from '../ports/IWorktreeRepository';
import { PROVIDER_IDS, PROVIDER_INSTALL, type ProviderId } from '../ports/IAgentProvider';
import { installedProviders } from '../providers/commandLookup';
import { buildComposeArgs, composeProject, computeDockerPorts, dockerEnv, portBlockFor } from '../docker/dockerCompose';
import type { IGitPort, DiffBase } from '../ports/IGitPort';
import type { INotifyPort } from '../ports/INotifyPort';
import type { DiffPanelHost } from '../diff/DiffPanelManager';
import type { SendDestination, DiffComment } from '../diff/types';
import { buildCommentPrompt } from '../diff/commentPrompt';
import { displayLabel, truncateLabel } from '../worktree/displayLabel';
import { findRepoRoot } from '../worktree/findRepoRoot';

export const ACTIVE_WORKTREE_KEY = 'unmess.activeWorktreeId';
export const WORKTREE_ORDER_KEY = 'unmess.worktreeOrder';

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
  /** Hand a URL to the OS (the browser, for a worktree's own http port). */
  openExternal(url: string): Promise<void>;
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
  /**
   * Which agents are runnable on this machine. Injected so tests do not depend
   * on whatever the developer happens to have on their PATH.
   */
  installedProviders?: (config: UnmessConfig) => ProviderId[];
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
  /**
   * Branch list for the "create worktree" form. Filled on demand (the webview
   * asks when the modal opens) rather than in buildState — that runs on every
   * agent state change and must not shell out to git.
   */
  private branchOptions?: { branches: string[]; base: string };

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

  /**
   * Resolve the worktree a command acts on. Invoked from the command palette
   * there is no argument, so this falls back to the ACTIVE worktree — falling
   * back to the first in the store (as this used to) meant "Init worktree" could
   * run a heavy setup script against a worktree the user was not even looking at.
   */
  private resolveWorktree(worktree?: Worktree): Worktree | undefined {
    if (worktree) return worktree;
    const all = this.deps.store.getAll();
    return all.find((w) => w.id === this.currentWorktreeId) ?? all[0];
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
    const terminal = this.deps.host.createTerminal({ name: `${labelPrefix}: ${displayLabel(wt)}`, cwd: wt.path });
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
  private async dockerUp(worktree: Worktree): Promise<void> {
    const wt = await this.ensurePortsFree(worktree);
    const config = this.deps.config.get();
    const { composePath, overridePath } = this.dockerComposePaths(wt);
    const args = buildComposeArgs(wt, composePath, overridePath, 'up -d');
    const prefix = Object.entries(dockerEnv(wt, config)).map(([k, v]) => `${k}=${v}`).join(' ');
    const terminal = this.deps.host.createTerminal({ name: `Docker: ${displayLabel(wt)}`, cwd: wt.path });
    terminal.show();
    terminal.sendText(`${prefix ? prefix + ' ' : ''}docker compose ${args}`);
    // `up -d` returns in seconds but runs in the terminal, so nothing tells us
    // when it landed — watch the project closely for a moment instead.
    this.deps.dockerMonitor.nudge(composeProject(wt));
  }

  /**
   * Move a worktree off ports that got taken since they were allocated, before
   * spending minutes on a setup script that would only fail at the very end
   * with docker's "port is already allocated". Deliberately not applied to
   * teardown, which must address the stack on the ports it actually came up on.
   */
  private async ensurePortsFree(wt: Worktree): Promise<Worktree> {
    let moved: { worktree: Worktree; movedFrom?: number };
    try {
      moved = await this.deps.manager.ensureFreePorts(wt);
    } catch (e) {
      // No free slot at all, or the store rejected the patch. Carry on with the
      // ports we have and let docker report the collision itself.
      console.error('[unmess] port re-check failed; keeping the current ports:', e);
      return wt;
    }
    if (moved.movedFrom !== undefined) {
      const ports = portBlockFor(moved.worktree.xdebugPort, this.deps.config.get()).join(', ');
      this.deps.notify.showWarning(
        `Port ${moved.movedFrom} is already in use — "${displayLabel(moved.worktree)}" moved to ${ports}.`,
      );
      this.ui.pushWebview();
    }
    return moved.worktree;
  }

  /** Bring a worktree's docker stack down silently, then refresh the monitor. */
  private async dockerDown(wt: Worktree): Promise<void> {
    const config = this.deps.config.get();
    const { composePath, overridePath } = this.dockerComposePaths(wt);
    const args = buildComposeArgs(wt, composePath, overridePath, 'down');
    const env = { ...dockerEnv(wt, config), PWD: wt.path };
    await this.deps.dockerMonitor.runCompose(composeProject(wt), wt.path, args, env).catch(() => {});
    // runCompose refreshes the cache; without this the fresh cache never
    // reached the sidebar, so a stopped stack still showed as running.
    this.ui.pushWebview();
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
      if (wt) {
        this.deps.agentManager.launch(wt, { provider: msg.provider })
          .catch((e) => this.deps.notify.showError(`Failed to launch agent: ${String(e)}`));
      }
    },
    ready: () => {
      // The first push happens in the same synchronous turn that sets the
      // webview HTML, long before the bundle has loaded and registered its
      // message listener — so it can be dropped on the floor. Nothing polls,
      // every later push is reactive to an event, and the webview shows its
      // loading dots until a message arrives: on a quiet repo it would spin
      // forever. So the webview says when it is listening, and we answer.
      this.ui.pushWebview();
    },
    pickDefaultProvider: async () => {
      // A QuickPick is right here and wrong in the card's dropdown: this changes
      // a setting, which is a rare, deliberate act, not a per-launch choice.
      const choice = await this.deps.host.showQuickPick([...PROVIDER_IDS], {
        placeHolder: 'Agent launched by the main button',
      });
      if (choice) await this.deps.config.setDefaultProvider(choice as ProviderId);
    },
    showProviderInstall: async (msg) => {
      const { label, install } = PROVIDER_INSTALL[msg.provider];
      const copy = await this.deps.notify.confirm(
        `${label} is not on your PATH`,
        `Install it with:\n\n${install}`,
        'Copy command',
      );
      if (copy === 'Copy command') await this.deps.host.writeClipboard(install);
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
      if (wt) void this.dockerUp(wt);
    },
    dockerDown: (msg) => {
      const wt = this.findWorktree(msg.worktreeId);
      if (wt) void this.dockerDown(wt);
    },
    reorderSessions: (msg) => {
      this.deps.agentManager.setSessionOrder(msg.worktreeId, msg.orderedIndexes);
      this.ui.pushWebview();
    },
    reorderWorktrees: (msg) => {
      this.deps.globalState.update(WORKTREE_ORDER_KEY, msg.orderedIds);
      this.ui.pushWebview();
    },
    deleteWorktree: (msg) => this.deleteWorktree(this.findWorktree(msg.worktreeId)),
    renameWorktree: (msg) => this.renameWorktree(this.findWorktree(msg.worktreeId)),
    initWorktree: (msg) => this.initWorktree(this.findWorktree(msg.worktreeId)),
    openDiff: (msg) => this.ui.openDiffPanel(msg.worktreeId),
    createWorktree: (msg) => this.createWorktree({
      branch: msg.branch, title: msg.title, description: msg.description, baseBranch: msg.baseBranch,
    }),
    listBranches: () => {
      const root = this.findRepoRoot();
      if (!root) return;
      this.branchOptions = { branches: this.deps.git.listBranches(root), base: this.resolveBaseBranch(root) };
      this.ui.pushWebview();
    },
    openPort: (msg) => void this.openPort(msg.port),
    refreshDrift: (msg) => void this.refreshDrift(msg.worktreeId),
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

  // ── External file drops (screenshot drop zone) ─────────────────────────────

  /** Display label of the worktree that receives drops (drop-zone hint). */
  activeWorktreeLabel(): string | undefined {
    const wt = this.currentWorktreeId ? this.findWorktree(this.currentWorktreeId) : undefined;
    return wt ? displayLabel(wt) : undefined;
  }

  /**
   * Route externally-dropped files (macOS screenshot thumbnail → drop-zone
   * tree) to the active worktree's agent: reveal its viewer and paste the
   * quoted paths unsent, so the user can add prompt text before hitting Enter.
   */
  async attachDroppedFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const worktrees = this.deps.manager.list();
    const wt =
      this.findWorktree(this.currentWorktreeId ?? '') ?? (worktrees.length === 1 ? worktrees[0] : undefined);
    if (!wt) {
      this.deps.notify.showWarning('Unmess: select a worktree first, then drop the image again.');
      return;
    }
    if (!this.deps.agentManager.hasTerminals(wt.id)) {
      this.deps.notify.showWarning(
        `Unmess: no agent session in ${wt.alias ?? wt.branch} — launch one, then drop the image again.`,
      );
      return;
    }
    await this.switchToWorktree(wt.id);
    const viewer = await this.deps.agentManager.getOrCreateViewer(wt).catch(() => undefined);
    viewer?.show();
    // Single-quoted, like a native terminal file-drop — paths contain spaces.
    await this.deps.agentManager.pasteToActiveWindow(wt.id, paths.map((p) => `'${p}' `).join(''));
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

    // Scope the Breakpoints panel to the target worktree.
    this.deps.breakpointManager.activate(worktreeId, worktrees);

    if (this.deps.config.get().focusMode) {
      await this.switchWithFocusMode(target, worktrees);
    } else {
      await this.revealWorktree(target);
    }

    this.refreshDecorations();
    this.syncSearchScoping();
  }

  /**
   * Default switch: reveal, never rebuild. Nothing is closed, so there is no
   * flicker, no terminal respawn, and VSCode keeps every tab exactly where the
   * user left it (the editor API can neither hide nor reorder tabs, so the only
   * way to keep tab order stable is to never touch it).
   */
  private async revealWorktree(target: Worktree): Promise<void> {
    // Reveal the worktree's session terminal and nothing else. Deliberately no
    // file is opened here: doing both made the terminal and the editor fight for
    // the foreground, so you saw the file appear and then get shoved aside.
    // Restoring a worktree's files is what focusMode is for.
    if (!this.deps.agentManager.hasTerminals(target.id)) return;
    const viewer = await this.deps.agentManager.getOrCreateViewer(target).catch(() => undefined);
    viewer?.show();
  }

  /** Clean-slate switch (unmess.focusMode): only the active worktree on screen. */
  private async switchWithFocusMode(target: Worktree, worktrees: Worktree[]): Promise<void> {
    const viewerOpenIds = new Set(
      worktrees.filter((wt) => this.deps.agentManager.getViewer(wt.id) !== undefined).map((wt) => wt.id),
    );
    this.deps.tabManager.updateViewerState(worktrees, viewerOpenIds);

    // Tabs are about to be closed — flush unsaved work first.
    await this.deps.host.saveAll(false);

    await Promise.all(
      worktrees.filter((wt) => wt.id !== target.id).map((wt) => this.deps.agentManager.closeViewer(wt.id)),
    );

    const viewer = this.deps.agentManager.hasTerminals(target.id)
      ? await this.deps.agentManager.getOrCreateViewer(target).catch(() => undefined)
      : undefined;
    viewer?.show();

    await this.deps.tabManager.closeOtherTabs(target.id, worktrees);
    this.deps.tabManager
      .restoreTabs(target.id)
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

  /** Apply the user-chosen display order (main worktree always pinned first). */
  private orderWorktrees(worktrees: Worktree[]): Worktree[] {
    const order = this.deps.globalState.get<string[]>(WORKTREE_ORDER_KEY) ?? [];
    // [main-first, saved-rank] — sort by main flag, then by saved display order
    // (windows missing from the order fall to the end).
    const key = (w: Worktree): [number, number] => {
      const p = order.indexOf(w.id);
      return [(w.isMain ?? false) ? 0 : 1, p === -1 ? Number.MAX_SAFE_INTEGER : p];
    };
    return [...worktrees].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1];
    });
  }

  /**
   * Branch this worktree's drift should be measured against, if any.
   *
   * The one recorded at creation wins: a worktree cut from release/3.2 stays
   * measured against release/3.2 however the setting moves afterwards. Older
   * worktrees and ones adopted from git have no record, so they fall back to the
   * configured base — right in the common case and honest about being a guess,
   * since the card names the ref it compared.
   *
   * Nothing for the main worktree, and nothing for a worktree sitting on the
   * base itself: a row of zeroes against your own branch is noise.
   */
  private driftBaseFor(wt: Worktree): string | undefined {
    if (wt.isMain) return undefined;
    const base = wt.baseBranch ?? this.resolveBaseBranch(wt.repoRoot);
    return base && base !== wt.branch ? base : undefined;
  }

  /**
   * Refreshes the remote ref the drift is measured against, on request.
   *
   * The only place Unmess touches the network for this. It is a click rather
   * than a timer because the numbers are read off a filesystem watch that fires
   * on every save, and because a repo's remote may be slow or want credentials —
   * neither is something to inflict on someone who just typed.
   */
  async refreshDrift(worktreeId: string): Promise<void> {
    const wt = this.findWorktree(worktreeId);
    if (!wt) return;
    const base = this.driftBaseFor(wt);
    if (!base) return;
    try {
      await this.deps.git.fetchBranch(wt.path, 'origin', base);
    } catch {
      // No remote, no network, no credentials: the local comparison below is
      // still worth redoing, and a toast for a fetch nobody watched is noise.
    }
    this.deps.gitWatcher.watch(wt.path, base);
    await this.deps.gitWatcher.refreshNow(wt.path);
    this.ui.pushWebview();
  }

  /**
   * Opens one of a worktree's ports in the browser.
   *
   * localhost rather than 0.0.0.0 or the machine's LAN address: the compose
   * override publishes on the host, and a URL a browser will actually resolve
   * is the whole value of the click.
   */
  async openPort(port: number): Promise<void> {
    await this.deps.host.openExternal(`http://localhost:${port}`);
  }

  /**
   * The ports this worktree actually owns, for display on its card.
   *
   * Derived, never stored: the same derivation the compose env and the port
   * probe use, so the number on the card is by construction the number the
   * container is published on. A worktree moved to a free slot takes its card
   * with it.
   *
   * Only the ports the user named in `unmess.docker.ports` — the debug port is
   * in there when they asked for it (XDEBUG_PORT) and left out otherwise, since
   * a debug port nobody configured is Unmess's bookkeeping rather than something
   * the user needs to know.
   */
  private portsFor(wt: Worktree): PortMapping[] {
    const config = this.deps.config.get();
    return Object.entries(computeDockerPorts(wt, config)).map(([name, port]) => ({
      name,
      port,
      // Everything but the debug port: a debugger listener answers nothing a
      // browser can render, and offering to open it is a dead tab every time.
      openable: name !== 'XDEBUG_PORT',
    }));
  }

  buildState(): UnmessState {
    const worktrees = this.orderWorktrees(this.deps.manager.list());
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
      ports: this.portsFor(wt),
      pr: this.deps.prMonitor.getStatus(wt.id) ?? null,
    }));
    const activeWorktreeId = worktrees.find((wt) => wt.id === this.currentWorktreeId)?.id;
    const config = this.deps.config.get();
    return {
      worktrees: items,
      activeWorktreeId,
      defaultProvider: config.defaultProvider,
      installedProviders: (this.deps.installedProviders ?? installedProviders)(config),
      dockerEnabled: config.docker.ports.length > 0,
      branches: this.branchOptions?.branches,
      baseBranch: this.branchOptions?.base,
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
      label: displayLabel(wt),
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
    return findRepoRoot(folders, (p) => this.deps.host.isDirectory(p));
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
      this.deps.host.addWorkspaceFolders(...toAdd.map((wt) => ({ path: wt.path, name: displayLabel(wt) })));
    }

    // The compose project is derived from the worktree's directory name, so a
    // stack brought up outside Unmess (or under the branch name instead) is
    // invisible to it. Printing the keys makes that mismatch obvious instead of
    // looking like a broken docker integration.
    console.log(`[unmess] docker projects: ${current.map((wt) => composeProject(wt)).join(', ')}`);
    for (const wt of current) {
      this.deps.gitWatcher.watch(wt.path, this.driftBaseFor(wt));
      this.deps.dockerMonitor.startPolling(composeProject(wt), () => this.ui.pushWebview());
      this.deps.prMonitor.startPolling(wt.branch, wt.id, () => this.ui.pushWebview());
    }

    await this.deps.agentManager.reconnect(current);
    this.ui.pushWebview();
    this.refreshDecorations();
    this.syncSearchScoping();
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * The branch a new worktree should start from: `unmess.defaultBaseBranch`
   * when the repo actually has it, otherwise whatever the main checkout is on.
   *
   * The fallback is what makes the setting safe to ship with a `develop`
   * default — a repo that only has `main` keeps the old behaviour instead of
   * failing every creation on a branch that does not exist.
   */
  private resolveBaseBranch(root: string): string {
    const configured = this.deps.config.get().defaultBaseBranch?.trim();
    if (configured && this.deps.git.branchExists(configured, root)) return configured;
    // An empty setting (or one naming a branch this repo does not have) means
    // "work it out": whichever of main/master/develop the repository actually
    // uses. Shipping a hardcoded default is fine for the repo it was written
    // for and wrong for everyone else's — this keeps the setting for people who
    // want to pin it, without assuming a branching convention.
    const main = this.deps.git.mainBranch(root);
    if (main) return main;
    try { return this.deps.git.currentBranch(root); } catch { return ''; }
  }

  async createWorktree(opts?: { branch?: string; title?: string; description?: string; baseBranch?: string }): Promise<void> {
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

    // The command palette passes no base at all, where git would silently use
    // HEAD. Resolve the configured default for that path too, so both entry
    // points branch off the same place.
    const baseBranch = opts?.baseBranch || this.resolveBaseBranch(root) || undefined;

    let createdWt: Worktree | undefined;
    try {
      createdWt = await this.deps.notify.withProgress(`Creating worktree "${branch}"`, async (report) => {
        report('Running git worktree add...');
        // Title → worktree alias; description stays as Claude's initial prompt.
        const wt = await this.deps.manager.create(
          branch, root, opts?.title?.trim() || undefined, baseBranch,
        );

        // The setup script goes FIRST. It is the slow, essential part (deps, .env,
        // containers — minutes of work), and it used to sit behind the UI wiring
        // below: any throw in there left a worktree checked out on disk with no
        // environment at all and nothing but a toast to show for it.
        const setupScript = this.deps.config.get().setupScript;
        if (setupScript) {
          report('Running setup script...');
          this.runScriptTerminal(wt, setupScript, 'Init', 'Setup complete');
        }

        report('Adding to workspace...');
        // Best-effort wiring: the worktree exists and its setup is already
        // running, so a failure here must not fail the whole creation.
        try {
          this.deps.host.addWorkspaceFolders({ path: wt.path, name: displayLabel(wt) });
          this.deps.gitWatcher.watch(wt.path, this.driftBaseFor(wt));
          this.deps.dockerMonitor.startPolling(composeProject(wt), () => this.ui.pushWebview());
          this.deps.prMonitor.startPolling(wt.branch, wt.id, () => this.ui.pushWebview());
        } catch (e) {
          console.error('[unmess] post-create wiring failed (worktree and setup are unaffected):', e);
        }
        this.ui.pushWebview();

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
      // Nothing stopped the PR poll: every deleted worktree left a `gh pr list`
      // running against a branch that no longer exists, every 5 minutes, until
      // the window was reloaded.
      this.deps.prMonitor.stopPolling(wt.id);

      const teardownScript = this.deps.config.get().teardownScript;
      if (teardownScript && this.deps.host.exists(wt.path)) {
        this.runScriptTerminal(wt, teardownScript, 'Teardown', 'Teardown complete');
      }

      // Bring the stack down ourselves, and WAIT for it.
      //
      // The teardown script goes to a terminal that cannot be awaited, and the
      // two seconds it used to be given are far less than a single
      // `compose down` — so `git worktree remove` pulled the directory out from
      // under it and the containers outlived the worktree, holding their ports
      // until someone noticed weeks later. This runs headless and is awaited,
      // so deletion cannot outrun it.
      if (this.deps.config.get().docker.ports.length > 0) {
        await this.dockerDown(wt);
        // Containers left standing mean the stack came up under a different
        // compose project name than the one derived from this directory — say
        // so, instead of reporting a clean teardown that removed nothing.
        const left = await this.deps.dockerMonitor.refresh(composeProject(wt)).catch(() => []);
        if (left.length > 0) {
          this.deps.notify.showWarning(
            `"${displayLabel(wt)}" left ${left.length} container(s) running. Its stack is registered under a different compose project — check \`docker compose ls\`.`,
          );
        }
      }

      await this.deps.agentManager.killWorktreeSession(wt.id);
      const folderIdx = this.deps.host.workspaceFolderPaths().findIndex((p) => p === wt.path);
      if (folderIdx !== -1) this.deps.host.removeWorkspaceFolder(folderIdx);
      try {
        await this.deps.manager.delete(wt.id, confirm === 'Delete + branch');
      } catch (e) {
        // The manager refuses to purge the store while git still registers the
        // worktree, so the card stays and the user is told why — better than a
        // card that disappears and returns nameless on the next reconcile.
        this.deps.notify.showError(
          `Could not delete "${displayLabel(wt)}": ${String(e)}. The worktree is still registered with git.`,
        );
      }
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
    // The stored alias keeps the user's full text; only the folder label is capped.
    if (idx !== -1) this.deps.host.renameWorkspaceFolder(idx, { path: wt.path, name: truncateLabel(finalAlias) });

    this.ui.pushWebview();
  }

  // ── Command helpers (item?.worktree ?? store[0] fallback) ──────────────────

  async initWorktree(worktree?: Worktree): Promise<void> {
    const wt = this.resolveWorktree(worktree);
    if (!wt) return;
    const setupScript = this.deps.config.get().setupScript;
    if (!setupScript) {
      this.deps.notify.showError('No setup script configured. Set "unmess.setupScript" in settings.');
      return;
    }
    // A re-init can happen long after the slot was allocated — re-check before
    // paying for the whole script again.
    this.runScriptTerminal(await this.ensurePortsFree(wt), setupScript, 'Init');
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
