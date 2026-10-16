import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { AgentSessionState, Worktree } from '../types';
import { TmuxManager } from './TmuxManager';
import { SessionTerminals } from './SessionTerminals';
import type { SessionTabsMode, TerminalTarget } from './SessionTerminals';
import type { ISessionManager, TmuxWindow } from '../ports/ISessionManager';
import type { ProviderId } from '../ports/IAgentProvider';
import { isAgentWindowName, providerForWindowName } from '../ports/IAgentProvider';
import type { ProviderFactory } from '../providers/ProviderFactory';
import type { SessionItem } from '../webview/types';
import { displayLabel } from '../worktree/displayLabel';

type WindowMeta = {
  kind: 'agent' | 'shell';
  /** Which agent runs in this window (only for kind 'agent'). */
  provider?: ProviderId;
  state: AgentSessionState;
  name: string;
  /** Live task title published by the agent through the terminal title (OSC → tmux pane_title). */
  title?: string;
  /** A hook event has arrived from this window: the agent is initialised and listening. */
  hookSeen?: boolean;
  /**
   * What the agent said when it asked for the user (a notification's message,
   * or the command awaiting permission). Kept only while the window is in
   * `permission` or `waiting`; see updateState.
   */
  attention?: string;
  /** `attention` came from a permission request, which names the command and so outranks a notification's prose. */
  attentionFromRequest?: boolean;
};

/**
 * Commands a freshly respawned agent window reports while it is NOT yet the
 * agent: `sh` runs the launch line, and the trailing `exec $SHELL` takes over
 * again if the agent binary is missing or exits at once.
 */
const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);

/**
 * "Bash: <command>" for a permission request that runs a command, "<Tool>: <file>"
 * for one that touches a file; undefined when the payload says neither.
 */
function requestSummary(payload: Record<string, unknown> | undefined): string | undefined {
  const tool = payload?.['tool_name'];
  const input = payload?.['tool_input'];
  if (typeof tool !== 'string' || !input || typeof input !== 'object') return undefined;
  const { command, file_path: file } = input as Record<string, unknown>;
  if (typeof command === 'string' && command.trim()) return `${tool}: ${command.trim()}`;
  return typeof file === 'string' && file ? `${tool}: ${file}` : undefined;
}

export class AgentSessionManager {
  // worktreeId → (tmux window index → metadata)
  private windows = new Map<string, Map<number, WindowMeta>>();
  /** The VS Code terminals showing those windows — one per worktree, or one per session. */
  private terminals: SessionTerminals;

  private stateChangeEmitter = new vscode.EventEmitter<{
    worktreeId: string;
    state: AgentSessionState;
    /** tmux window that triggered the change (hook events only). */
    windowIndex?: number;
  }>();
  private terminalsChangeEmitter = new vscode.EventEmitter<void>();
  // worktreeId → pending debounced title refresh
  private titleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Single timer that keeps shell rows current, and agent rows honest.
   *
   * syncWindows is otherwise only reached from a hook event, which is an
   * AGENT's heartbeat — so a shell in a worktree with no agent running would
   * have been labelled once and then frozen, which is most of the time you have
   * a shell open; and an agent that died without a last hook would have been
   * "working" forever. One interval for all worktrees rather than one each,
   * and it only exists while some worktree needs it (see needsPolling).
   */
  private shellTimer?: ReturnType<typeof setInterval>;

  readonly onStateChange = this.stateChangeEmitter.event;
  readonly onTerminalsChange = this.terminalsChangeEmitter.event;

  // Persists the last-known aggregate state per worktree so a VSCode reload can
  // restore "needs attention" / "waiting" instead of blindly defaulting to waiting.
  private static readonly STATE_KEY = 'stack.claudeStates';
  // Persists a user-chosen display order (list of tmux window indexes) per
  // worktree. Purely cosmetic — tmux window indexes stay put so state tracking,
  // kill and focus keep working; only getSessions() sorts by this.
  private static readonly ORDER_KEY = 'stack.sessionOrder';

  /**
   * User-chosen names for sessions, worktreeId → (window index → name).
   *
   * Kept here rather than in the tmux window name, which looks like the obvious
   * place and is a trap: providerForWindowName() identifies an agent BY that
   * name, so renaming a "claude" window would bring it back as an unrecognised
   * shell after a reload, and calling a shell "claude" would have it adopted as
   * an agent. The window name says what is running; this says what the user
   * calls it.
   */
  private static readonly ALIAS_KEY = 'stack.sessionAliases';
  // worktreeId → ordered tmux window indexes (display order)
  private orders = new Map<string, number[]>();

  // worktreeId → (tmux window index → user-chosen name)
  private aliases = new Map<string, Map<number, string>>();

  constructor(
    private providers: ProviderFactory,
    private globalState: vscode.Memento,
    private tmux: ISessionManager = new TmuxManager(),
    private pathExists: (p: string) => boolean = (p) => fs.existsSync(p),
    private hostname: string = os.hostname(),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /**
     * Read on every use, so changing `stack.sessionTabs` applies to the next
     * terminal opened without a reload. Defaults to the one-terminal mode that
     * predates the setting; extension.ts passes the setting itself.
     */
    private sessionTabs: () => SessionTabsMode = () => 'single',
  ) {
    this.terminals = new SessionTerminals(tmux, pathExists);

    const savedOrders = this.globalState.get<Record<string, number[]>>(AgentSessionManager.ORDER_KEY, {});
    for (const [id, arr] of Object.entries(savedOrders)) this.orders.set(id, arr);

    const savedAliases = this.globalState.get<Record<string, Record<string, string>>>(
      AgentSessionManager.ALIAS_KEY, {},
    );
    for (const [id, byIndex] of Object.entries(savedAliases)) {
      this.aliases.set(id, new Map(Object.entries(byIndex).map(([i, name]) => [Number(i), name])));
    }
  }



  // ── Private helpers ──────────────────────────────────────────────────────

  /** Persist the per-window agent states for a worktree (survives reload). */
  private persistState(worktreeId: string): void {
    const stored = this.globalState.get<Record<string, unknown>>(AgentSessionManager.STATE_KEY, {});
    const states: Record<number, AgentSessionState> = {};
    for (const [idx, meta] of this.windows.get(worktreeId) ?? new Map<number, WindowMeta>()) {
      if (meta.kind === 'agent') states[idx] = meta.state;
    }
    stored[worktreeId] = states;
    this.globalState.update(AgentSessionManager.STATE_KEY, stored);
  }

  /**
   * Read the persisted state for one window of a worktree. Pre-per-window
   * versions stored a single aggregate string — apply it to every window.
   */
  private persistedState(worktreeId: string, windowIndex: number): AgentSessionState | undefined {
    const entry = this.globalState.get<Record<string, unknown>>(AgentSessionManager.STATE_KEY, {})[worktreeId];
    if (typeof entry === 'string') return entry as AgentSessionState;
    return (entry as Record<number, AgentSessionState> | undefined)?.[windowIndex];
  }

