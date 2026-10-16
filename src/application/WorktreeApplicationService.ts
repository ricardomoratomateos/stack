import * as path from 'node:path';
import type { ForemanConfig, Worktree } from '../types';
import type { ForemanState, WorktreeItem, WebMessage, PortMapping } from '../webview/types';
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
import { canonicalPath, worktreesInRepo } from '../worktree/worktreesInRepo';
import { MAIN_BRANCH_CANDIDATES } from '../constants';
import { envPrefix, shellQuote } from '../shell/shellQuote';

/**
 * The selected worktree, in workspaceState: it is a property of a WINDOW.
 * It used to live in globalState, shared by every window, so one window read
 * another's selection — an id none of its worktrees has, which scoped search
 * and dimmed the explorer as if the user had selected nothing at all.
 */
export const ACTIVE_WORKTREE_KEY = 'foreman.activeWorktreeId';
export const WORKTREE_ORDER_KEY = 'foreman.worktreeOrder';
/**
 * How long a teardown script may hold up a delete. Generous — a `compose down`
 * with volumes can take minutes — but finite: a script stuck on a prompt nobody
 * can see must not leave the card locked as "deleting" forever.
 */
export const TEARDOWN_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a resolved drift base is trusted; see driftBaseFor. */
const DRIFT_BASE_TTL_MS = 60 * 1000;

/** A terminal created for setup/teardown scripts (structural subset of vscode.Terminal). */
export interface HostTerminal {
  show(): void;
  sendText(text: string): void;
  dispose(): void;
  /** Set once the terminal has closed (vscode.Terminal.exitStatus). */
  readonly exitStatus?: unknown;
}

/** A script run headless, so its end can be awaited. */
export interface HostScriptRun {
  /** Shown as the heading of the script's output. */
  label: string;
  /** Absolute path of the script, run with bash — never through a shell string. */
  script: string;
  cwd: string;
  env: Record<string, string>;
  /** Give up (and kill the script) after this long. */
  timeoutMs: number;
}

/** All VSCode workspace/window operations the service needs, behind a port. */
export interface IWorkspaceHost {
  workspaceFolderPaths(): string[];
  removeWorkspaceFolder(index: number): void;
  addWorkspaceFolders(...folders: Array<{ path: string; name: string }>): void;
  renameWorkspaceFolder(index: number, folder: { path: string; name: string }): void;
  /** Current display name of the workspace folder at a path, if it is in the workspace. */
  workspaceFolderName(path: string): string | undefined;
  saveAll(includeUntitled: boolean): Promise<void>;
  moveEditorToFirstInGroup(): Promise<void>;
  createTerminal(options: { name: string; cwd: string }): HostTerminal;
  /**
   * Run a script to completion with its output in an output channel. Resolves
   * the exit code — null when it was killed or timed out — and never rejects.
   */
  runScript(run: HostScriptRun): Promise<number | null>;
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
  /** Open (or reveal) the full-screen new-agent panel. */
  openNewTask(): void;
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
  /** Per-window state (ctx.workspaceState): the selected worktree. */
  workspaceState: GlobalStateLike;
  /**
   * Which agents are runnable on this machine. Injected so tests do not depend
   * on whatever the developer happens to have on their PATH.
   */
  installedProviders?: (config: ForemanConfig) => ProviderId[];
}

const NO_UI: UiBridge = { pushWebview() {}, syncDecorations() {}, openDiffPanel() {}, openNewTask() {} };

/**
 * Messages the extension handles ahead of the webview protocol listing them.
 *
 * `forgetWorktree` is the explicit answer to a card flagged `missing`; it lives
 * here rather than in src/webview/types.ts only because the sidebar is being
 * redesigned and owns that file — it belongs in WebMessage once the button does.
 */
export type PendingWebMessage = { type: 'forgetWorktree'; worktreeId: string };
export type InboundMessage = WebMessage | PendingWebMessage;

/**
 * A card's state as pushed to the webview. `missing` is only present (and then
 * true) for a worktree whose directory is gone — see findMissingWorktrees.
 */
export type WorktreeItemState = WorktreeItem & { missing?: true };

