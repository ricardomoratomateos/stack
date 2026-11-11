import * as path from 'node:path';
import { Emitter, type Event } from '../../core/Emitter';
import type { Snapshot } from '../StackDaemon';
import type { DaemonClient } from './DaemonClient';
import type { StackConfig, Worktree, WorktreeTicket } from '../../types';
import type { StackState, WebMessage, WorktreeItem, AgentState } from '../../webview/types';
import type { ProviderId } from '../../ports/IAgentProvider';
import { PROVIDER_INSTALL } from '../../ports/IAgentProvider';
import { DiffError, type DiffBase } from '../../ports/IGitPort';
import type { INotifyPort } from '../../ports/INotifyPort';
import type { SendDestination, DiffComment } from '../../diff/types';
import { buildCommentPrompt } from '../../diff/commentPrompt';
import type { NewTaskInit } from '../../newtask/types';
import type { IWorkspaceHost, UiBridge } from '../../application/WorktreeApplicationService';
import { ACTIVE_WORKTREE_KEY } from '../../application/WorktreeApplicationService';
import { planDelete } from '../../application/deletePlan';
import type { SessionTerminalHost } from '../../session/terminalHost';
import type { StateChange } from '../../session/AttentionNotifier';
import { displayLabel, truncateLabel } from '../../worktree/displayLabel';
import { canonicalPath } from '../../worktree/worktreesInRepo';

type Terminals = SessionTerminalHost<{ show(): void }>;

export interface RemoteServiceDeps {
  client: Pick<DaemonClient, 'command' | 'snapshot' | 'onSnapshot'>;
  /** This window's repository, resolved per read like everywhere else. */
  repoRoot: () => string | undefined;
  terminals: Terminals;
  notify: INotifyPort;
  host: IWorkspaceHost;
  /** The window's effective settings (VS Code's, over the repo file). */
  config: { get(): StackConfig; setDefaultProvider(p: ProviderId): Promise<void> };
  installedProviders: (config: StackConfig) => ProviderId[];
  /** The window's own memory: which worktree is selected. */
  workspaceState: { get<T>(key: string): T | undefined; update(key: string, value: unknown): unknown };
  /** How long a freshly opened tab is safe from "its window is gone" (a snapshot older than the tab may arrive late). */
  tabGraceMs?: number;
}

const WORKTREE_PLACEHOLDER = { debugPort: 0, dockerProjectName: '', createdAt: 0 };

/** A sidebar item seen as the store's Worktree, which is what the terminal layer is written against. */
export function itemToWorktree(item: WorktreeItem, repoRoot: string): Worktree {
  return {
    id: item.id, branch: item.branch, alias: item.alias, path: item.path, repoRoot,
    isMain: item.isMain, ...(item.isControl ? { isControl: true as const } : {}), ...WORKTREE_PLACEHOLDER,
  };
}

/**
 * What the extension does when `stackd` owns the state (`stack.useDaemon`):
 * the same surface as WorktreeApplicationService for everything the sidebar,
 * the review panel, the new-task panel and the commands use, but state comes
 * from the daemon's snapshot and every change goes out as a command. What
 * stays here is what only the editor can do: prompts and confirms, terminal
 * tabs (attached to the daemon's tmux sessions), workspace folders, the
 * window's selection.
 */
export class RemoteService {
  private ui: UiBridge = { pushWebview() {}, syncDecorations() {}, openDiffPanel() {}, openNewTask() {} };
  private readonly changes = new Emitter<void>();
  private readonly stateChanges = new Emitter<StateChange>();
  private selected: string | undefined;
  private branchOptions?: { branches: string[]; base: string };
  private known = new Map<string, Set<number>>();
  private prevAgent = new Map<string, AgentState>();
  private opened = new Map<string, number>();
  private baselined = false;
  private repoAdded?: Promise<void>;
  private readonly sub: { dispose(): void };

  /** Fires after every snapshot: the sidebar's reason to re-read buildState(). */
  readonly onChange: Event<void> = this.changes.event;
  /** Per-worktree agent state transitions, in AttentionNotifier's shape. */
  readonly onStateChange: Event<StateChange> = this.stateChanges.event;