  /**
   * Display label for a terminal tab, capped by the shared helper.
   *
   * This must stay the single source of the label: reconnect() falls back to
   * reclaiming an old viewer terminal by this label, so capping anywhere else
   * would silently break that match.
   */
  private label(worktree: Worktree): string {
    return displayLabel(worktree);
  }

  private windowMap(worktreeId: string): Map<number, WindowMeta> {
    if (!this.windows.has(worktreeId)) this.windows.set(worktreeId, new Map());
    return this.windows.get(worktreeId)!;
  }

  /**
   * Normalize a tmux pane title into a displayable session title. Claude Code
   * prefixes its live status with spinner glyphs (braille dots, ✳, ·) — strip
   * them, and drop titles that carry no information (empty, the window name,
   * or the default hostname a fresh shell reports).
   */
  private cleanTitle(raw: string | undefined, windowName: string): string | undefined {
    if (!raw) return undefined;
    const title = raw.replace(/^[\s✳✻✶·•*⠀-⣿]+/u, '').trim();
    if (!title) return undefined;
    if (title === windowName) return undefined;
    if (title === 'Claude Code') return undefined; // product default before a task summary exists
    if (title.toLowerCase() === this.hostname.toLowerCase()) return undefined;
    return title;
  }

  /**
   * Subtitle for a shell window: whatever it is busy running.
   *
   * The same slot the agents use for their live task, so a shell reads
   * "shell / npm" the way an agent reads "claude / Investigating the Slack bug".
   *
   * `pane_current_command` is the process in the pane right now, so a shell
   * sitting at its prompt reports the shell itself — which is the row's name
   * already and says nothing. Those are dropped rather than echoed. Login shells
   * arrive as "-zsh", hence the leading dash.
   *
   * Deliberately not the *last* command: tmux does not record one, and getting
   * it would mean a hook in the user's shell rc — which in this project has
   * form, a .zshrc hook being what once deleted worktrees behind everyone's
   * back. What is running now is free and answers the same question while it
   * matters.
   */
  private commandTitle(command: string | undefined): string | undefined {
    if (!command) return undefined;
    const name = command.replace(/^-/, '').trim();
    if (!name) return undefined;
    return AgentSessionManager.SHELLS.has(name.toLowerCase()) ? undefined : name;
  }

  /** Programs that ARE the shell, so naming them tells the user nothing. */
  private static readonly SHELLS = new Set([
    'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash', 'nu', 'xonsh',
    // Wrappers that show up in a pane running an interactive shell.
    'login', 'tmux', 'screen', 'reattach-to-user-namespace',
  ]);

  /**
   * Reconcile a worktree's session list against what tmux actually has.
   *
   * The window map used to be written only when Stack itself acted — launch,
   * openTerminal, killWindow — so everything else that happens to a window was
   * invisible: a window the user closed with `exit` stayed on the card forever
   * as a session that could not be focused or killed, and an agent started in a
   * window Stack never opened did not exist at all.
   *
   * Deliberately conservative in what it adopts: only windows whose name
   * identifies a provider. Adopting every unknown window would surface the
   * session's own initial shell (window 0, an artefact of `new-session`) as a
   * session row nobody asked for.
   *
   * With `liveness`, also notices agents that are gone (see agentLiveness).
   * State otherwise only moves on hook events, and some exits send none — a
   * SIGKILL, a crash, Codex (which has no SessionEnd) — so such a session sat
   * on "working" or "permission" forever. The poller asks for it; hook-driven
   * calls do not, an agent that just sent a hook being alive by definition.
   */
  async syncWindows(worktreeId: string, opts?: { liveness?: boolean }): Promise<void> {
    const map = this.windows.get(worktreeId);
    if (!map) return;
    // What the map held when we asked tmux. Anything launched, killed or
    // repainted while the answer was on its way is newer than the answer, and
    // must not be pruned or condemned on its strength: a launch that lands
    // between list-windows and here is not in the list yet, and is not gone.
    const before = new Map(map);
    const tmuxWindows = await this.tmux.listWindows(TmuxManager.sessionName(worktreeId));
    // An empty list means tmux failed or the session is gone — both return []
    // from listWindows. Pruning on that would wipe every session on a transient
    // error, so treat it as "no information" rather than "nothing is there".
    if (tmuxWindows.length === 0) return;
    if (this.windows.get(worktreeId) !== map) return; // the session was killed meanwhile

    let changed = false;
    let stateChanged = false;
    const live = new Set(tmuxWindows.map((w) => w.index));
    const unchanged = (index: number) => map.has(index) && map.get(index) === before.get(index);

    for (const index of [...map.keys()]) {
      if (!live.has(index) && unchanged(index)) {
        map.delete(index);
        // The name goes with the window. tmux reuses indexes, so leaving it
        // behind would hang "redis" on whatever opens next in that slot.
        this.forgetAlias(worktreeId, index);
        // Its tab too. Usually gone already — the window's death ended its
        // view, and the view's client with it — but whether VS Code closed the
        // terminal on that exit is VS Code's business; this makes sure.
        this.terminals.closeTab(worktreeId, index).catch(() => {});
        changed = true;
      }
    }

    if (opts?.liveness) {
      for (const w of tmuxWindows) {
        const meta = map.get(w.index);
        if (meta?.kind !== 'agent' || meta.state === 'terminated' || !unchanged(w.index)) continue;
        if ((await this.agentLiveness(w)) !== 'dead' || !unchanged(w.index)) continue;
        stateChanged = this.markTerminated(worktreeId, w.index) || stateChanged;
      }
    }

    for (const w of tmuxWindows) {
      let meta = map.get(w.index);
      if (!meta) {
        const provider = providerForWindowName(w.name);
        if (!provider) continue; // not ours to adopt
        meta = { kind: 'agent', provider, state: 'waiting', name: w.name };
        map.set(w.index, meta);
        changed = true;
      }
      const title = meta.kind === 'agent'
        ? this.cleanTitle(w.title, meta.name)
        : this.commandTitle(w.command);
      if (title !== meta.title) {
        map.set(w.index, { ...meta, title });
        changed = true;
      }
    }

    if (stateChanged) {
      this.stateChangeEmitter.fire({ worktreeId, state: this.aggregateState(worktreeId) });
    }
    if (changed || stateChanged) {
      this.persistState(worktreeId);
      this.syncShellPolling();
      this.terminalsChangeEmitter.fire();
    }
  }

  /** @deprecated Kept as the old name; syncWindows does this and more. */
  async refreshTitles(worktreeId: string): Promise<void> {
    return this.syncWindows(worktreeId);
  }