/** One strategy per webview message type; exhaustive over the InboundMessage union. */
type MessageHandlers = {
  [K in InboundMessage['type']]: (msg: Extract<InboundMessage, { type: K }>) => void | Promise<void>;
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
  /**
   * Worktrees whose directory is gone, as of the last reconcile. Shown with a
   * flag and an explicit "Forget"; never watched, polled or added to the
   * workspace, and never dropped from the store on Foreman's own initiative.
   */
  private missing = new Set<string>();
  /**
   * What this window is watching and polling, by worktree id — so a reload can
   * stop what it no longer shows instead of only ever starting more.
   */
  private monitored = new Map<string, Worktree>();
  /** Script terminals, one per worktree and purpose, reused instead of piling up ptys. */
  private scriptTerminals = new Map<string, HostTerminal>();
  /** resolveBaseBranch for drift, which is display-only — see driftBaseFor. */
  private driftBaseCache = new Map<string, { base: string; at: number }>();

  constructor(private readonly deps: WorktreeAppDeps) {
    this.currentWorktreeId = this.restoreActiveWorktreeId();
  }

  /**
   * The selection this window had, from workspaceState.
   *
   * One-time migration from the old global key: adopted only when it names one
   * of THIS window's worktrees — the global value is whichever window selected
   * last — and then written per window, so it is never consulted again.
   */
  private restoreActiveWorktreeId(): string | undefined {
    const own = this.deps.workspaceState.get<string | null>(ACTIVE_WORKTREE_KEY);
    if (own !== undefined) return own ?? undefined;
    const legacy = this.deps.globalState.get<string>(ACTIVE_WORKTREE_KEY);
    if (!legacy || !this.worktreesInWindow().some((w) => w.id === legacy)) return undefined;
    void this.deps.workspaceState.update(ACTIVE_WORKTREE_KEY, legacy);
    return legacy;
  }

  private setActiveWorktreeId(id: string | undefined): void {
    this.currentWorktreeId = id;
    // null rather than undefined: undefined would read back as "never set" and
    // re-run the migration from the global key.
    this.deps.workspaceState.update(ACTIVE_WORKTREE_KEY, id ?? null);
  }

  /** A deleted worktree stops being the selection; search goes back to main. */
  private forgetActive(deletedId: string): void {
    if (this.currentWorktreeId !== deletedId) return;
    this.setActiveWorktreeId(undefined);
    this.syncSearchScoping();
  }

  /**
   * The worktree to treat as active: the selection when it is one of this
   * window's worktrees, otherwise the main checkout.
   *
   * A selection that resolves to nothing — another window's, or a worktree
   * since deleted — used to be passed on as is, and every consumer reads "no
   * worktree is X" as "exclude everything": search.exclude `**` on every
   * folder (search and Quick Open find nothing) and the whole explorer dimmed.
   */
  private effectiveActiveId(worktrees: Worktree[] = this.worktreesInWindow()): string | undefined {
    return worktrees.find((w) => w.id === this.currentWorktreeId)?.id ?? worktrees.find((w) => w.isMain)?.id;
  }

  setUi(ui: UiBridge): void {
    this.ui = ui;
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** Push the current worktree list + active worktree to the explorer dimming. */
  private refreshDecorations(): void {
    const worktrees = this.worktreesInWindow();
    this.ui.syncDecorations(worktrees, this.effectiveActiveId(worktrees));
  }

  /**
   * The worktrees belonging to the repository open in THIS window.
   *
   * The store is global to the extension, so every window used to list every
   * worktree of every repo it had ever seen. Invisible while only one project
   * was ever open; the moment the extension was installed and Foreman's own
   * checkout was opened beside aside, that checkout arrived at the top of
   * aside's sidebar as "main".
   *
   * No repository, no worktrees. Showing the whole store in that case would be
   * the same bug in its worst form — a window with nothing git-shaped open
   * listing every worktree of every project. And there is no transient to
   * protect against: loadWorktreesForRepo always keeps the repo root in the
   * workspace, so a resolved root does not go missing under us.
   */
  private worktreesInWindow(): Worktree[] {
    return worktreesInRepo(this.deps.manager.list(), this.findRepoRoot());
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
    const all = this.worktreesInWindow();
    return all.find((w) => w.id === this.currentWorktreeId) ?? all[0];
  }

  /**
   * Run a setup/teardown script in a visible host terminal registered to the
   * worktree. The script path is resolved against the repo (worktree-first,
   * then main), and the script gets FOREMAN_* env plus the worktree's docker
   * ports so it can prepare deps and bring the stack up without guessing.
   */
  private runScriptTerminal(wt: Worktree, script: string, labelPrefix: string, doneMessage?: string): void {
    const { resolved, env } = this.scriptInvocation(wt, script);
    // Typed into the user's shell, so every value is single-quoted (shellQuote).
    // These used to sit in double quotes, where `$(…)` still runs — and the
    // branch, which is also the worktree directory's name, may legally contain
    // exactly that. A branch named `x$(curl …|sh)` ran on "Init worktree".
    const prefix = envPrefix(env);
    const terminal = this.scriptTerminal(wt, labelPrefix);
    this.deps.agentManager.register(wt.id, terminal as never);
    terminal.show();
    const cmd = `${prefix} bash ${shellQuote(resolved)}`;
    terminal.sendText(doneMessage ? `${cmd} && echo ${shellQuote(`✓ ${doneMessage}`)}` : cmd);
  }

  /**
   * Where a setup/teardown script lives (worktree-first, then main) and the
   * FOREMAN_* env plus docker ports it is handed — shared by the terminal run
   * and the awaited teardown so the two can never disagree.
   */
  private scriptInvocation(wt: Worktree, script: string): { resolved: string; env: Record<string, string> } {
    const config = this.deps.config.get();
    const resolved =
      this.locateRepoFile(wt, script) ?? (path.isAbsolute(script) ? script : path.join(wt.repoRoot, script));
    const env: Record<string, string> = {
      FOREMAN_REPO_ROOT: wt.repoRoot,
      FOREMAN_WORKTREE_PATH: wt.path,
      FOREMAN_BRANCH: wt.branch,
      FOREMAN_COMPOSE_PROJECT: composeProject(wt),
      ...(config.docker.ports.length > 0 ? dockerEnv(wt, config) : {}),
    };
    return { resolved, env };
  }

  /**
   * The worktree's terminal for one purpose ("Init", "Docker"), reused while it
   * is open. Each run used to create a new one that nothing ever closed: a pty
   * per re-init and per `compose up`, for the life of the window. A terminal the
   * user closed is replaced; a busy one simply queues the next command.
   */
  private scriptTerminal(wt: Worktree, purpose: string): HostTerminal {
    const key = `${wt.id}\0${purpose}`;
    const open = this.scriptTerminals.get(key);
    if (open && open.exitStatus === undefined) return open;
    const terminal = this.deps.host.createTerminal({ name: `${purpose}: ${displayLabel(wt)}`, cwd: wt.path });
    this.scriptTerminals.set(key, terminal);
    return terminal;
  }

  /** Closes a worktree's script terminals: their cwd is about to stop existing. */
  private disposeScriptTerminals(worktreeId: string): void {
    for (const [key, terminal] of this.scriptTerminals) {
      if (!key.startsWith(`${worktreeId}\0`)) continue;
      terminal.dispose();
      this.scriptTerminals.delete(key);
    }
  }

  /**
   * Run the teardown script and wait for it to finish.
   *
   * It used to be typed into a terminal, which cannot be awaited, and
   * `git worktree remove --force` ran straight after — pulling the directory
   * out from under a script whose whole job is to clean up in it. Headless, with
   * its output in an output channel, deletion now waits for it. A failure is
   * reported but does not stop the delete the user asked for.
   */
  private async runTeardown(wt: Worktree, script: string): Promise<void> {
    const { resolved, env } = this.scriptInvocation(wt, script);
    const code = await this.deps.host.runScript({
      label: `Teardown: ${displayLabel(wt)}`,
      script: resolved,
      cwd: wt.path,
      env,
      timeoutMs: TEARDOWN_TIMEOUT_MS,
    });
    if (code !== 0) {
      this.deps.notify.showWarning(
        `Teardown script for "${displayLabel(wt)}" ${code === null ? 'did not finish' : `exited with code ${code}`} — see the Foreman output. Deleting anyway.`,
      );
    }
  }

  /**
   * Resolve a repo-relative file, preferring the worktree's own copy (when its
   * branch carries `.foreman/`) and falling back to the main repo — where
   * `.foreman/` lives when the branch predates it. Returns undefined if neither
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
    const terminal = this.scriptTerminal(wt, 'Docker');
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
      console.error('[foreman] port re-check failed; keeping the current ports:', e);
      return wt;
    }
    if (moved.movedFrom !== undefined) {
      const ports = portBlockFor(moved.worktree.debugPort, this.deps.config.get()).join(', ');
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
    openNewTask: () => this.ui.openNewTask(),
    createWorktree: (msg) => this.createWorktree({
      branch: msg.branch, title: msg.title, description: msg.description, baseBranch: msg.baseBranch,
    }),
    listBranches: () => {
      const root = this.findRepoRoot();
      if (!root) return;
      this.branchOptions = { branches: this.deps.git.listBranches(root), base: this.resolveBaseBranch(root) };
      this.ui.pushWebview();
    },
    renameSession: (msg) => void this.renameSession(msg.worktreeId, msg.index),
    openPort: (msg) => void this.openPort(msg.port),
    refreshDrift: (msg) => void this.refreshDrift(msg.worktreeId),
    selectWorktree: (msg) => this.switchToWorktree(msg.worktreeId),
    forgetWorktree: (msg) => this.forgetWorktree(msg.worktreeId),
  };

  async handleMessage(msg: InboundMessage): Promise<void> {
    // Ignore any action targeting a worktree that is tearing down.
    if ('worktreeId' in msg && this.deleting.has(msg.worktreeId)) return;
    const handler = this.messageHandlers[msg.type] as
      | ((m: InboundMessage) => void | Promise<void>)
      | undefined;
    if (handler) await handler(msg);
  }

  // ── External file drops (screenshot on an agent viewer) ────────────────────

  /** The worktree a drop with no viewer of its own falls back to. */
  activeWorktreeId(): string | undefined {
    return this.currentWorktreeId;
  }

  /**
   * Route externally-dropped files (a macOS screenshot thumbnail dropped on an
   * agent viewer) to that worktree's agent: reveal its viewer and paste the
   * quoted paths unsent, so the user can add prompt text before hitting Enter.
   */
  async attachDroppedFiles(paths: string[], targetId?: string): Promise<void> {
    if (paths.length === 0) return;
    const worktrees = this.worktreesInWindow();
    // An explicit target is the worktree whose viewer the image was dropped on;
    // without one it goes to whatever is active.
    const wt = targetId
      ? this.findWorktree(targetId)
      : this.findWorktree(this.currentWorktreeId ?? '') ?? (worktrees.length === 1 ? worktrees[0] : undefined);
    if (!wt) {
      this.deps.notify.showWarning('Foreman: select a worktree first, then drop the image again.');
      return;
    }
    if (!this.deps.agentManager.hasTerminals(wt.id)) {
      this.deps.notify.showWarning(
        `Foreman: no agent session in ${wt.alias ?? wt.branch} — launch one, then drop the image again.`,
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
    // This window's worktrees only. The whole store used to go to the
    // breakpoint and tab managers from here, bypassing the scoping they are
    // otherwise given — so a switch stashed breakpoints and closed tabs that
    // belonged to other repositories' worktrees.
    const worktrees = this.worktreesInWindow();
    const target = worktrees.find((w) => w.id === worktreeId);
    if (!target) return;

    console.log(`[foreman] switch to id=${worktreeId} path=${target.path} exists=${this.deps.host.exists(target.path)}`);
    this.setActiveWorktreeId(worktreeId);
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

  /** Clean-slate switch (foreman.focusMode): only the active worktree on screen. */
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
    for (const wt of this.worktreesInWindow()) {
      if (this.deps.agentManager.getViewer(wt.id) === terminal) {
        if (this.currentWorktreeId !== wt.id) {
          this.setActiveWorktreeId(wt.id);
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
    const base = wt.baseBranch ?? this.cachedBaseBranch(wt.repoRoot);
    return base && base !== wt.branch ? base : undefined;
  }

  /**
   * resolveBaseBranch, remembered for a minute per repo and setting.
   *
   * It is up to seven synchronous git calls, and loading a repo asked it once
   * per worktree — a frozen extension host on every window load, scaling with
   * the number of worktrees, for an answer that is the same each time. Only
   * drift uses the cache: it is display-only and names the ref it compared, so
   * a minute of staleness is honest. Creating a worktree still resolves fresh.
   */
  private cachedBaseBranch(repoRoot: string): string {
    const key = `${canonicalPath(repoRoot)}\0${this.deps.config.get().defaultBaseBranch ?? ''}`;
    const hit = this.driftBaseCache.get(key);
    if (hit && Date.now() - hit.at < DRIFT_BASE_TTL_MS) return hit.base;
    const base = this.resolveBaseBranch(repoRoot);
    this.driftBaseCache.set(key, { base, at: Date.now() });
    return base;
  }

  /**
   * Refreshes the remote ref the drift is measured against, on request.
   *
   * The only place Foreman touches the network for this. It is a click rather
   * than a timer because the numbers are read off a filesystem watch that fires
   * on every save, and because a repo's remote may be slow or want credentials —
   * neither is something to inflict on someone who just typed.
   */
  async refreshDrift(worktreeId: string): Promise<void> {
    const wt = this.findWorktree(worktreeId);
    // A missing worktree has nothing to compare, and watching it would undo
    // keeping it out of the watcher.
    if (!wt || this.missing.has(wt.id)) return;
    // An explicit "check again" deserves a fresh answer to "against what?" too.
    this.driftBaseCache.clear();
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
   * Names one session — the shell running redis becomes "redis".
   *
   * Prefilled with whatever the row shows now, so renaming is an edit rather
   * than a retype, and an empty answer clears the name instead of setting a
   * blank one: that is the only way back to the derived label.
   */
  async renameSession(worktreeId: string, index: number): Promise<void> {
    const session = this.deps.agentManager.getSessions(worktreeId).find((s) => s.index === index);
    if (!session) return;
    const name = await this.deps.host.showInputBox({
      prompt: 'Name for this session',
      value: session.alias ?? session.name,
      placeHolder: 'e.g. redis',
    });
    if (name === undefined) return; // dismissed
    this.deps.agentManager.setSessionAlias(worktreeId, index, name);
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
   * Only the ports the user named in `foreman.docker.ports` — the debug port is
   * in there when they asked for it (DEBUG_PORT) and left out otherwise, since
   * a debug port nobody configured is Foreman's bookkeeping rather than something
   * the user needs to know.
   */
  private portsFor(wt: Worktree): PortMapping[] {
    const config = this.deps.config.get();
    return Object.entries(computeDockerPorts(wt, config)).map(([name, port]) => ({
      name,
      port,
      // Everything but the debug port: a debugger listener answers nothing a
      // browser can render, and offering to open it is a dead tab every time.
      openable: name !== 'DEBUG_PORT',
    }));
  }

  buildState(): ForemanState {
    const worktrees = this.orderWorktrees(this.worktreesInWindow());
    const items = worktrees.map((wt): WorktreeItemState => ({
      ...(this.missing.has(wt.id) ? { missing: true as const } : {}),
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
    // The branch this worktree was cut from goes first. `branch` mode answers
    // "what did I add on top of my base", and without this it resolved to the
    // first of main/master/develop that existed — so a worktree cut from
    // release/3.2 in a repo that also has main was diffed against main, showing
    // every commit release/3.2 carries over main mixed in with the three the
    // agent wrote, while the card beside it measured drift against the right
    // branch. The defaults stay behind it, so a base branch deleted since still
    // resolves to something rather than collapsing to a plain HEAD diff.
    const mainBranchCandidates = wt.baseBranch
      ? [wt.baseBranch, ...MAIN_BRANCH_CANDIDATES]
      : MAIN_BRANCH_CANDIDATES;
    return this.deps.git.diff(wt.path, { base, mainBranchCandidates });
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
    // 'live' finds no running agent when the one the panel saw has exited
    // since — the comments then go to a fresh agent rather than nowhere.
    if (destination === 'live' && (await this.deps.agentManager.sendPromptToAgent(wt, prompt))) {
      return true;
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

  /** Branch list + preselected base for the new-agent panel's "from" selector. */
  newTaskBranchOptions(): { branches: string[]; baseBranch: string } {
    const root = this.findRepoRoot();
    if (!root) return { branches: [], baseBranch: 'main' };
    return { branches: this.deps.git.listBranches(root), baseBranch: this.resolveBaseBranch(root) };
  }

  async start(): Promise<void> {
    const root = this.findRepoRoot();
    if (root) await this.loadWorktreesForRepo(root);
  }

  async handleAddedWorkspaceFolders(paths: string[]): Promise<void> {
    // Only when the folder that arrived IS this window's repository.
    //
    // This used to load whichever added folder had a .git first, which is right
    // for the case it was written for — a repo dropped into an empty window —
    // and wrong for a second repo dropped in beside the first: it would reload
    // for the newcomer, prune the original's worktree folders as foreign, and
    // leave the sidebar (still scoped to the original) listing worktrees whose
    // folders had just been removed. findRepoRoot decides which repo a window
    // belongs to; this now agrees with it.
    const root = this.findRepoRoot();
    if (root && paths.some((p) => canonicalPath(p) === canonicalPath(root))) {
      await this.loadWorktreesForRepo(root);
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
    const worktrees = this.worktreesInWindow();
    // With no worktree selected — or one that no longer resolves — keep the main
    // repo searchable as the fallback. And if even that is missing, exclude
    // nothing: a window where search finds nothing at all is the worst outcome.
    const activeId = this.effectiveActiveId(worktrees);
    for (const wt of worktrees) {
      if (this.missing.has(wt.id)) continue; // no folder to scope
      const exclude = enabled && activeId !== undefined && wt.id !== activeId ? { '**': true } : undefined;
      void this.deps.host.updateFolderSetting(wt.path, 'search.exclude', exclude).catch(() => {});
    }
  }

  async loadWorktreesForRepo(repoRoot: string): Promise<void> {
    const { current, missing } = await this.deps.manager.reconcile(repoRoot);
    this.missing = new Set(missing.map((w) => w.id));
    const normalizedRoot = canonicalPath(repoRoot);
    // The store is global; this window is not. Everything below — the explorer
    // folders, the git watches, the docker and PR polling — used to run against
    // every worktree of every repository the extension had ever seen, which is
    // how a window opened on one project filled up with another one's folders.
    //
    // A missing worktree stays on its card (so it can be forgotten) and out of
    // everything else: a folder that does not exist, a watcher on nothing, and
    // a `gh` poll every five minutes for a branch nobody is working on.
    const mine = worktreesInRepo(current, repoRoot).filter((w) => !this.missing.has(w.id));

    const keep = new Set([repoRoot, ...mine.map((w) => w.path)].map(canonicalPath));
    // Folders Foreman itself added for some OTHER repository, which are ours to
    // take back. Deliberately excludes another repo's MAIN checkout: that is a
    // project the user opened, not noise we introduced.
    //
    // Identified by the path being its own repo root rather than by isMain,
    // because that flag is exactly what the cross-repo bug corrupted — a
    // checkout demoted by 0.1.0 would otherwise be read as a stray worktree and
    // removed from the workspace, which is a far worse thing to get wrong than
    // leaving a folder behind.
    const foreign = new Set(
      current
        .filter((w) => {
          const root = canonicalPath(w.repoRoot);
          return root !== normalizedRoot && canonicalPath(w.path) !== root;
        })
        .map((w) => canonicalPath(w.path)),
    );
    const indicesToRemove = this.deps.host
      .workspaceFolderPaths()
      .map((p, i) => ({ p: canonicalPath(p), i }))
      // Only folders Foreman is responsible for: another repo's worktree, or a
      // stale one inside this repository. A folder it does not recognise is the
      // user's own and is left where they put it.
      .filter(({ p }) => !keep.has(p) && (foreign.has(p) || p.startsWith(normalizedRoot + path.sep)))
      .map(({ i }) => i)
      .sort((a, b) => b - a);
    for (const idx of indicesToRemove) this.deps.host.removeWorkspaceFolder(idx);

    const existing = this.deps.host.workspaceFolderPaths();
    const toAdd = mine.filter((wt) => !existing.some((p) => p === wt.path));
    if (toAdd.length > 0) {
      this.deps.host.addWorkspaceFolders(...toAdd.map((wt) => ({ path: wt.path, name: displayLabel(wt) })));
    } else {
      // With an add in flight the relabel waits for the folders-changed event
      // (two workspace mutations back to back is unsupported); with nothing
      // pending it can run right now.
      this.syncMainFolderLabel();
    }

    // The compose project is derived from the worktree's directory name, so a
    // stack brought up outside Foreman (or under the branch name instead) is
    // invisible to it. Printing the keys makes that mismatch obvious instead of
    // looking like a broken docker integration.
    console.log(`[foreman] docker projects: ${mine.map((wt) => composeProject(wt)).join(', ')}`);
    // A diff, not just a start: whatever an earlier load watched and polled
    // that is no longer in this set — another repository after the window
    // switched, a worktree gone missing, one forgotten elsewhere — is stopped
    // instead of running until the window closes.
    const wanted = new Set(mine.map((w) => w.id));
    for (const wt of [...this.monitored.values()]) {
      if (!wanted.has(wt.id)) this.stopMonitoring(wt);
    }
    for (const wt of mine) this.startMonitoring(wt);

    // Tab and breakpoint stashes are keyed by worktree id and were never
    // cleaned, so every worktree ever deleted kept its blob in globalState.
    // Against the whole store, not this window's slice: another repository's
    // worktrees are alive, just not shown here.
    this.pruneWorktreeState();

    // `mine`, not `current`: reconnecting another repo's worktrees costs a tmux
    // lookup each and leaves the session manager tracking windows this window
    // will never show — which the shell poller would then keep polling.
    await this.deps.agentManager.reconnect(mine);
    this.ui.pushWebview();
    this.refreshDecorations();
    this.syncSearchScoping();
  }

  /** Watch and poll a worktree (idempotent), remembering it so it can be stopped. */
  private startMonitoring(wt: Worktree): void {
    const before = this.monitored.get(wt.id);
    // Same id under a new path or project: the old watcher and poll would
    // otherwise be keyed by something nothing will ever stop again.
    if (before && (before.path !== wt.path || composeProject(before) !== composeProject(wt))) {
      this.stopMonitoring(before);
    }
    this.deps.gitWatcher.watch(wt.path, this.driftBaseFor(wt));
    this.deps.dockerMonitor.startPolling(composeProject(wt), () => this.ui.pushWebview());
    this.deps.prMonitor.startPolling(wt.branch, wt.id, wt.path, () => this.ui.pushWebview());
    this.monitored.set(wt.id, wt);
  }

  private stopMonitoring(wt: Worktree): void {
    this.monitored.delete(wt.id);
    this.deps.gitWatcher.unwatch(wt.path);
    // Compose projects are derived from directory names, so two worktrees can
    // share one; the poll is the survivor's too.
    const project = composeProject(wt);
    if (![...this.monitored.values()].some((w) => composeProject(w) === project)) {
      this.deps.dockerMonitor.stopPolling(project);
    }
    // Nothing stopped the PR poll: every deleted worktree left a `gh pr list`
    // running against a branch that no longer exists, every 5 minutes, until
    // the window was reloaded.
    this.deps.prMonitor.stopPolling(wt.id);
  }

  /** Drop tab and breakpoint stashes of worktrees the store no longer has. */
  private pruneWorktreeState(): void {
    const live = new Set(this.deps.manager.list().map((w) => w.id));
    // A loaded repository always has at least its main checkout in the store,
    // so an empty store is a read gone wrong, not a licence to wipe everything.
    if (live.size === 0) return;
    this.deps.tabManager.prune(live);
    this.deps.breakpointManager.prune(live);
  }

  // ── Forget (a missing worktree) ────────────────────────────────────────────

  /**
   * Drops the store entry of a worktree whose directory is gone — the explicit
   * answer to a card flagged `missing`, and the only way such an entry leaves.
   *
   * Nothing on disk is touched and no git command runs that could change
   * anything; the manager re-checks that the worktree is really gone first.
   * If it no longer looks gone — back on disk, back in git's list, or git could
   * not answer — the flag is cleared and it is monitored again instead: a doubt
   * always lands on the side of keeping the worktree.
   */
  async forgetWorktree(worktreeId: string): Promise<void> {
    const wt = this.findWorktree(worktreeId);
    if (!wt || !this.missing.has(wt.id)) return;
    const forgot = await this.deps.manager.forget(wt.id);
    this.missing.delete(wt.id);
    if (forgot) {
      this.stopMonitoring(wt);
      this.disposeScriptTerminals(wt.id);
      await this.deps.agentManager.killWorktreeSession(wt.id);
      const folderIdx = this.deps.host.workspaceFolderPaths().findIndex((p) => p === wt.path);
      if (folderIdx !== -1) this.deps.host.removeWorkspaceFolder(folderIdx);
      this.pruneWorktreeState();
      this.forgetActive(wt.id);
    } else {
      this.deps.notify.showWarning(`"${displayLabel(wt)}" no longer looks gone — keeping it.`);
      this.startMonitoring(wt);
    }
    this.ui.pushWebview();
    this.refreshDecorations();
  }

  /**
   * Label the main repo's own folder by its branch/alias, so the Explorer root
   * reads the same as the sidebar ("develop", not the on-disk "aside"). A pure
   * display-name change through the workspace API — nothing is written into the
   * project and the directory keeps its real name.
   *
   * In a single-folder window VSCode can't relabel the root in place: the
   * rename turns the window into an untitled workspace (folder already named
   * "develop") and restarts the extension host once. That is the same
   * transition adding the first worktree folder triggers, so it is simply
   * brought forward to the first activation. Guarded on the label actually
   * changing, so the folders-changed event the rename itself fires cannot loop
   * back here.
   */
  syncMainFolderLabel(): void {
    const root = this.findRepoRoot();
    if (!root) return;
    const normalizedRoot = canonicalPath(root);
    const folderPaths = this.deps.host.workspaceFolderPaths();
    const main = worktreesInRepo(this.deps.manager.list(), root)
      .find((wt) => canonicalPath(wt.path) === normalizedRoot);
    if (!main) return;
    const label = displayLabel(main);
    const idx = folderPaths.findIndex((p) => canonicalPath(p) === normalizedRoot);
    if (idx !== -1 && this.deps.host.workspaceFolderName(main.path) !== label) {
      this.deps.host.renameWorkspaceFolder(idx, { path: main.path, name: label });
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * The branch a new worktree should start from: `foreman.defaultBaseBranch`
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
          this.startMonitoring(wt);
        } catch (e) {
          console.error('[foreman] post-create wiring failed (worktree and setup are unaffected):', e);
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
      // The new worktree is what the user is about to work in: select its card,
      // scope search and breakpoints to it, and in focus mode clear the rest —
      // exactly what clicking the card would do. Its viewer does not exist yet,
      // so this reveals nothing; launch() below brings the terminal up.
      await this.switchToWorktree(wt.id);
      const description = opts?.description;
      setTimeout(() => {
        // Nothing awaits this timer, so a failure must be reported here or it
        // vanishes as an unhandled rejection — the worktree then simply never
        // got its agent, with nothing on screen to say why.
        const launched = description
          ? this.deps.agentManager.launchWithPrompt(wt, description)
          : this.deps.agentManager.launch(wt);
        launched.catch((e) => this.deps.notify.showError(`Failed to launch agent: ${String(e)}`));
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
    const isActuallyMain = pathExists && !!repoRoot && canonicalPath(wt.path) === canonicalPath(repoRoot);
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
      this.forgetActive(wt.id);
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
      this.stopMonitoring(wt);

      const teardownScript = this.deps.config.get().teardownScript;
      if (teardownScript && this.deps.host.exists(wt.path)) {
        await this.runTeardown(wt, teardownScript);
      }

      // Bring the stack down ourselves, and WAIT for it.
      //
      // The teardown script used to go to a terminal that could not be awaited,
      // and the two seconds it was given are far less than a single
      // `compose down` — so `git worktree remove` pulled the directory out from
      // under it and the containers outlived the worktree, holding their ports
      // until someone noticed weeks later. The script is awaited now, but it
      // is the user's and may not touch docker at all; this runs regardless.
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
      this.disposeScriptTerminals(wt.id);
      const folderIdx = this.deps.host.workspaceFolderPaths().findIndex((p) => p === wt.path);
      if (folderIdx !== -1) this.deps.host.removeWorkspaceFolder(folderIdx);
      try {
        await this.deps.manager.delete(wt.id, confirm === 'Delete + branch');
        this.missing.delete(wt.id);
        this.pruneWorktreeState();
        this.forgetActive(wt.id);
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
      this.deps.notify.showError('No setup script configured. Set "foreman.setupScript" in settings.');
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
    if (wt) {
      this.deps.agentManager.launch(wt, { provider })
        .catch((e) => this.deps.notify.showError(`Failed to launch agent: ${String(e)}`));
    }
  }

  // ── Cyclic navigation ──────────────────────────────────────────────────────

  focusNextWorktree(): void {
    this.cycleWorktree(1);
  }

  focusPrevWorktree(): void {
    this.cycleWorktree(-1);
  }

  private cycleWorktree(direction: 1 | -1): void {
    const worktrees = this.worktreesInWindow();
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