  constructor(private readonly deps: RemoteServiceDeps) {
    this.selected = deps.workspaceState.get<string | null>(ACTIVE_WORKTREE_KEY) ?? undefined;
    this.sub = deps.client.onSnapshot(() => { void this.reconcile(); });
  }

  setUi(ui: UiBridge): void { this.ui = ui; }

  dispose(): void {
    this.sub.dispose();
    this.changes.dispose();
    this.stateChanges.dispose();
  }

  // ── State ─────────────────────────────────────────────────────────────────

  private current(): { root: string; state: StackState } | undefined {
    const root = this.deps.repoRoot();
    const snap: Snapshot | undefined = this.deps.client.snapshot;
    if (!root || !snap) return undefined;
    const repo = snap.repos.find((r) => canonicalPath(r.repoRoot) === canonicalPath(root));
    return repo ? { root: repo.repoRoot, state: repo.state } : undefined;
  }

  private items(): WorktreeItem[] {
    const s = this.current()?.state;
    return s ? [...s.worktrees, ...(s.controlSession ? [s.controlSession] : [])] : [];
  }

  private item(id: string | undefined): WorktreeItem | undefined {
    return id ? this.items().find((w) => w.id === id) : undefined;
  }

  private worktreeOf(item: WorktreeItem): Worktree {
    return itemToWorktree(item, this.current()?.root ?? this.deps.repoRoot() ?? item.path);
  }

  /** The id a command's optional worktree argument stands for: the one given, else the selection. */
  private resolveId(worktree?: { id: string }): string | undefined {
    return worktree?.id ?? this.activeWorktreeId();
  }

  buildState(): StackState {
    const config = this.deps.config.get();
    const base = this.current()?.state ?? { worktrees: [] };
    return {
      ...base,
      activeWorktreeId: base.worktrees.find((w) => w.id === this.selected)?.id,
      defaultProvider: config.defaultProvider,
      installedProviders: this.deps.installedProviders(config),
      sidebarStyle: config.sidebarStyle,
      branches: this.branchOptions?.branches,
      baseBranch: this.branchOptions?.base,
    };
  }

  activeWorktreeId(): string | undefined {
    return this.selected;
  }

  /** The worktrees this window shows (a sidebar-less caller's view of the same state). */
  windowWorktrees(): Worktree[] {
    return (this.current()?.state.worktrees ?? []).map((w) => this.worktreeOf(w));
  }

  // ── Following the daemon ──────────────────────────────────────────────────

  /** Everything a new snapshot means for this window: events, terminals, folders, the sidebar. */
  private async reconcile(): Promise<void> {
    const cur = this.current();
    if (cur) {
      const items = this.items();
      for (const item of items) {
        const before = this.prevAgent.get(item.id);
        this.prevAgent.set(item.id, item.agent);
        if (before !== undefined && before !== item.agent) {
          const session = item.sessions.find((s) => s.state === item.agent);
          this.stateChanges.fire({ worktreeId: item.id, state: item.agent, windowIndex: session?.index });
        } else if (before === undefined) {
          // The baseline of a worktree seen for the first time, as AttentionNotifier expects.
          this.stateChanges.fire({ worktreeId: item.id, state: item.agent });
        }
      }
      await this.syncTerminals(items).catch((e: unknown) => console.error('[stack] syncing terminals failed:', e));
      this.syncFolders(cur.state);
      this.ui.syncDecorations(cur.state.worktrees.map((w) => this.worktreeOf(w)), this.selected);
    }
    this.changes.fire();
    this.ui.pushWebview();
  }

  /** Tabs for sessions that appeared (a launch by the manager, by a hook, by another window), none for ones that are gone. */
  private async syncTerminals(items: WorktreeItem[]): Promise<void> {
    const first = !this.baselined;
    this.baselined = true;
    if (first) {
      const worktrees = items.map((i) => this.worktreeOf(i));
      await this.deps.terminals.claim(worktrees, (wt) => displayLabel(wt)).catch(() => {});
      await this.deps.terminals.pruneViews().catch(() => {});
    }
    const perSession = this.deps.config.get().sessionTabs !== 'single';
    for (const item of items) {
      const indexes = new Set(item.sessions.map((s) => s.index));
      const before = this.known.get(item.id);
      this.known.set(item.id, indexes);
      if (perSession) {
        // A tab opened a moment ago may be for a window this snapshot predates.
        for (const [key, at] of this.opened) if (Date.now() - at > (this.deps.tabGraceMs ?? 3000)) this.opened.delete(key);
        const young = [...this.opened.keys()].filter((k) => k.startsWith(`${item.id}:`)).map((k) => Number(k.split(':')[1]));
        await this.deps.terminals.closeTabsExcept(item.id, new Set([...indexes, ...young]));
        if (before && !first) {
          for (const s of item.sessions) if (!before.has(s.index)) await this.openSession(item, s.index);
        }
      }
    }
  }

