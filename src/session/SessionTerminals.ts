import * as vscode from 'vscode';
import { TmuxManager } from './TmuxManager';
import type { ISessionManager, TmuxClient } from '../ports/ISessionManager';
import type { Worktree } from '../types';

/**
 * How a worktree's sessions reach the editor (`stack.sessionTabs`).
 *
 * - `perSession`: every session (agent or shell) is a terminal tab of its own,
 *   so two of them can sit side by side, be dragged between editor groups and
 *   resized — all of it VS Code's own editor layout.
 * - `single`: one terminal per worktree attached to its tmux session; switching
 *   sessions switches the tmux window inside it. The behaviour before tabs.
 */
export type SessionTabsMode = 'perSession' | 'single';

/** What a Stack terminal shows: a worktree's whole session (the single viewer), or one window of it (a tab). */
export interface TerminalTarget {
  worktreeId: string;
  /** Set for a session tab; absent for the single-mode viewer. */
  windowIndex?: number;
}

/** What a tab says about its session. */
export interface TabInfo {
  /** The worktree's display label (displayLabel). */
  label: string;
  /** The session's name as the sidebar shows it: its alias, else the window name. */
  session: string;
  kind: 'agent' | 'shell';
}

/** A tab closed by closeAll (focus mode), to be reopened where it was. */
export interface ParkedTab {
  index: number;
  viewColumn?: number;
}

/** Between a worktree label and the session name in a tab title. */
export const TAB_SEPARATOR = ' · ';

/**
 * Every VS Code terminal Stack shows, and the tmux sessions behind them.
 *
 * Kept apart from AgentSessionManager, which tracks what runs in the tmux
 * windows: this tracks what is on screen. A worktree has either one viewer
 * (single mode) or one tab per session (perSession) — see SessionTabsMode —
 * and the rest of the extension asks this class which worktree and session a
 * terminal belongs to, instead of assuming there is one terminal per worktree.
 */
export class SessionTerminals implements vscode.Disposable {
  /** worktreeId → the single-mode viewer, attached to the worktree's session itself. */
  private viewers = new Map<string, vscode.Terminal>();
  /** worktreeId → (window index → the tab attached to that window's view session). */
  private tabs = new Map<string, Map<number, vscode.Terminal>>();
  /** Tabs being created, so two quick requests for one session cannot make two. */
  private opening = new Map<string, Promise<vscode.Terminal>>();
  /** worktreeId → the window of the tab the user was last in. */
  private lastFocused = new Map<string, number>();
  /** worktreeId → tabs focus mode closed, reopened by reopenParked. */
  private parked = new Map<string, ParkedTab[]>();
  /** tmux base session name → worktreeId, for reading a terminal's attach target back. */
  private known = new Map<string, string>();
  private subscriptions: vscode.Disposable[];