  /**
   * Debounced second look at the pane titles — Claude Code often rewrites the
   * title (e.g. "Wants to run Bash: …") right AFTER the hook event arrives, so
   * the immediate refresh in updateState can be one beat too early.
   */
  private scheduleTitleRefresh(worktreeId: string): void {
    const pending = this.titleTimers.get(worktreeId);
    if (pending) clearTimeout(pending);
    this.titleTimers.set(worktreeId, setTimeout(() => {
      this.titleTimers.delete(worktreeId);
      this.refreshTitles(worktreeId).catch(() => {});
    }, 800));
  }

  /**
   * Starts or stops the poller to match whether anything needs it.
   *
   * Called wherever the window map changes. Idempotent, and a no-op in the
   * common case — an extra `tmux list-windows` every two seconds is worth it
   * for a label that moves or an agent that may have died, and worth nothing
   * at all when there is neither, which is why it is not simply always on.
   */
  private syncShellPolling(): void {
    const wanted = [...this.windows.values()].some((map) => this.needsPolling(map));

    if (!wanted) {
      if (this.shellTimer) { clearInterval(this.shellTimer); this.shellTimer = undefined; }
      return;
    }
    if (this.shellTimer) return;
    this.shellTimer = setInterval(() => {
      for (const [worktreeId, map] of this.windows.entries()) {
        if (!this.needsPolling(map)) continue;
        // Failures are ignored on purpose: a tmux hiccup should leave the last
        // known label on screen rather than blanking the row.
        this.syncWindows(worktreeId, { liveness: true }).catch(() => {});
      }
    }, AgentSessionManager.SHELL_POLL_MS);
  }

  /**
   * A shell, for its label — or an agent not yet known to be gone, for its
   * liveness: hooks say when an agent changes state, but not always when it
   * dies, and an exit nobody reports would otherwise leave it "working"
   * forever. Once every agent is terminated and no shell is open, nothing on
   * the card can change without Stack doing it, and the poller stops.
   */
  private needsPolling(map: Map<number, WindowMeta>): boolean {
    return [...map.values()].some((w) => w.kind === 'shell' || w.state !== 'terminated');
  }

  /**
   * Two seconds. Fast enough that starting a build labels the row while you are
   * still looking at it, slow enough to stay far below the docker poller's
   * 20s-per-project load. syncWindows only touches the UI when something
   * actually changed, so a quiet shell costs one exec and no re-render.
   */
  private static readonly SHELL_POLL_MS = 2_000;

  /** How long to wait for a respawned window to be running the agent itself. */
  private static readonly AGENT_START_TIMEOUT_MS = 10_000;

  private static readonly AGENT_START_POLL_MS = 150;
  /** How long a launch waits for the agent's first hook before pasting anyway. */
  private static readonly AGENT_READY_TIMEOUT_MS = 6_000;
  /** Launches waiting on a window's first hook event, keyed `worktreeId:windowIndex`. */
  private readyWaiters = new Map<string, () => void>();