  /** Keeps the explorer's folders in step with the worktrees, without the old path's named-workspace dance. */
  private syncFolders(state: StackState): void {
    try {
      const have = new Set(this.deps.host.workspaceFolderPaths().map(canonicalPath));
      const missing = state.worktrees.filter((w) => !w.isMain && !w.missing && !have.has(canonicalPath(w.path)));
      if (missing.length > 0) this.deps.host.addWorkspaceFolders(...missing.map((w) => ({ path: w.path, name: displayLabel(w) })));
    } catch (e) {
      console.error('[stack] syncing workspace folders failed:', e);
    }
  }

  // ── Terminals ─────────────────────────────────────────────────────────────

  /** Puts one session on screen: its tab, or in single mode the worktree's viewer switched to its window. */
  private async openSession(item: WorktreeItem, windowIndex: number, opts?: { beside?: boolean }): Promise<void> {
    const wt = this.worktreeOf(item);
    const label = displayLabel(item.isControl ? { ...item, alias: item.alias ?? 'Manager' } : item);
    const session = item.sessions.find((s) => s.index === windowIndex);
    if (this.deps.config.get().sessionTabs === 'single') {
      await this.deps.client.command('attachTarget', { worktreeId: item.id, windowIndex }).catch(() => undefined);
      if (opts?.beside) await this.deps.terminals.closeViewer(item.id);
      (opts?.beside ? this.deps.terminals.openViewerBeside(wt, label) : this.deps.terminals.openViewer(wt, label)).show();
      return;
    }
    if (!session) {
      this.deps.terminals.current(item.id)?.show();
      return;
    }
    this.opened.set(`${item.id}:${windowIndex}`, Date.now());
    const tab = await this.deps.terminals.openTab(wt, windowIndex, {
      label, session: session.alias ?? session.name, kind: session.kind,
    }, opts);
    tab.show();
  }

  /** The worktree as a whole: the tab last in front, else the first session's. */
  private async showWorktree(item: WorktreeItem): Promise<void> {
    const current = this.deps.terminals.current(item.id);
    if (current) { current.show(); return; }
    if (item.sessions.length === 0) return;
    const last = this.deps.terminals.lastFocusedWindow(item.id);
    const index = last !== undefined && item.sessions.some((s) => s.index === last) ? last : item.sessions[0].index;
    await this.openSession(item, index);
  }

  async switchToWorktree(worktreeId: string): Promise<void> {
    const item = this.item(worktreeId);
    if (!item) return;
    if (item.isControl) {
      if (item.agentCount === 0) {
        const r = await this.deps.client.command<{ windowIndex?: number }>('spawnAgent', { worktreeId });
        if (r.windowIndex !== undefined) await this.openSessionLater(worktreeId, r.windowIndex);
      } else {
        await this.showWorktree(item);
      }
      return;
    }
    if (this.selected !== worktreeId) {
      this.setSelected(worktreeId);
      this.ui.pushWebview();
      this.ui.syncDecorations((this.current()?.state.worktrees ?? []).map((w) => this.worktreeOf(w)), this.selected);
    }
    await this.showWorktree(item);
  }

  /** A window the daemon just made may not be in our snapshot yet: wait a moment for it, then show it. */
  private async openSessionLater(worktreeId: string, windowIndex: number): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const item = this.item(worktreeId);
      if (item?.sessions.some((s) => s.index === windowIndex)) { await this.openSession(item, windowIndex); return; }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private setSelected(id: string | undefined): void {
    this.selected = id;
    void this.deps.workspaceState.update(ACTIVE_WORKTREE_KEY, id ?? null);
  }