  constructor(
    private tmux: ISessionManager,
    private pathExists: (p: string) => boolean,
    /** How long to wait for a terminal's tmux client to exit before disposing it anyway. */
    private exitDeadlineMs = 400,
  ) {
    this.subscriptions = [
      vscode.window.onDidCloseTerminal((terminal) => this.forget(terminal)),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        const target = terminal && this.targetOf(terminal);
        if (target?.windowIndex !== undefined) this.lastFocused.set(target.worktreeId, target.windowIndex);
      }),
      // Terminals VS Code brings back after reconnect() ran — a restart revives
      // them by re-running their command, which can come after activation.
      vscode.window.onDidOpenTerminal((terminal) => void this.claimOne(terminal, () => this.clients()).catch(() => {})),
    ];
  }

  // ── Lookups ─────────────────────────────────────────────────────────────

  private live(terminal: vscode.Terminal | undefined): vscode.Terminal | undefined {
    return terminal && terminal.exitStatus === undefined ? terminal : undefined;
  }

  viewer(worktreeId: string): vscode.Terminal | undefined {
    return this.live(this.viewers.get(worktreeId));
  }

  tab(worktreeId: string, windowIndex: number): vscode.Terminal | undefined {
    return this.live(this.tabs.get(worktreeId)?.get(windowIndex));
  }

  /** Live tabs of a worktree, by window index. */
  private liveTabs(worktreeId: string): Array<[number, vscode.Terminal]> {
    return [...(this.tabs.get(worktreeId) ?? new Map<number, vscode.Terminal>()).entries()]
      .filter(([, t]) => t.exitStatus === undefined);
  }

  /**
   * The worktree's terminal to bring forward when "the worktree" is what is
   * asked for (switching to it, the card's focus): the tab the user was last
   * in, else any of its tabs, else its single viewer.
   */
  current(worktreeId: string): vscode.Terminal | undefined {
    const last = this.lastFocused.get(worktreeId);
    return (last !== undefined ? this.tab(worktreeId, last) : undefined)
      ?? this.liveTabs(worktreeId)[0]?.[1]
      ?? this.viewer(worktreeId);
  }

  /** The window behind current(), when that is a tab. */
  focusedWindow(worktreeId: string): number | undefined {
    const terminal = this.current(worktreeId);
    return terminal ? this.targetOf(terminal)?.windowIndex : undefined;
  }

  /** The window the user was last in, whether or not its tab is still open. */
  lastFocusedWindow(worktreeId: string): number | undefined {
    return this.lastFocused.get(worktreeId);
  }

  targetOf(terminal: vscode.Terminal): TerminalTarget | undefined {
    for (const [worktreeId, viewer] of this.viewers) {
      if (viewer === terminal) return { worktreeId };
    }
    for (const [worktreeId, byIndex] of this.tabs) {
      for (const [windowIndex, tab] of byIndex) {
        if (tab === terminal) return { worktreeId, windowIndex };
      }
    }
    return undefined;
  }

  /**
   * Same lookup by the terminal's NAME. Tab inputs for terminals are opaque
   * (TabInputTerminal exposes nothing), so a tab can only be matched to its
   * terminal through the label VS Code shows, which is the terminal's name —
   * kept unique among Stack's terminals for exactly this (see uniqueName).
   */
  targetOfName(name: string): TerminalTarget | undefined {
    for (const [worktreeId, viewer] of this.viewers) {
      if (viewer.name === name) return { worktreeId };
    }
    for (const [worktreeId, byIndex] of this.tabs) {
      for (const [windowIndex, tab] of byIndex) {
        if (tab.name === name) return { worktreeId, windowIndex };
      }
    }
    return undefined;
  }

  // ── Opening ─────────────────────────────────────────────────────────────

  /**
   * The cwd a terminal is launched in. If the worktree directory is gone,
   * none: the terminal can still attach to a running session instead of
   * failing to launch with "Starting directory (cwd) does not exist".
   */
  private cwdFor(worktree: Worktree, name: string): string | undefined {
    const exists = this.pathExists(worktree.path);
    console.log(`[stack] open viewer id=${worktree.id} name="${name}" path=${worktree.path} exists=${exists}`);
    if (!exists) console.warn(`[stack] worktree directory missing, attaching viewer without cwd: ${worktree.path}`);
    return exists ? worktree.path : undefined;
  }

  /**
   * The single-mode viewer: one terminal attached to the worktree's session.
   * Creates one if the previous one was closed. Assumes the session exists.
   *
   * Runs tmux directly — no `/bin/sh -c` around it, and no `exec $SHELL`
   * fallback: when tmux detaches, the terminal's process exits cleanly, which
   * lets it be disposed without the "terminate processes?" dialog.
   */
  openViewer(worktree: Worktree, name: string, location: vscode.TerminalOptions['location'] = vscode.TerminalLocation.Editor): vscode.Terminal {
    const existing = this.viewer(worktree.id);
    if (existing) return existing;
    const base = TmuxManager.sessionName(worktree.id);
    this.known.set(base, worktree.id);
    const terminal = vscode.window.createTerminal({
      name,
      cwd: this.cwdFor(worktree, name),
      location,
      shellPath: 'tmux',
      shellArgs: TmuxManager.attachArgs(base),
    });
    this.viewers.set(worktree.id, terminal);
    return terminal;
  }

  /**
   * The tab of one session, created when it has none — in the active editor
   * group, or beside it. `beside` moves an open tab: it is closed and opened
   * again next to the active group, since VS Code has no API to move a
   * terminal editor, and a `ViewColumn` is the one placement it promises.
   */
  async openTab(
    worktree: Worktree,
    windowIndex: number,
    info: TabInfo,
    opts: { beside?: boolean; viewColumn?: number } = {},
  ): Promise<vscode.Terminal> {
    const key = `${worktree.id}:${windowIndex}`;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const existing = this.tab(worktree.id, windowIndex);
    if (existing && !opts.beside) {
      this.lastFocused.set(worktree.id, windowIndex);
      return existing;
    }
    const opened = this.createTab(worktree, windowIndex, info, opts, existing).finally(() => this.opening.delete(key));
    this.opening.set(key, opened);
    return opened;
  }

  private async createTab(
    worktree: Worktree,
    windowIndex: number,
    info: TabInfo,
    opts: { beside?: boolean; viewColumn?: number },
    existing: vscode.Terminal | undefined,
  ): Promise<vscode.Terminal> {
    if (existing) await this.closeTab(worktree.id, windowIndex);
    const base = TmuxManager.sessionName(worktree.id);
    this.known.set(base, worktree.id);
    const name = this.uniqueName(`${info.label}${TAB_SEPARATOR}${info.session}`);
    const location: vscode.TerminalOptions['location'] = opts.beside
      ? { viewColumn: vscode.ViewColumn.Beside }
      : opts.viewColumn !== undefined
        ? { viewColumn: opts.viewColumn }
        : vscode.TerminalLocation.Editor;
    const terminal = vscode.window.createTerminal({
      name,
      cwd: this.cwdFor(worktree, name),
      location,
      iconPath: new vscode.ThemeIcon(info.kind === 'agent' ? 'hubot' : 'terminal'),
      shellPath: 'tmux',
      shellArgs: TmuxManager.viewAttachArgs(base, windowIndex),
    });
    const byIndex = this.tabs.get(worktree.id) ?? new Map<number, vscode.Terminal>();
    byIndex.set(windowIndex, terminal);
    this.tabs.set(worktree.id, byIndex);
    this.lastFocused.set(worktree.id, windowIndex);
    return terminal;
  }

  /** `name`, or `name 2`, `name 3`… — whichever no other Stack terminal carries. */
  private uniqueName(name: string): string {
    const taken = new Set(
      [...this.viewers.values(), ...[...this.tabs.values()].flatMap((m) => [...m.values()])]
        .filter((t) => t.exitStatus === undefined)
        .map((t) => t.name),
    );
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name} ${n}`)) n++;
    return `${name} ${n}`;
  }

  // ── Closing ─────────────────────────────────────────────────────────────

  /** Resolves once the terminal's process has exited, or after exitDeadlineMs. */
  private waitForExit(terminal: vscode.Terminal): Promise<void> {
    return new Promise<void>((resolve) => {
      const deadline = Date.now() + this.exitDeadlineMs;
      const poll = () => {
        if (terminal.exitStatus !== undefined || Date.now() > deadline) resolve();
        else setTimeout(poll, 30);
      };
      poll();
    });
  }

  /**
   * Close one session's tab; the session itself keeps running in the base.
   *
   * The view session is killed first: its tmux client then exits cleanly and
   * the terminal can be disposed without VS Code asking whether to terminate
   * a running process. It leaves the map BEFORE that, so the close event of
   * this terminal can never be mistaken for a tab opened in its place.
   */
  async closeTab(worktreeId: string, windowIndex: number): Promise<void> {
    const terminal = this.tabs.get(worktreeId)?.get(windowIndex);
    if (!terminal) return;
    this.tabs.get(worktreeId)!.delete(windowIndex);
    if (terminal.exitStatus !== undefined) return;
    await this.tmux.killSession(TmuxManager.viewSessionName(TmuxManager.sessionName(worktreeId), windowIndex));
    await this.waitForExit(terminal);
    terminal.dispose();
  }

  /** Close the tabs of windows that no longer exist. */
  async closeTabsExcept(worktreeId: string, windowIndexes: ReadonlySet<number>): Promise<void> {
    for (const [index] of [...(this.tabs.get(worktreeId) ?? new Map<number, vscode.Terminal>())]) {
      if (!windowIndexes.has(index)) await this.closeTab(worktreeId, index);
    }
  }

  /**
   * Take every terminal of a worktree off screen; its sessions keep running.
   * Tabs are remembered with the editor group they sat in, so the worktree
   * comes back laid out the way it was (reopenParked).
   */
  async closeAll(worktreeId: string): Promise<void> {
    const tabs = this.liveTabs(worktreeId);
    if (tabs.length > 0) {
      const focused = this.lastFocused.get(worktreeId);
      // The focused one last, so reopening it last leaves it in front.
      const ordered = [...tabs.filter(([i]) => i !== focused), ...tabs.filter(([i]) => i === focused)];
      this.parked.set(worktreeId, ordered.map(([index, terminal]) => ({ index, viewColumn: this.viewColumnOf(terminal) })));
      await Promise.all(tabs.map(([index]) => this.closeTab(worktreeId, index)));
    }
    await this.closeViewer(worktreeId);
  }

  /** The editor group a terminal sits in, found through the tab that carries its name. */
  private viewColumnOf(terminal: vscode.Terminal): number | undefined {
    return vscode.window.tabGroups.all.find((group) =>
      group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal && tab.label === terminal.name),
    )?.viewColumn;
  }

  /** Tabs closeAll put away for this worktree, now handed back (and forgotten). */
  takeParked(worktreeId: string): ParkedTab[] {
    const parked = this.parked.get(worktreeId) ?? [];
    this.parked.delete(worktreeId);
    return parked;
  }

  /**
   * Detach all tmux clients from a worktree's session, then dispose the
   * viewer. The tmux SESSION keeps running. The client exits cleanly after
   * the detach, so VS Code won't show the "terminate running processes?" dialog.
   */
  async closeViewer(worktreeId: string): Promise<void> {
    const viewer = this.viewers.get(worktreeId);
    if (!viewer || viewer.exitStatus !== undefined) return;
    await this.tmux.detachClients(TmuxManager.sessionName(worktreeId));
    await this.waitForExit(viewer);
    viewer.dispose();
    this.viewers.delete(worktreeId);
  }

  /** The worktree's tmux session is being killed: drop every terminal without a word to tmux. */
  disposeAll(worktreeId: string): void {
    this.viewers.get(worktreeId)?.dispose();
    this.viewers.delete(worktreeId);
    for (const terminal of this.tabs.get(worktreeId)?.values() ?? []) terminal.dispose();
    this.tabs.delete(worktreeId);
    this.parked.delete(worktreeId);
    this.lastFocused.delete(worktreeId);
  }

  /**
   * A terminal closed — by the user, by its process exiting, by us. Only the
   * bookkeeping goes: the view session behind a tab dies with its last client
   * (destroy-unattached), and is not killed here because another VS Code
   * window may be showing the same session through it.
   */
  private forget(terminal: vscode.Terminal): void {
    const target = this.targetOf(terminal);
    if (!target) return;
    if (target.windowIndex === undefined) this.viewers.delete(target.worktreeId);
    else this.tabs.get(target.worktreeId)?.delete(target.windowIndex);
  }

  // ── Reload ──────────────────────────────────────────────────────────────

  /**
   * Take back the terminals VS Code restored after a reload, so they are
   * reused rather than duplicated, and closed when focus mode says so.
   *
   * By what the terminal is attached to, exactly: its launch argv names the
   * tmux session, and failing that its process is a tmux client whose session
   * tmux reports. Only an old viewer that neither can place falls back to its
   * name — anchored at the separator: matching a bare prefix of the label let
   * the worktree "feat" take "feat-login"'s terminal.
   */
  async claim(worktrees: Worktree[], labelOf: (wt: Worktree) => string): Promise<void> {
    for (const wt of worktrees) this.known.set(TmuxManager.sessionName(wt.id), wt.id);
    let clients: Promise<TmuxClient[]> | undefined;
    const lazyClients = () => (clients ??= this.tmux.listClients().catch(() => []));
    for (const terminal of vscode.window.terminals) {
      if (await this.claimOne(terminal, lazyClients)) continue;
      if (terminal.exitStatus !== undefined || this.targetOf(terminal)) continue;
      const wt = worktrees.find((w) => {
        const label = labelOf(w);
        return terminal.name === label || terminal.name.startsWith(`${label} — `);
      });
      if (wt && !this.viewer(wt.id)) this.viewers.set(wt.id, terminal);
    }
    const active = vscode.window.activeTerminal && this.targetOf(vscode.window.activeTerminal);
    if (active?.windowIndex !== undefined) this.lastFocused.set(active.worktreeId, active.windowIndex);
  }

  /** Claim one terminal by what it is attached to. True when it is (now) Stack's. */
  private async claimOne(terminal: vscode.Terminal, clients: () => Promise<TmuxClient[]>): Promise<boolean> {
    if (terminal.exitStatus !== undefined) return false;
    if (this.targetOf(terminal)) return true;
    const options = terminal.creationOptions as vscode.TerminalOptions;
    let session = TmuxManager.sessionOfAttachArgs(options?.shellArgs);
    if (!session) {
      const pid = await withTimeout(terminal.processId, 1_000);
      if (pid !== undefined) session = (await clients()).find((c) => c.pid === pid)?.session;
    }
    if (!session || this.targetOf(terminal)) return false;
    // A terminal from before the rename names the `foreman-` session that
    // reconnect() has just renamed to `stack-`, still attached.
    session = TmuxManager.currentSessionName(session);
    const view = TmuxManager.parseViewSessionName(session);
    const worktreeId = this.known.get(view?.base ?? session);
    if (!worktreeId) return false;
    if (!view) {
      if (this.viewer(worktreeId)) return false;
      this.viewers.set(worktreeId, terminal);
      return true;
    }
    if (this.tab(worktreeId, view.windowIndex)) return false;
    const byIndex = this.tabs.get(worktreeId) ?? new Map<number, vscode.Terminal>();
    byIndex.set(view.windowIndex, terminal);
    this.tabs.set(worktreeId, byIndex);
    return true;
  }

  private clients(): Promise<TmuxClient[]> {
    return this.tmux.listClients().catch(() => []);
  }

  /**
   * Kill view sessions nobody is looking at, and those whose worktree session
   * is gone. destroy-unattached normally takes a view with its last client;
   * this catches the ones it could not (a client killed before the option was
   * set, a base killed from outside Stack) so they do not pile up — an
   * orphaned view would also keep the windows it shared with its base alive.
   */
  async pruneViews(): Promise<void> {
    const sessions = await this.tmux.listSessions().catch(() => []);
    const names = new Set(sessions.map((s) => s.name));
    for (const s of sessions) {
      const view = TmuxManager.parseViewSessionName(s.name);
      if (!view) continue;
      if (s.attached === 0 || !names.has(view.base)) await this.tmux.killSession(s.name);
    }
  }

  /** Kill a worktree's view sessions — before its base, whose windows they would otherwise keep alive. */
  async killViews(worktreeId: string): Promise<void> {
    const base = TmuxManager.sessionName(worktreeId);
    for (const s of await this.tmux.listSessions().catch(() => [])) {
      if (TmuxManager.parseViewSessionName(s.name)?.base === base) await this.tmux.killSession(s.name);
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}

/** A thenable's value, or undefined if it takes longer than `ms` (or fails). */
async function withTimeout<T>(value: Thenable<T> | undefined, ms: number): Promise<T | undefined> {
  if (!value) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  try {
    return await Promise.race([Promise.resolve(value).catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