  /**
   * SessionStart is sent from the agent's startup, not from its input box:
   * Claude Code fires it while the TUI is still coming up. A beat after it,
   * the box is there to paste into.
   */
  private static readonly INPUT_READY_SETTLE_MS = 500;
  /**
   * Between pasting and pressing Enter. The agent takes a bracketed paste in
   * asynchronously — Claude Code folds a large one into "[Pasted text #1 +N
   * lines]" — and an Enter that lands meanwhile is absorbed into the paste
   * instead of submitting it. A constant, not something measured: the retry
   * below is what covers a paste that takes longer.
   */
  private static readonly PASTE_SETTLE_MS = 250;
  /** How long to wait for the agent to confirm a submit before pressing Enter again. */
  private static readonly SUBMIT_ACK_TIMEOUT_MS = 2_000;
  /** Enters pressed after the first one, at most, when no confirmation comes. */
  private static readonly SUBMIT_RETRIES = 2;
  /**
   * Providers whose hook fires on submit: UserPromptSubmit, which HookServer
   * maps to 'active' (see ClaudeHookInstaller / CodexHookInstaller). opencode's
   * plugin has no submit event — only a reply to a permission — so it cannot
   * acknowledge one.
   */
  private static readonly SUBMIT_ACK_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['claude', 'codex']);
  /** Prompt submissions waiting on their window's next hook event, keyed `worktreeId:windowIndex`. */
  private submitWaiters = new Map<string, Set<(state: AgentSessionState) => void>>();

  private aggregateState(worktreeId: string): AgentSessionState {
    const states = [...(this.windows.get(worktreeId) ?? new Map()).values()]
      .filter(w => w.kind === 'agent')
      .map(w => w.state);
    if (states.length === 0) return 'idle';
    for (const p of ['permission', 'active', 'waiting', 'terminated', 'idle'] as AgentSessionState[]) {
      if (states.includes(p)) return p;
    }
    return 'idle';
  }

  private perSession(): boolean {
    return this.sessionTabs() === 'perSession';
  }

  /**
   * The terminal to bring forward for a worktree as a whole — switching to it,
   * focusing its card, a drop with no session of its own.
   *
   * Single mode: the one terminal `tmux attach`-ed to the worktree's session,
   * created if the previous one was closed (`windowName` goes in its title).
   * Per session: the tab the user was last in; else the tabs focus mode put
   * away, reopened in the groups they sat in; else the tab of the session last
   * focused, or the first in the card's order. A worktree with no session at
   * all still gets the single viewer — there is no session to give a tab.
   * Assumes the tmux session exists.
   */
  async getOrCreateViewer(worktree: Worktree, windowName?: string): Promise<vscode.Terminal> {
    const sessions = this.perSession() ? this.getSessions(worktree.id) : [];
    if (sessions.length === 0) {
      const base = this.label(worktree);
      return this.terminals.openViewer(worktree, windowName ? `${base} — ${windowName}` : base);
    }
    const current = this.terminals.current(worktree.id);
    if (current) return current;
    let last: vscode.Terminal | undefined;
    for (const p of this.terminals.takeParked(worktree.id)) {
      // Checked per tab, not once up front: each open is awaited, and a
      // session can end in between.
      if (!this.windows.get(worktree.id)?.has(p.index)) continue;
      last = await this.openSessionTab(worktree, p.index, { viewColumn: p.viewColumn });
    }
    if (last) return last;
    const live = new Set(sessions.map((s) => s.index));
    const remembered = this.terminals.lastFocusedWindow(worktree.id);
    const index = remembered !== undefined && live.has(remembered) ? remembered : sessions[0].index;
    return this.openSessionTab(worktree, index);
  }

  /**
   * One session's tab, named and drawn after what runs in it. Only ever for a
   * tracked window: a tab for any other would attach to nothing Stack shows.
   */
  private openSessionTab(
    worktree: Worktree,
    windowIndex: number,
    opts?: { beside?: boolean; viewColumn?: number },
  ): Promise<vscode.Terminal> {
    const meta = this.windows.get(worktree.id)!.get(windowIndex)!;
    return this.terminals.openTab(worktree, windowIndex, {
      label: this.label(worktree),
      session: this.aliases.get(worktree.id)?.get(windowIndex) ?? meta.name,
      kind: meta.kind,
    }, opts);
  }

  /**
   * Bring one window on screen: its own tab, or — single mode — the worktree's
   * viewer, already switched to it by the caller's selectWindow.
   */
  private async revealWindow(worktree: Worktree, windowIndex: number, opts?: { beside?: boolean }): Promise<vscode.Terminal> {
    let terminal: vscode.Terminal;
    if (!this.perSession()) {
      terminal = opts?.beside ? await this.moveViewerBeside(worktree) : await this.getOrCreateViewer(worktree);
    } else if (this.windows.get(worktree.id)?.has(windowIndex)) {
      terminal = await this.openSessionTab(worktree, windowIndex, opts);
    } else {
      // Not a session Stack knows (gone, or never adopted): a tab for it
      // would open on a placeholder and close again. The worktree instead.
      terminal = await this.getOrCreateViewer(worktree);
    }
    terminal.show();
    return terminal;
  }

  /** Single mode's "to the side": the viewer reopened beside the active group. */
  private async moveViewerBeside(worktree: Worktree): Promise<vscode.Terminal> {
    await this.terminals.closeViewer(worktree.id);
    return this.terminals.openViewer(worktree, this.label(worktree), { viewColumn: vscode.ViewColumn.Beside });
  }

  /** Reverse lookup: which worktree owns this terminal (viewer or session tab). */
  getWorktreeIdForTerminal(terminal: vscode.Terminal): string | undefined {
    return this.terminals.targetOf(terminal)?.worktreeId;
  }

  /** Which worktree — and, for a session tab, which session — a terminal shows. */
  getTargetForTerminal(terminal: vscode.Terminal): TerminalTarget | undefined {
    return this.terminals.targetOf(terminal);
  }

  /**
   * Same lookup by the terminal's NAME. Tab inputs for terminals are opaque
   * (TabInputTerminal exposes nothing), so a tab can only be matched to its
   * terminal through the label VS Code shows, which is the terminal's name.
   */
  getWorktreeIdForTerminalName(name: string): string | undefined {
    return this.terminals.targetOfName(name)?.worktreeId;
  }

  /** getTargetForTerminal by the terminal's name, for the image-drop catcher. */
  getTargetForTerminalName(name: string): TerminalTarget | undefined {
    return this.terminals.targetOfName(name);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async launch(worktree: Worktree, opts?: { provider?: ProviderId; prompt?: string }): Promise<vscode.Terminal> {
    const provider = opts?.provider ? this.providers.create(opts.provider) : this.providers.defaultProvider();
    const sessionName = TmuxManager.sessionName(worktree.id);
    console.log(`[stack] launch id=${worktree.id} provider=${provider.id} path=${worktree.path} exists=${this.pathExists(worktree.path)}`);
    await this.tmux.ensureSession(sessionName, worktree.path);

    // Window is named after the provider id so reconnect() can restore ownership.
    const windowIndex = await this.tmux.newWindow(sessionName, provider.id, worktree.path);
    // STACK_WINDOW_INDEX lets hook events target THIS window's state instead
    // of lighting up every agent window of the worktree. FOREMAN_WINDOW_INDEX
    // is its deprecated pre-rename alias, like the rest of launchEnv's.
    // Respawn (not send-keys): typing the command into the shell flashes the
    // env-var soup at the user until the agent clears the screen. The trailing
    // exec keeps a shell in the window after the agent exits, like before.
    await this.tmux.respawnWindow(
      sessionName,
      windowIndex,
      `STACK_WINDOW_INDEX="${windowIndex}" FOREMAN_WINDOW_INDEX="${windowIndex}" ${provider.buildCommand(worktree.id)}; exec "\${SHELL:-/bin/sh}"`,
    );

    this.windowMap(worktree.id).set(windowIndex, { kind: 'agent', provider: provider.id, state: 'waiting', name: provider.id });

    await this.tmux.selectWindow(sessionName, windowIndex);

    // The viewer comes up before the prompt is dealt with, so the user watches
    // the agent boot instead of staring at nothing for the seconds it takes
    // to be ready for input — the same seconds, but no longer a dead gap.
    const viewer = await this.revealWindow(worktree, windowIndex);

    // The session row goes up with the terminal, not after the prompt: getting
    // a prompt in can take the agent's whole boot plus a few seconds of
    // waiting for it to confirm the submit, and the card should not lag that.
    this.persistState(worktree.id);
    // The worktree's aggregate, not the new window's 'waiting': with another
    // agent of the worktree asking for permission, a bare 'waiting' read as
    // that request being answered and cleared its badge.
    this.stateChangeEmitter.fire({ worktreeId: worktree.id, state: this.aggregateState(worktree.id) });
    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();

    // The prompt is pasted, never passed as an argument. See buildCommand: the
    // launch line goes through `sh -c`, which eats `${...}` and backticks — and
    // the review panel wraps every quoted code line in backticks, so sending
    // comments to a new agent used to deliver them with the code missing.
    //
    // Pasting means waiting for the agent to own the pane: text sent while `sh`
    // is still starting it lands nowhere. If it never arrives (binary missing,
    // instant exit) the text is left unsent rather than submitted, because what
    // is sitting at that prompt is then a shell, and a prompt is not a command.
    if (opts?.prompt) {
      const started = await this.waitForAgentProcess(sessionName, windowIndex);
      // A running process is not yet a listening one: raw input and bracketed
      // paste come on a beat later, and until then a paste sits in the tty's
      // line buffer — a multi-line prompt would submit line by line. The
      // agent's own first hook (SessionStart, which every provider emits) is
      // the "listening now" signal — nearly: see INPUT_READY_SETTLE_MS.
      if (started && (await this.waitForHook(worktree.id, windowIndex))) {
        await this.sleep(AgentSessionManager.INPUT_READY_SETTLE_MS);
      }
      await this.submitPrompt(worktree.id, windowIndex, opts.prompt, started);
    }
    return viewer;
  }

  launchWithPrompt(worktree: Worktree, prompt: string): Promise<vscode.Terminal> {
    return this.launch(worktree, { prompt });
  }

  /**
   * Resolves once the agent owns the window. Two signals, either is enough:
   * the pane's command is no longer a shell (an agent that took over the
   * process group), or the pane's shell has a child process — which is what
   * `zsh -c "claude; exec zsh"` actually looks like from tmux, because the
   * child shares the group and `pane_current_command` never stops saying
   * `zsh`. Relying on the first alone burned the whole timeout on every
   * launch and then pasted the prompt unsent. False on timeout.
   */
  private async waitForAgentProcess(session: string, windowIndex: number): Promise<boolean> {
    // Counted attempts rather than a wall-clock deadline: the bound is then a
    // property of the code and not of how fast the machine ran the loop, which
    // is also what lets a test drive it with an instant sleep.
    const attempts = Math.ceil(
      AgentSessionManager.AGENT_START_TIMEOUT_MS / AgentSessionManager.AGENT_START_POLL_MS,
    );
    for (let i = 0; i < attempts; i++) {
      const windows = await this.tmux.listWindows(session).catch(() => []);
      const window = windows.find((w) => w.index === windowIndex);
      if (window?.command && !SHELL_COMMANDS.has(window.command)) return true;
      if (window?.pid !== undefined && (await this.tmux.hasChildProcess(window.pid).catch(() => false))) return true;
      await this.sleep(AgentSessionManager.AGENT_START_POLL_MS);
    }
    return false;
  }

  /**
   * Resolves once the window's agent has sent its first hook event, or after
   * AGENT_READY_TIMEOUT_MS: hooks the user has not trusted never fire, and a
   * launch must not hang on them.
   *
   * launch() wrote the window's meta moments ago, but the process wait in
   * between is up to ten seconds long, and the window can be killed or the
   * worktree deleted during it. This used to assert the meta was there — a
   * TypeError for a launch the user had already abandoned — and to look it
   * up through windowMap(), which re-created the deleted worktree's entry.
   */
  private waitForHook(worktreeId: string, windowIndex: number): Promise<boolean> {
    const meta = this.windows.get(worktreeId)?.get(windowIndex);
    if (!meta) return Promise.resolve(false);
    if (meta.hookSeen) return Promise.resolve(true);
    const key = `${worktreeId}:${windowIndex}`;
    const seen = new Promise<boolean>((resolve) => this.readyWaiters.set(key, () => resolve(true)));
    const capped = this.sleep(AgentSessionManager.AGENT_READY_TIMEOUT_MS).then(() => false);
    return Promise.race([seen, capped]).finally(() => this.readyWaiters.delete(key));
  }

  /**
   * Paste a prompt into an agent window and, when `submit`, make sure it is
   * actually sent — the one path every prompt takes, from a launch or from
   * the review panel.
   *
   * Pressing Enter the instant the paste returned often lost the submit:
   * the agent was still taking the paste in and swallowed the
   * keypress. So: paste, let it settle, press Enter, and then — where the
   * agent can say so — wait for it to confirm. Claude Code and Codex fire
   * UserPromptSubmit on a submit, which arrives here as 'active' for this
   * window; no confirmation within SUBMIT_ACK_TIMEOUT_MS means the Enter went
   * nowhere, and it is pressed again, at most SUBMIT_RETRIES times.
   *
   * Retrying is only safe when silence means "not submitted", so it needs
   * evidence that this window's hooks reach us (one has already arrived), a
   * provider that has a submit hook, and an agent sitting at its prompt. An
   * Enter is not harmless in general: into a permission dialog it is a "yes".
   * Without all three the Enter is pressed once, after the same settle delay —
   * which is the part of the fix that does not depend on hooks at all.
   */
  private async submitPrompt(worktreeId: string, windowIndex: number, text: string, submit: boolean): Promise<void> {
    // Closed — or its worktree deleted — while a launch waited for the agent:
    // the paste would fail, or land in whatever has taken the index since.
    if (!this.windows.get(worktreeId)?.has(windowIndex)) return;
    const target = `${TmuxManager.sessionName(worktreeId)}:${windowIndex}`;
    await this.tmux.paste(target, text);
    if (!submit) return;
    await this.sleep(AgentSessionManager.PASTE_SETTLE_MS);

    if (!this.canConfirmSubmit(worktreeId, windowIndex)) {
      await this.tmux.pressEnter(target);
      return;
    }
    for (let attempt = 0; attempt <= AgentSessionManager.SUBMIT_RETRIES; attempt++) {
      // Armed before the keypress, so an acknowledgement cannot slip in between.
      const confirmed = this.waitForSubmit(worktreeId, windowIndex);
      await this.tmux.pressEnter(target);
      if (await confirmed) return;
      // Killed while we waited: there is nothing left to press Enter in.
      if (!this.windows.get(worktreeId)?.has(windowIndex)) return;
    }
    console.warn(`[stack] no submit confirmation from ${target} after ${AgentSessionManager.SUBMIT_RETRIES + 1} Enters`);
  }

  private canConfirmSubmit(worktreeId: string, windowIndex: number): boolean {
    const meta = this.windows.get(worktreeId)?.get(windowIndex);
    return meta?.kind === 'agent'
      && meta.hookSeen === true
      && meta.provider !== undefined
      && AgentSessionManager.SUBMIT_ACK_PROVIDERS.has(meta.provider)
      && (meta.state === 'waiting' || meta.state === 'idle');
  }

  /**
   * True once the window reports it took a prompt: 'active' (UserPromptSubmit,
   * or a tool already running), 'permission' (it is working and asking), or
   * 'terminated' (gone — stop pressing). False after SUBMIT_ACK_TIMEOUT_MS.
   */
  private waitForSubmit(worktreeId: string, windowIndex: number): Promise<boolean> {
    const key = `${worktreeId}:${windowIndex}`;
    const waiters = this.submitWaiters.get(key) ?? new Set();
    this.submitWaiters.set(key, waiters);
    let waiter!: (state: AgentSessionState) => void;
    const seen = new Promise<boolean>((resolve) => {
      waiter = (state) => {
        if (state === 'active' || state === 'permission' || state === 'terminated') resolve(true);
      };
      waiters.add(waiter);
    });
    const capped = this.sleep(AgentSessionManager.SUBMIT_ACK_TIMEOUT_MS).then(() => false);
    return Promise.race([seen, capped]).finally(() => {
      waiters.delete(waiter);
      if (waiters.size === 0) this.submitWaiters.delete(key);
    });
  }

  /**
   * Whether a window's agent is still running, from what tmux and ps say now.
   *
   * Launched agents run inside `<shell> -c "…agent…; exec $SHELL"`, and the
   * pane's process IS that wrapper for exactly as long as the agent runs:
   * when the agent exits — /exit, a crash, SIGKILL — the wrapper execs the
   * interactive shell, and the same pid's command line becomes a bare shell.
   * That is the signal used here rather than "the pane has a child", which a
   * dead window satisfies too: an interactive zsh keeps helpers such as
   * powerlevel10k's gitstatusd as children, and pasting into that shell is
   * the very thing this exists to prevent.
   *
   * A non-shell foreground command is enough on its own — it is how an agent
   * the user started by hand in a shell window looks. 'unknown' when tmux or
   * ps cannot say; callers must not read it as either answer.
   */
  private async agentLiveness(window: TmuxWindow | undefined): Promise<'alive' | 'dead' | 'unknown'> {
    if (!window) return 'unknown';
    const command = (window.command ?? '').replace(/^-/, '');
    if (command && !SHELL_COMMANDS.has(command)) return 'alive';
    if (!command || window.pid === undefined) return 'unknown';
    let args: string;
    try {
      args = await this.tmux.processCommandLine(window.pid);
    } catch {
      return 'unknown';
    }
    return /(^|\s)-c(\s|$)/.test(args) ? 'alive' : 'dead';
  }

  /** Record agents found dead; returns whether anything changed. Callers persist and fire. */
  private markTerminated(worktreeId: string, windowIndex: number): boolean {
    const meta = this.windows.get(worktreeId)?.get(windowIndex);
    if (meta?.kind !== 'agent' || meta.state === 'terminated') return false;
    this.windows.get(worktreeId)!.set(windowIndex, { ...meta, state: 'terminated' });
    console.log(`[stack] agent gone id=${worktreeId} window=${windowIndex}`);
    return true;
  }

  /**
   * Paste a prompt into a worktree's live agent window and bring it to the front.
   *
   * Picks, in order, an agent at its prompt, one asking for permission, then
   * a busy one — but only one that is actually running. This used to fall
   * back to the first agent window whatever it held, and a window whose agent
   * has exited holds the shell the launch line execs afterwards: the prompt
   * was pasted into zsh and submitted, and review prompts quote code in
   * backticks, which zsh runs as command substitution.
   *
   * Returns false when no agent is running — the caller then launches a
   * fresh one. Windows found dead on the way are marked terminated.
   */
  async sendPromptToAgent(worktree: Worktree, prompt: string): Promise<boolean> {
    const map = this.windows.get(worktree.id);
    if (!map) return false;
    const rank = (s: AgentSessionState) => (s === 'waiting' || s === 'idle' ? 0 : s === 'permission' ? 1 : 2);
    const candidates = [...map.entries()]
      .filter(([, m]) => m.kind === 'agent' && m.state !== 'terminated')
      .sort(([, a], [, b]) => rank(a.state) - rank(b.state));
    if (candidates.length === 0) return false;

    const sessionName = TmuxManager.sessionName(worktree.id);
    const tmuxWindows = await this.tmux.listWindows(sessionName).catch((): TmuxWindow[] => []);
    let windowIndex: number | undefined;
    let died = false;
    for (const [index] of candidates) {
      const liveness = await this.agentLiveness(tmuxWindows.find((w) => w.index === index));
      if (liveness === 'alive') { windowIndex = index; break; }
      if (liveness === 'dead') died = this.markTerminated(worktree.id, index) || died;
    }
    if (died) {
      this.persistState(worktree.id);
      this.stateChangeEmitter.fire({ worktreeId: worktree.id, state: this.aggregateState(worktree.id) });
      this.terminalsChangeEmitter.fire();
    }
    if (windowIndex === undefined) return false;

    await this.tmux.selectWindow(sessionName, windowIndex);
    // Shown before the submit, which may now wait seconds for the agent to
    // confirm it: the user watches the prompt go in rather than wait for it.
    // That session's own tab, in perSession mode, not whichever is in front.
    await this.revealWindow(worktree, windowIndex).catch(() => undefined);
    await this.submitPrompt(worktree.id, windowIndex, prompt, true);
    return true;
  }

  async openTerminal(worktree: Worktree): Promise<vscode.Terminal> {
    const sessionName = TmuxManager.sessionName(worktree.id);
    console.log(`[stack] openTerminal id=${worktree.id} path=${worktree.path} exists=${this.pathExists(worktree.path)}`);
    await this.tmux.ensureSession(sessionName, worktree.path);

    const windowIndex = await this.tmux.newWindow(sessionName, 'shell', worktree.path);
    this.windowMap(worktree.id).set(windowIndex, { kind: 'shell', state: 'idle', name: 'shell' });

    await this.tmux.selectWindow(sessionName, windowIndex);
    const viewer = await this.revealWindow(worktree, windowIndex);

    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();
    return viewer;
  }

  /**
   * Bring one session on screen: its own tab (perSession), or the viewer
   * switched to its window (single). `beside` opens it next to the active
   * editor group — "Stack: Open Session to the Side" — moving it there if
   * it is already open.
   *
   * The base session's window is selected in both modes, so single mode
   * finds it there if the setting changes, and an unaimed paste lands in it.
   */
  async focusWindow(worktree: Worktree, windowIndex: number, opts?: { beside?: boolean }): Promise<void> {
    const sessionName = TmuxManager.sessionName(worktree.id);
    await this.tmux.selectWindow(sessionName, windowIndex);

    // Reuse the live viewer. This used to dispose it and build a fresh one just
    // to put the window name in the tab title — but disposing an editor-area
    // terminal makes VSCode activate a neighbouring tab in that group, so a file
    // the user never opened would flash into view before the new terminal
    // replaced it. A stale tab title is a much smaller price than that.
    await this.revealWindow(worktree, windowIndex, opts);
  }

  /**
   * The session "Open Session to the Side" acts on when it is not handed one:
   * the one in front for this worktree, else the first on its card.
   */
  focusedSession(worktreeId: string): number | undefined {
    return this.terminals.focusedWindow(worktreeId) ?? this.getSessions(worktreeId)[0]?.index;
  }

  /**
   * Paste text (e.g. a screenshot path) into one of the worktree's sessions,
   * unsent. Aimed at `windowIndex` when the caller knows which terminal the
   * user meant (the one an image was dropped on, the focused one for
   * Cmd+Alt+V); otherwise at the session in front — its tab's window, or in
   * single mode the session's current window, which is what the viewer shows.
   */
  async pasteToActiveWindow(worktreeId: string, text: string, windowIndex?: number): Promise<void> {
    const sessionName = TmuxManager.sessionName(worktreeId);
    const index = windowIndex ?? this.terminals.focusedWindow(worktreeId);
    await this.tmux.paste(index === undefined ? sessionName : `${sessionName}:${index}`, text);
  }

  getState(worktreeId: string): AgentSessionState {
    return this.aggregateState(worktreeId);
  }

  updateState(workspaceId: string, state: AgentSessionState, windowIndex?: number): void {
    const map = this.windows.get(workspaceId);
    if (!map) return;
    if (windowIndex !== undefined) {
      // Target exactly the window the hook came from. An untracked index means
      // the window was just killed and this is its dying event (e.g. SessionEnd)
      // — drop it, or it would repaint every other session in the worktree.
      const meta = map.get(windowIndex);
      if (!meta) return;
      // A window recorded as a plain shell that starts reporting agent states
      // has an agent running in it — the user launched one by hand in a
      // terminal Stack opened. Adopt it instead of dropping every event: the
      // provider stays unknown (nothing says which agent it is), which the card
      // renders with a neutral mark rather than guessing.
      map.set(windowIndex, meta.kind === 'agent' ? { ...meta, state, hookSeen: true } : { ...meta, kind: 'agent', state, hookSeen: true });
      this.readyWaiters.get(`${workspaceId}:${windowIndex}`)?.();
      for (const waiter of this.submitWaiters.get(`${workspaceId}:${windowIndex}`) ?? []) waiter(state);
    } else {
      // Agents launched before STACK_WINDOW_INDEX existed: no way to know the
      // source window — apply to all agent windows (pre-per-session behavior).
      for (const [idx, meta] of map.entries()) {
        if (meta.kind === 'agent') map.set(idx, { ...meta, state, hookSeen: true });
      }
      for (const [key, release] of this.readyWaiters) {
        if (key.startsWith(`${workspaceId}:`)) release();
      }
      for (const [key, waiters] of this.submitWaiters) {
        if (key.startsWith(`${workspaceId}:`)) for (const waiter of waiters) waiter(state);
      }
    }
    this.dropStaleAttention(map, state, windowIndex);
    this.persistState(workspaceId);
    this.stateChangeEmitter.fire({ worktreeId: workspaceId, state: this.aggregateState(workspaceId), windowIndex });
    // Hook events are the heartbeat of a session — piggyback title syncing on them.
    this.refreshTitles(workspaceId).catch(() => {});
    this.scheduleTitleRefresh(workspaceId);
  }

  /** The agent has moved on from asking, so what it asked is no longer news. */
  private dropStaleAttention(map: Map<number, WindowMeta>, state: AgentSessionState, windowIndex?: number): void {
    if (state === 'permission' || state === 'waiting') return;
    for (const [idx, meta] of map) {
      if ((windowIndex !== undefined && idx !== windowIndex) || meta.attention === undefined) continue;
      const { attention: _attention, attentionFromRequest: _request, ...rest } = meta;
      map.set(idx, rest);
    }
  }

  /**
   * Keeps what an agent said when it asked for the user, so the sidebar can
   * show the question instead of just "needs attention".
   *
   * Fed from HookServer.onHookEvent, after updateState has already moved the
   * window to `permission`. A permission request carries the tool call rather
   * than a message, so the command is read from it; a notification's prose
   * does not overwrite that, since the command is the more useful of the two.
   * Returns whether anything changed, so the caller knows to repaint the
   * sidebar. Fires no state event on purpose: the state did not change, and listeners
   * such as the attention notifier would take a second one for a second ask.
   */
  noteHookEvent(e: {
    event: string;
    workspaceId: string;
    windowIndex?: number;
    message?: string;
    payload?: Record<string, unknown>;
  }): boolean {
    const isRequest = e.event === 'PermissionRequest';
    if (!isRequest && e.event !== 'Notification') return false;
    const text = (isRequest ? requestSummary(e.payload) : undefined) ?? e.message;
    const map = this.windows.get(e.workspaceId);
    if (!text || !map) return false;
    let changed = false;
    for (const [idx, meta] of map) {
      if (meta.kind !== 'agent' || meta.state !== 'permission') continue;
      if (e.windowIndex !== undefined && idx !== e.windowIndex) continue;
      if (!isRequest && meta.attentionFromRequest) continue;
      map.set(idx, { ...meta, attention: text, attentionFromRequest: isRequest });
      changed = true;
    }
    return changed;
  }

  getSessions(worktreeId: string): SessionItem[] {
    const map = this.windows.get(worktreeId);
    if (!map) return [];
    const byIndex = this.aliases.get(worktreeId);
    const items = [...map.entries()].map(([index, meta]) => ({
      name: meta.name,
      alias: byIndex?.get(index),
      kind: meta.kind,
      provider: meta.provider,
      state: meta.state,
      title: meta.title,
      attention: meta.attention,
      index,
    }));
    const order = this.orders.get(worktreeId);
    if (order) {
      // Sort by the saved display order; windows not in it (newly created) fall
      // to the end, keeping their natural order (Array.sort is stable).
      const rank = (i: number) => { const p = order.indexOf(i); return p === -1 ? Number.MAX_SAFE_INTEGER : p; };
      items.sort((a, b) => rank(a.index) - rank(b.index));
    }
    return items;
  }

  /**
   * Name (or un-name, with an empty string) one session.
   *
   * The label is the user's, so it wins over everything derived — a window
   * running redis stays "redis" whether or not tmux still reports the process.
   */
  setSessionAlias(worktreeId: string, windowIndex: number, alias: string): void {
    const map = this.aliases.get(worktreeId) ?? new Map<number, string>();
    const trimmed = alias.trim();
    if (trimmed) map.set(windowIndex, trimmed);
    else map.delete(windowIndex);
    this.aliases.set(worktreeId, map);
    this.persistAliases();
    this.terminalsChangeEmitter.fire();
  }

  /** Drop a session's name — its window is gone and the index will be reused. */
  private forgetAlias(worktreeId: string, windowIndex: number): void {
    const map = this.aliases.get(worktreeId);
    if (!map?.delete(windowIndex)) return;
    if (map.size === 0) this.aliases.delete(worktreeId);
    this.persistAliases();
  }

  private persistAliases(): void {
    const out: Record<string, Record<string, string>> = {};
    for (const [id, map] of this.aliases.entries()) {
      if (map.size > 0) out[id] = Object.fromEntries(map.entries());
    }
    this.globalState.update(AgentSessionManager.ALIAS_KEY, out);
  }

  /** Persist a user-chosen display order (list of window indexes) for a worktree. */
  setSessionOrder(worktreeId: string, orderedIndexes: number[]): void {
    this.orders.set(worktreeId, orderedIndexes);
    const stored = this.globalState.get<Record<string, number[]>>(AgentSessionManager.ORDER_KEY, {});
    stored[worktreeId] = orderedIndexes;
    this.globalState.update(AgentSessionManager.ORDER_KEY, stored);
    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();
  }

  /**
   * Agents that are, as far as we know, still running. A terminated window
   * stays on the card until it is closed, but it is not an agent anyone can
   * talk to — the review panel offers "paste into the live session" on this
   * count, and offering it for a dead window sent the prompt to its shell.
   */
  getAgentCount(worktreeId: string): number {
    return [...(this.windows.get(worktreeId) ?? new Map<number, WindowMeta>()).values()]
      .filter(w => w.kind === 'agent' && w.state !== 'terminated').length;
  }

  getShellCount(worktreeId: string): number {
    return [...(this.windows.get(worktreeId) ?? new Map()).values()]
      .filter(w => w.kind === 'shell').length;
  }

  hasTerminals(worktreeId: string): boolean {
    return (this.windows.get(worktreeId)?.size ?? 0) > 0;
  }

  /** The worktree's terminal in front: its last-focused session tab, or its single viewer. */
  getViewer(worktreeId: string): vscode.Terminal | undefined {
    return this.terminals.current(worktreeId);
  }

  /** Legacy compat — returns viewer terminal. */
  getTerminal(worktreeId: string): vscode.Terminal | undefined {
    return this.getViewer(worktreeId);
  }

  getPlainTerminal(worktreeId: string): vscode.Terminal | undefined {
    return this.getViewer(worktreeId);
  }

  focus(worktreeId: string): void {
    this.terminals.current(worktreeId)?.show();
  }

  async killWindow(worktreeId: string, windowIndex: number): Promise<void> {
    const sessionName = TmuxManager.sessionName(worktreeId);
    // Its tab first, closed by us: the window's death would end the view and
    // so the tab on its own, but how VS Code reacts to a terminal's process
    // vanishing is not something to leave a user-facing kill waiting on.
    await this.terminals.closeTab(worktreeId, windowIndex);
    await this.tmux.killWindow(sessionName, windowIndex);
    this.windows.get(worktreeId)?.delete(windowIndex);
    // A launch still waiting for this window's agent stops waiting now (and
    // then finds the window gone) instead of sitting out its timeout.
    this.readyWaiters.get(`${worktreeId}:${windowIndex}`)?.();
    this.forgetAlias(worktreeId, windowIndex);
    const order = this.orders.get(worktreeId);
    if (order?.includes(windowIndex)) {
      this.setSessionOrder(worktreeId, order.filter((i) => i !== windowIndex));
    }
    this.persistState(worktreeId);
    this.stateChangeEmitter.fire({ worktreeId, state: this.aggregateState(worktreeId) });
    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();
  }

  /**
   * Take a worktree's terminals off screen — its viewer, or every session tab
   * (remembered with the group each sat in, and reopened there by the next
   * getOrCreateViewer). The tmux sessions keep running; each terminal's client
   * exits cleanly first, so VS Code won't show the "terminate running
   * processes?" dialog.
   */
  async closeViewer(worktreeId: string): Promise<void> {
    await this.terminals.closeAll(worktreeId);
  }

  async killWorktreeSession(worktreeId: string): Promise<void> {
    const sessionName = TmuxManager.sessionName(worktreeId);
    // Views first: a window linked into a view outlives its base — the agent
    // of a deleted worktree would go on running there.
    await this.terminals.killViews(worktreeId);
    await this.tmux.killSession(sessionName);
    this.windows.delete(worktreeId);
    for (const [key, release] of this.readyWaiters) {
      if (key.startsWith(`${worktreeId}:`)) release();
    }
    this.aliases.delete(worktreeId);
    this.persistAliases();
    this.terminals.disposeAll(worktreeId);
    this.persistState(worktreeId);
    this.stateChangeEmitter.fire({ worktreeId, state: 'idle' });
    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();
  }

  terminateSession(worktreeId: string): void {
    this.killWorktreeSession(worktreeId).catch(() => {});
  }

  /** Kept for extension.ts compat (setup/teardown scripts). No-op with tmux. */
  register(_worktreeId: string, _terminal: vscode.Terminal): void {}

  /**
   * The state an agent window comes back with after a reload.
   *
   * The persisted state is from before the reload, and the agent did not
   * stop in between: its hooks went to the previous window's HookServer,
   * which is gone, so whatever happened meanwhile — it finished, it died — was
   * never heard. So the process is asked first: gone is "terminated", which
   * it really is. Running, the persisted state is kept only where it cannot
   * have gone stale on its own: "permission" waits for the user, who was not
   * there to answer. "active" may well have finished since, and restoring it
   * left the session "working" until the next hook, which an agent sitting at
   * its prompt never sends; "waiting" is the recoverable guess, and any hook
   * corrects it. A persisted "terminated" on a running agent is likewise
   * stale (or left by a past liveness-detection bug), and gets "waiting".
   */
  private async restoredState(worktreeId: string, window: TmuxWindow): Promise<AgentSessionState> {
    if ((await this.agentLiveness(window)) === 'dead') return 'terminated';
    const persisted = this.persistedState(worktreeId, window.index);
    return persisted === 'permission' || persisted === 'idle' ? persisted : 'waiting';
  }

  /** On extension reload, scan tmux sessions to restore tracked windows. */
  async reconnect(worktrees: Worktree[]): Promise<void> {
    for (const wt of worktrees) {
      const sessionName = TmuxManager.sessionName(wt.id);
      // A session from before the rename to Stack, agents and all, becomes
      // this worktree's session here — before anything looks for it.
      await this.tmux.adoptLegacySession(wt.id).catch(() => false);
      if (!(await this.tmux.hasSession(sessionName))) continue;

      const tmuxWindows = await this.tmux.listWindows(sessionName);
      const wm = this.windowMap(wt.id);
      let restoredAgents = false;
      // The session's own first window, which new-session creates and nobody
      // asked for. It sits at tmux's base-index — 0 by default, but 1 under
      // the common `set -g base-index 1`, where a hard-coded 0 used to let it
      // through as a stray "shell" row on every reload.
      const anchor = Math.min(...tmuxWindows.map((w) => w.index));
      for (const w of tmuxWindows) {
        // Skip the default session window (the first one, named after the shell)
        if (w.index === anchor && w.name !== 'shell' && !isAgentWindowName(w.name)) continue;
        const provider = providerForWindowName(w.name);
        const kind: 'agent' | 'shell' = provider ? 'agent' : 'shell';
        const title = kind === 'agent' ? this.cleanTitle(w.title, w.name) : this.commandTitle(w.command);
        const restoredState = kind === 'agent' ? await this.restoredState(wt.id, w) : 'idle';
        wm.set(w.index, { kind, provider, state: restoredState, name: w.name, title });
        if (kind === 'agent') restoredAgents = true;
      }
      // One event per worktree, carrying the aggregate — what every other
      // emitter sends. One per window, each with its own state, had the
      // notifier read "permission" then "waiting" from the same worktree as a
      // transition: it cleared a real permission badge, or announced an agent
      // "finished" that had only been reloaded.
      if (restoredAgents) this.stateChangeEmitter.fire({ worktreeId: wt.id, state: this.aggregateState(wt.id) });
    }

    // Claim the terminals VSCode restored after reload. Without this,
    // closeViewer() can't find them and switching leaves phantom terminals
    // open, then creates duplicates on the next getOrCreateViewer().
    await this.terminals.claim(worktrees, (wt) => this.label(wt));
    // A restored tab for a window that is not (or no longer) a session has
    // nothing to show; and views nobody shows any more are leaks.
    for (const wt of worktrees) {
      await this.terminals.closeTabsExcept(wt.id, new Set(this.windows.get(wt.id)?.keys() ?? []));
    }
    await this.terminals.pruneViews();

    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();
  }

  dispose(): void {
    for (const timer of this.titleTimers.values()) clearTimeout(timer);
    this.titleTimers.clear();
    if (this.shellTimer) { clearInterval(this.shellTimer); this.shellTimer = undefined; }
    this.terminals.dispose();
    this.stateChangeEmitter.dispose();
    this.terminalsChangeEmitter.dispose();
  }
}