  handleActiveTerminalChange(terminal: unknown): void {
    if (!terminal) return;
    const owner = this.deps.terminals.targetOf(terminal as never)?.worktreeId;
    const item = this.item(owner);
    if (item && !item.isControl && this.selected !== item.id) {
      this.setSelected(item.id);
      this.ui.pushWebview();
      this.ui.syncDecorations((this.current()?.state.worktrees ?? []).map((w) => this.worktreeOf(w)), this.selected);
    }
  }

  // ── Webview messages ──────────────────────────────────────────────────────

  async handleMessage(msg: WebMessage): Promise<void> {
    const id = 'worktreeId' in msg ? msg.worktreeId : undefined;
    const item = this.item(id);
    if (item?.deleting) return;
    const cmd = this.deps.client.command.bind(this.deps.client);
    const repo = this.current()?.root;
    switch (msg.type) {
      case 'ready': this.ui.pushWebview(); return;
      case 'launchAgent': {
        const r = await cmd<{ windowIndex?: number }>('spawnAgent', { worktreeId: msg.worktreeId, provider: msg.provider });
        if (r.windowIndex !== undefined) await this.openSessionLater(msg.worktreeId, r.windowIndex);
        return;
      }
      case 'pickDefaultProvider': {
        const choice = await this.deps.host.showQuickPick(['claude', 'codex', 'opencode'], { placeHolder: 'Agent launched by the main button' });
        if (choice) await this.deps.config.setDefaultProvider(choice as ProviderId);
        return;
      }
      case 'showProviderInstall': return this.showProviderInstall(msg.provider);
      case 'openTerminal': return this.openTerminal(item && this.worktreeOf(item));
      case 'focusTerminal':
        await this.switchToWorktree(msg.worktreeId);
        if (item) await this.showWorktree(item);
        return;
      case 'focusSession':
        await this.switchToWorktree(msg.worktreeId);
        if (item) await this.openSession(item, msg.index, msg.toSide ? { beside: true } : undefined);
        return;
      case 'killSession': {
        const session = item?.sessions.find((s) => s.index === msg.index);
        const label = session?.kind === 'agent' ? `${session.provider ?? 'agent'} session` : 'terminal';
        const ok = await this.deps.notify.confirm(`Kill ${label}?`, 'The running process will be terminated. This cannot be undone.', 'Kill');
        if (ok === 'Kill') {
          await this.deps.terminals.closeTab(msg.worktreeId, msg.index).catch(() => {});
          await cmd('killWindow', { worktreeId: msg.worktreeId, windowIndex: msg.index }).catch(() => {});
        }
        return;
      }
      case 'dockerUp': case 'dockerDown': case 'reorderSessions': case 'setupAction': case 'refreshDrift': case 'forgetWorktree':
        await cmd('message', { message: msg });
        return;
      case 'reorderWorktrees':
        await cmd('message', { repo, message: msg });
        return;
      case 'deleteWorktree': return this.deleteWorktree(item && this.worktreeOf(item));
      case 'renameWorktree': return this.renameWorktree(item && this.worktreeOf(item));
      case 'initWorktree': return this.initWorktree(item && this.worktreeOf(item));
      case 'openDiff': this.ui.openDiffPanel(msg.worktreeId); return;
      case 'openNewTask': this.ui.openNewTask(); return;
      case 'createWorktree':
        await this.createWorktree({ branch: msg.branch, title: msg.title, description: msg.description, baseBranch: msg.baseBranch, provider: msg.provider });
        return;
      case 'listBranches': {
        const init = await this.fetchNewTaskInit().catch(() => undefined);
        if (init) { this.branchOptions = { branches: init.branches, base: init.baseBranch }; this.ui.pushWebview(); }
        return;
      }
      case 'renameSession': {
        const session = item?.sessions.find((s) => s.index === msg.index);
        if (!session) return;
        const name = await this.deps.host.showInputBox({ prompt: 'Name for this session', value: session.alias ?? session.name, placeHolder: 'e.g. redis' });
        if (name !== undefined) await cmd('renameSession', { worktreeId: msg.worktreeId, windowIndex: msg.index, name });
        return;
      }
      case 'openPort': await this.deps.host.openExternal(`http://localhost:${msg.port}`); return;
      case 'openPr': {
        const url = item?.pr?.url;
        if (url && /^https:\/\//.test(url)) await this.deps.host.openExternal(url);
        return;
      }
      case 'openTicket': {
        const url = item?.ticket?.url;
        if (url && /^https:\/\//.test(url)) await this.deps.host.openExternal(url);
        return;
      }
      case 'selectWorktree': return this.switchToWorktree(msg.worktreeId);
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private async ensureRepo(root: string): Promise<void> {
    this.repoAdded ??= this.deps.client.command('addRepo', { repo: root }).then(() => undefined, (e: unknown) => { this.repoAdded = undefined; throw e; });
    await this.repoAdded;
  }

  /** Asks the daemon to manage this window's repository (idempotent), and loads its state. */
  async start(): Promise<void> {
    const root = this.deps.repoRoot();
    if (root) await this.ensureRepo(root);
  }

  async handleAddedWorkspaceFolders(paths: string[]): Promise<void> {
    const root = this.deps.repoRoot();
    if (root && paths.some((p) => canonicalPath(p) === canonicalPath(root))) {
      this.repoAdded = undefined;
      await this.start();
    }
  }

  syncMainFolderLabel(): void {}
  syncDockerPolling(): void {}

  async createWorktree(opts?: {
    branch?: string; title?: string; description?: string; baseBranch?: string; provider?: ProviderId;
    silent?: boolean; ticket?: WorktreeTicket; select?: boolean;
  }): Promise<{ ok: boolean; error?: string; worktree?: Worktree }> {
    const fail = (error: string) => {
      if (!opts?.silent) this.deps.notify.showError(error);
      return { ok: false, error };
    };
    const root = this.deps.repoRoot();
    if (!root) return fail('No git repository found in workspace.');
    const branch = opts?.branch ?? (await this.deps.host.showInputBox({ prompt: 'Branch name', placeHolder: 'e.g. AS-7090-fix-payments' }));
    if (!branch) return { ok: false };
    try {
      await this.ensureRepo(root);
      const r = await this.deps.notify.withProgress(`Creating worktree "${branch}"`, () =>
        this.deps.client.command<{ worktree: Worktree }>('createTask', {
          repo: root, branch, title: opts?.title, description: opts?.description,
          baseBranch: opts?.baseBranch, provider: opts?.provider, ticket: opts?.ticket,
        }));
      if (opts?.select !== false) await this.selectWhenKnown(r.worktree.id);
      return { ok: true, worktree: r.worktree };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** The new worktree is what the user is about to work in: select it once the snapshot has it. */
  private async selectWhenKnown(id: string): Promise<void> {
    for (let i = 0; i < 40 && !this.item(id); i++) await new Promise((r) => setTimeout(r, 50));
    if (this.item(id)) await this.switchToWorktree(id);
  }

  async deleteWorktree(worktree?: { id: string }): Promise<void> {
    const item = this.item(this.resolveId(worktree));
    if (!item || item.isControl || item.deleting) return;
    if (item.isMain) {
      this.deps.notify.showWarning('Cannot delete the main worktree.');
      return;
    }
    // Fresh numbers: the card's can be minutes old, and this is the moment they decide whether work is thrown away.
    await this.deps.client.command('refreshGit', { worktreeId: item.id }).catch(() => {});
    const fresh = this.item(item.id) ?? item;
    const plan = planDelete(fresh.git, fresh.pr);
    const confirm = await this.deps.notify.confirm(`Delete worktree "${fresh.branch}"?`, plan.detail, ...plan.choices);
    if (!confirm) return;
    const deleteBranch = confirm !== plan.choices[plan.keepBranch];
    try {
      await this.deps.client.command('deleteTask', { worktreeId: item.id, deleteBranch });
    } catch (e) {
      this.deps.notify.showError(`Could not delete "${displayLabel(item)}": ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.deps.terminals.disposeAll(item.id);
    const idx = this.deps.host.workspaceFolderPaths().findIndex((p) => canonicalPath(p) === canonicalPath(item.path));
    if (idx !== -1) this.deps.host.removeWorkspaceFolder(idx);
    if (this.selected === item.id) this.setSelected(undefined);
    this.ui.pushWebview();
  }

  async renameWorktree(worktree?: { id: string }): Promise<void> {
    const item = this.item(this.resolveId(worktree));
    if (!item) return;
    const alias = await this.deps.host.showInputBox(item.isControl
      ? { prompt: 'Title for the control session', value: item.alias ?? 'Manager', placeHolder: 'Manager' }
      : { prompt: 'Description / alias for this worktree', value: item.alias ?? item.branch, placeHolder: 'e.g. Fix rate-limit bug on Shopify' });
    if (alias === undefined) return;
    await this.deps.client.command('renameTask', { worktreeId: item.id, alias });
    if (!item.isControl) {
      const idx = this.deps.host.workspaceFolderPaths().findIndex((p) => canonicalPath(p) === canonicalPath(item.path));
      if (idx !== -1) this.deps.host.renameWorkspaceFolder(idx, { path: item.path, name: truncateLabel(alias || item.branch) });
    }
  }

  async initWorktree(worktree?: { id: string }): Promise<void> {
    const id = this.resolveId(worktree);
    if (!id) return;
    await this.deps.client.command('initTask', { worktreeId: id }).catch((e: unknown) =>
      this.deps.notify.showError(e instanceof Error ? e.message : String(e)));
  }

  openTerminal(worktree?: { id: string }): void {
    const id = this.resolveId(worktree);
    if (!id) return;
    void this.deps.client.command<{ windowIndex?: number }>('spawnShell', { worktreeId: id })
      .then((r) => (r.windowIndex !== undefined ? this.openSessionLater(id, r.windowIndex) : undefined))
      .catch((e: unknown) => this.deps.notify.showError(`Failed to open a terminal: ${String(e)}`));
  }

  launchAgent(worktree?: { id: string }, provider?: ProviderId): void {
    const id = this.resolveId(worktree);
    if (!id) return;
    void this.deps.client.command<{ windowIndex?: number }>('spawnAgent', { worktreeId: id, provider })
      .then((r) => (r.windowIndex !== undefined ? this.openSessionLater(id, r.windowIndex) : undefined))
      .catch((e: unknown) => this.deps.notify.showError(`Failed to launch agent: ${String(e)}`));
  }

  async openSessionToSide(target?: { worktreeId: string; index?: number }): Promise<void> {
    const id = target?.worktreeId ?? this.selected;
    const item = this.item(id);
    const index = target?.index ?? this.deps.terminals.focusedWindow(id ?? '') ?? item?.sessions[0]?.index;
    if (!item || index === undefined) {
      this.deps.notify.showWarning('Stack: open a session first, then move it to the side.');
      return;
    }
    await this.openSession(item, index, { beside: true });
  }

  async attachDroppedFiles(paths: string[], targetId?: string, windowIndex?: number): Promise<void> {
    if (paths.length === 0) return;
    const worktrees = this.current()?.state.worktrees ?? [];
    const item = targetId ? this.item(targetId) : this.item(this.selected) ?? (worktrees.length === 1 ? worktrees[0] : undefined);
    if (!item) {
      this.deps.notify.showWarning('Stack: select a worktree first, then drop the image again.');
      return;
    }
    if (item.sessions.length === 0) {
      this.deps.notify.showWarning(`Stack: no agent session in ${item.alias ?? item.branch} — launch one, then drop the image again.`);
      return;
    }
    await this.switchToWorktree(item.id);
    await this.deps.client.command('paste', { worktreeId: item.id, text: paths.map((p) => `'${p}' `).join(''), windowIndex });
  }

  /** Where the focused terminal's worktree sits in the sidebar's order, moved by `direction`. */
  private cycle(direction: 1 | -1): void {
    const worktrees = this.current()?.state.worktrees ?? [];
    if (!worktrees.length) return;
    const owner = this.deps.terminals.targetOf(this.deps.host.activeTerminal() as never)?.worktreeId;
    const idx = worktrees.findIndex((w) => w.id === owner);
    const n = worktrees.length;
    const next = worktrees[(((idx + direction) % n) + n) % n];
    this.deps.terminals.current(next.id)?.show();
  }

  focusNextWorktree(): void { this.cycle(1); }
  focusPrevWorktree(): void { this.cycle(-1); }

  async focusNextAttention(): Promise<void> {
    const items = this.current()?.state.worktrees ?? [];
    const waiting = items.filter((w) => w.agent === 'permission' || w.agent === 'waiting')
      .sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
    if (waiting.length === 0) return;
    const at = waiting.findIndex((w) => w.id === this.selected);
    const next = waiting[(at + 1) % waiting.length];
    await this.switchToWorktree(next.id);
    if (next.agent === 'waiting') this.ui.openDiffPanel(next.id);
  }

  // ── Review panel (DiffPanelHost) ──────────────────────────────────────────

  async getDiff(worktreeId: string, base: DiffBase): Promise<string> {
    try {
      const r = await this.deps.client.command<{ unified: string }>('getDiff', { worktreeId, base });
      return r.unified;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const prefix = "couldn't compute the diff: ";
      throw m.startsWith(prefix) ? new DiffError(m.slice(prefix.length)) : e;
    }
  }

  getContext(worktreeId: string): { label: string; hasLiveAgent: boolean } | undefined {
    const item = this.item(worktreeId);
    return item && { label: displayLabel(item), hasLiveAgent: item.agentCount > 0 };
  }

  async send(worktreeId: string, destination: SendDestination, comments: DiffComment[]): Promise<SendDestination | false> {
    const prompt = buildCommentPrompt(comments);
    if (!prompt) return false;
    if (destination === 'clipboard') {
      await this.deps.host.writeClipboard(prompt);
      return 'clipboard';
    }
    const r = await this.deps.client.command<{ went: SendDestination | false }>('sendComments', { worktreeId, destination, comments });
    return r.went;
  }

  async openFile(worktreeId: string, relativePath: string, line?: number): Promise<void> {
    const item = this.item(worktreeId);
    if (item) await this.deps.host.openFileInEditor(path.join(item.path, relativePath), line);
  }

  // ── New-task panel ────────────────────────────────────────────────────────

  private async fetchNewTaskInit(): Promise<NewTaskInit> {
    const root = this.deps.repoRoot();
    if (!root) return { branches: [], baseBranch: 'main', sidebarStyle: this.deps.config.get().sidebarStyle, defaultProvider: 'claude', installedProviders: [] };
    await this.ensureRepo(root);
    return this.deps.client.command<NewTaskInit>('newTaskInit', { repo: root });
  }

  /** The panel's init is synchronous in the host interface; the branch list is what the daemon last told us (see refreshNewTask). */
  newTaskInit(): NewTaskInit {
    const config = this.deps.config.get();
    return {
      branches: this.branchOptions?.branches ?? [],
      baseBranch: this.branchOptions?.base ?? 'main',
      sidebarStyle: config.sidebarStyle,
      defaultProvider: config.defaultProvider,
      installedProviders: this.deps.installedProviders(config),
    };
  }

  /** Loads the branch list from the daemon, for the next newTaskInit(). */
  async refreshNewTask(): Promise<void> {
    const init = await this.fetchNewTaskInit();
    this.branchOptions = { branches: init.branches, base: init.baseBranch };
  }

  async confirmDiscardNewTask(): Promise<boolean> {
    const discard = 'Discard';
    return (await this.deps.notify.confirm('Discard this task?', 'The description you wrote will be lost.', discard)) === discard;
  }

  async showProviderInstall(provider: ProviderId): Promise<void> {
    const { label, install } = PROVIDER_INSTALL[provider];
    const copy = await this.deps.notify.confirm(`${label} is not on your PATH`, `Install it with:\n\n${install}`, 'Copy command');
    if (copy === 'Copy command') await this.deps.host.writeClipboard(install);
  }

  // ── Lookups for the extension's glue ──────────────────────────────────────

  hasSessions(worktreeId: string): boolean { return (this.item(worktreeId)?.sessions.length ?? 0) > 0; }
  pathOf(worktreeId: string): string | undefined { return this.item(worktreeId)?.path; }
  labelOf(worktreeId: string): string | undefined {
    const item = this.item(worktreeId);
    return item && (item.isControl ? 'Manager' : item.alias ?? item.branch);
  }
  sessionTitle(worktreeId: string, windowIndex: number): string | undefined {
    return this.item(worktreeId)?.sessions.find((s) => s.index === windowIndex)?.title;
  }
  async paste(worktreeId: string, text: string, windowIndex?: number): Promise<void> {
    await this.deps.client.command('paste', { worktreeId, text, windowIndex });
  }
}
