import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { AgentSessionState, Worktree } from '../types';
import { TmuxManager } from './TmuxManager';
import type { ISessionManager } from '../ports/ISessionManager';
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
};

/**
 * Commands a freshly respawned agent window reports while it is NOT yet the
 * agent: `sh` runs the launch line, and the trailing `exec $SHELL` takes over
 * again if the agent binary is missing or exits at once.
 */
const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);

export class AgentSessionManager {
  // worktreeId → (tmux window index → metadata)
  private windows = new Map<string, Map<number, WindowMeta>>();
  // worktreeId → the single VSCode "viewer" terminal attached to that tmux session
  private viewers = new Map<string, vscode.Terminal>();

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
   * Single timer that keeps shell rows current.
   *
   * syncWindows is otherwise only reached from a hook event, which is an
   * AGENT's heartbeat — so a shell in a worktree with no agent running would
   * have been labelled once and then frozen, which is most of the time you have
   * a shell open. One interval for all worktrees rather than one each, and it
   * only exists while some worktree actually has a shell.
   */
  private shellTimer?: ReturnType<typeof setInterval>;

  readonly onStateChange = this.stateChangeEmitter.event;
  readonly onTerminalsChange = this.terminalsChangeEmitter.event;

  // Persists the last-known aggregate state per worktree so a VSCode reload can
  // restore "needs attention" / "waiting" instead of blindly defaulting to waiting.
  private static readonly STATE_KEY = 'foreman.claudeStates';
  // Persists a user-chosen display order (list of tmux window indexes) per
  // worktree. Purely cosmetic — tmux window indexes stay put so state tracking,
  // kill and focus keep working; only getSessions() sorts by this.
  private static readonly ORDER_KEY = 'foreman.sessionOrder';

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
  private static readonly ALIAS_KEY = 'foreman.sessionAliases';
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
  ) {
    vscode.window.onDidCloseTerminal(terminal => {
      for (const [id, viewer] of this.viewers.entries()) {
        if (viewer === terminal) { this.viewers.delete(id); break; }
      }
    });

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
   * This must stay the single source of the label: reconnect() reclaims viewer
   * terminals with `terminal.name.startsWith(label(wt))`, so capping anywhere
   * else would silently break that match.
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
   * The window map used to be written only when Foreman itself acted — launch,
   * openTerminal, killWindow — so everything else that happens to a window was
   * invisible: a window the user closed with `exit` stayed on the card forever
   * as a session that could not be focused or killed, and an agent started in a
   * window Foreman never opened did not exist at all.
   *
   * Deliberately conservative in what it adopts: only windows whose name
   * identifies a provider. Adopting every unknown window would surface the
   * session's own initial shell (window 0, an artefact of `new-session`) as a
   * session row nobody asked for.
   */
  async syncWindows(worktreeId: string): Promise<void> {
    const map = this.windows.get(worktreeId);
    if (!map) return;
    const tmuxWindows = await this.tmux.listWindows(TmuxManager.sessionName(worktreeId));
    // An empty list means tmux failed or the session is gone — both return []
    // from listWindows. Pruning on that would wipe every session on a transient
    // error, so treat it as "no information" rather than "nothing is there".
    if (tmuxWindows.length === 0) return;

    let changed = false;
    const live = new Set(tmuxWindows.map((w) => w.index));

    for (const index of [...map.keys()]) {
      if (!live.has(index)) {
        map.delete(index);
        // The name goes with the window. tmux reuses indexes, so leaving it
        // behind would hang "redis" on whatever opens next in that slot.
        this.forgetAlias(worktreeId, index);
        changed = true;
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

    if (changed) {
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
   * Starts or stops the shell poller to match whether any shell is open.
   *
   * Called wherever the window map changes. Idempotent, and a no-op in the
   * common case — an extra `tmux list-windows` every two seconds is worth it
   * for a label that moves, and worth nothing at all when there is no shell to
   * label, which is why it is not simply always on.
   */
  private syncShellPolling(): void {
    const wanted = [...this.windows.entries()]
      .filter(([, map]) => [...map.values()].some((w) => w.kind === 'shell'))
      .map(([id]) => id);

    if (wanted.length === 0) {
      if (this.shellTimer) { clearInterval(this.shellTimer); this.shellTimer = undefined; }
      return;
    }
    if (this.shellTimer) return;
    this.shellTimer = setInterval(() => {
      for (const [worktreeId, map] of this.windows.entries()) {
        if (![...map.values()].some((w) => w.kind === 'shell')) continue;
        // Failures are ignored on purpose: a tmux hiccup should leave the last
        // known label on screen rather than blanking the row.
        this.syncWindows(worktreeId).catch(() => {});
      }
    }, AgentSessionManager.SHELL_POLL_MS);
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

  /**
   * Returns the single VSCode terminal that is `tmux attach`-ed to the
   * worktree's tmux session. Creates one if the previous one was closed.
   * Assumes the tmux session already exists.
   */
  async getOrCreateViewer(worktree: Worktree, windowName?: string): Promise<vscode.Terminal> {
    const existing = this.viewers.get(worktree.id);
    if (existing && existing.exitStatus === undefined) return existing;

    const sessionName = TmuxManager.sessionName(worktree.id);
    const base = this.label(worktree);
    const name = windowName ? `${base} — ${windowName}` : base;
    // If the worktree directory is gone, launch WITHOUT a cwd so the terminal
    // can still `tmux attach` to a running session instead of failing to launch
    // with "Starting directory (cwd) does not exist".
    const exists = this.pathExists(worktree.path);
    console.log(`[foreman] open viewer id=${worktree.id} name="${name}" path=${worktree.path} exists=${exists}`);
    const cwd = exists ? worktree.path : undefined;
    if (!exists) {
      console.warn(`[foreman] worktree directory missing, attaching viewer without cwd: ${worktree.path}`);
    }
    const terminal = vscode.window.createTerminal({
      name,
      cwd,
      location: vscode.TerminalLocation.Editor,
      shellPath: '/bin/sh',
      // No `exec $SHELL` fallback — when tmux detaches the sh exits cleanly,
      // which lets us dispose the terminal without the "terminate processes?" dialog.
      shellArgs: ['-c', `tmux attach -t "${sessionName}"`],
    });
    this.viewers.set(worktree.id, terminal);
    return terminal;
  }

  /** Reverse lookup: which worktree owns this viewer terminal. */
  getWorktreeIdForTerminal(terminal: vscode.Terminal): string | undefined {
    for (const [id, viewer] of this.viewers) {
      if (viewer === terminal) return id;
    }
    return undefined;
  }

  /**
   * Same lookup by the terminal's NAME. Tab inputs for terminals are opaque
   * (TabInputTerminal exposes nothing), so a tab can only be matched to its
   * viewer through the label VS Code shows, which is the terminal's name.
   */
  getWorktreeIdForTerminalName(name: string): string | undefined {
    for (const [id, viewer] of this.viewers) {
      if (viewer.name === name) return id;
    }
    return undefined;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async launch(worktree: Worktree, opts?: { provider?: ProviderId; prompt?: string }): Promise<vscode.Terminal> {
    const provider = opts?.provider ? this.providers.create(opts.provider) : this.providers.defaultProvider();
    const sessionName = TmuxManager.sessionName(worktree.id);
    console.log(`[foreman] launch id=${worktree.id} provider=${provider.id} path=${worktree.path} exists=${this.pathExists(worktree.path)}`);
    await this.tmux.ensureSession(sessionName, worktree.path);

    // Window is named after the provider id so reconnect() can restore ownership.
    const windowIndex = await this.tmux.newWindow(sessionName, provider.id, worktree.path);
    // FOREMAN_WINDOW_INDEX lets hook events target THIS window's state instead
    // of lighting up every agent window of the worktree.
    // Respawn (not send-keys): typing the command into the shell flashes the
    // env-var soup at the user until the agent clears the screen. The trailing
    // exec keeps a shell in the window after the agent exits, like before.
    await this.tmux.respawnWindow(
      sessionName,
      windowIndex,
      `FOREMAN_WINDOW_INDEX="${windowIndex}" ${provider.buildCommand(worktree.id)}; exec "\${SHELL:-/bin/sh}"`,
    );

    this.windowMap(worktree.id).set(windowIndex, { kind: 'agent', provider: provider.id, state: 'waiting', name: provider.id });

    await this.tmux.selectWindow(sessionName, windowIndex);

    // The viewer comes up before the prompt is dealt with, so the user watches
    // the agent boot instead of staring at nothing for the seconds it takes
    // to be ready for input — the same seconds, but no longer a dead gap.
    const viewer = await this.getOrCreateViewer(worktree);
    viewer.show();

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
      await this.tmux.paste(`${sessionName}:${windowIndex}`, opts.prompt, started);
    }

    this.persistState(worktree.id);
    this.stateChangeEmitter.fire({ worktreeId: worktree.id, state: 'waiting' });
    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();
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
   * Paste a prompt into a worktree's live agent window and bring it to the front.
   * Picks a window that is ready for input (waiting/idle/permission) when one
   * exists, else the first agent window. Returns false if the worktree has no
   * agent window at all — the caller then decides to launch a fresh agent.
   */
  async sendPromptToAgent(worktree: Worktree, prompt: string): Promise<boolean> {
    const map = this.windows.get(worktree.id);
    if (!map) return false;
    const agents = [...map.entries()].filter(([, m]) => m.kind === 'agent');
    if (agents.length === 0) return false;

    const ready = agents.find(([, m]) => m.state === 'waiting' || m.state === 'idle' || m.state === 'permission');
    const [windowIndex] = ready ?? agents[0];

    const sessionName = TmuxManager.sessionName(worktree.id);
    await this.tmux.selectWindow(sessionName, windowIndex);
    await this.tmux.paste(`${sessionName}:${windowIndex}`, prompt);

    const viewer = await this.getOrCreateViewer(worktree).catch(() => undefined);
    viewer?.show();
    return true;
  }

  async openTerminal(worktree: Worktree): Promise<vscode.Terminal> {
    const sessionName = TmuxManager.sessionName(worktree.id);
    console.log(`[foreman] openTerminal id=${worktree.id} path=${worktree.path} exists=${this.pathExists(worktree.path)}`);
    await this.tmux.ensureSession(sessionName, worktree.path);

    const windowIndex = await this.tmux.newWindow(sessionName, 'shell', worktree.path);
    this.windowMap(worktree.id).set(windowIndex, { kind: 'shell', state: 'idle', name: 'shell' });

    await this.tmux.selectWindow(sessionName, windowIndex);
    const viewer = await this.getOrCreateViewer(worktree);
    viewer.show();

    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();
    return viewer;
  }

  /** Switch the viewer terminal to a specific tmux window, updating the title. */
  async focusWindow(worktree: Worktree, windowIndex: number): Promise<void> {
    const sessionName = TmuxManager.sessionName(worktree.id);
    await this.tmux.selectWindow(sessionName, windowIndex);

    // Reuse the live viewer. This used to dispose it and build a fresh one just
    // to put the window name in the tab title — but disposing an editor-area
    // terminal makes VSCode activate a neighbouring tab in that group, so a file
    // the user never opened would flash into view before the new terminal
    // replaced it. A stale tab title is a much smaller price than that.
    const viewer = await this.getOrCreateViewer(worktree);
    viewer.show();
  }

  /** Paste text (e.g. a screenshot path) into the worktree's active pane, unsent. */
  async pasteToActiveWindow(worktreeId: string, text: string): Promise<void> {
    await this.tmux.paste(TmuxManager.sessionName(worktreeId), text, false);
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
      // terminal Foreman opened. Adopt it instead of dropping every event: the
      // provider stays unknown (nothing says which agent it is), which the card
      // renders with a neutral mark rather than guessing.
      map.set(windowIndex, meta.kind === 'agent' ? { ...meta, state } : { ...meta, kind: 'agent', state });
    } else {
      // Agents launched before FOREMAN_WINDOW_INDEX existed: no way to know the
      // source window — apply to all agent windows (pre-per-session behavior).
      for (const [idx, meta] of map.entries()) {
        if (meta.kind === 'agent') map.set(idx, { ...meta, state });
      }
    }
    this.persistState(workspaceId);
    this.stateChangeEmitter.fire({ worktreeId: workspaceId, state: this.aggregateState(workspaceId), windowIndex });
    // Hook events are the heartbeat of a session — piggyback title syncing on them.
    this.refreshTitles(workspaceId).catch(() => {});
    this.scheduleTitleRefresh(workspaceId);
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

  getAgentCount(worktreeId: string): number {
    return [...(this.windows.get(worktreeId) ?? new Map()).values()]
      .filter(w => w.kind === 'agent').length;
  }

  getShellCount(worktreeId: string): number {
    return [...(this.windows.get(worktreeId) ?? new Map()).values()]
      .filter(w => w.kind === 'shell').length;
  }

  hasTerminals(worktreeId: string): boolean {
    return (this.windows.get(worktreeId)?.size ?? 0) > 0;
  }

  getViewer(worktreeId: string): vscode.Terminal | undefined {
    const v = this.viewers.get(worktreeId);
    return v && v.exitStatus === undefined ? v : undefined;
  }

  /** Legacy compat — returns viewer terminal. */
  getTerminal(worktreeId: string): vscode.Terminal | undefined {
    return this.getViewer(worktreeId);
  }

  getPlainTerminal(worktreeId: string): vscode.Terminal | undefined {
    return this.getViewer(worktreeId);
  }

  focus(worktreeId: string): void {
    this.viewers.get(worktreeId)?.show();
  }

  async killWindow(worktreeId: string, windowIndex: number): Promise<void> {
    const sessionName = TmuxManager.sessionName(worktreeId);
    await this.tmux.killWindow(sessionName, windowIndex);
    this.windows.get(worktreeId)?.delete(windowIndex);
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
   * Detach all tmux clients from a worktree's session, then dispose the viewer.
   * The tmux SESSION keeps running. The sh process exits cleanly after detach,
   * so VSCode won't show the "terminate running processes?" dialog.
   */
  async closeViewer(worktreeId: string): Promise<void> {
    const viewer = this.viewers.get(worktreeId);
    if (!viewer || viewer.exitStatus !== undefined) return;
    const sessionName = TmuxManager.sessionName(worktreeId);
    await this.tmux.detachClients(sessionName);
    // Wait for the sh process to exit (up to 400ms)
    await new Promise<void>(resolve => {
      const deadline = Date.now() + 400;
      const poll = () => {
        if (viewer.exitStatus !== undefined || Date.now() > deadline) resolve();
        else setTimeout(poll, 30);
      };
      poll();
    });
    viewer.dispose();
    this.viewers.delete(worktreeId);
  }

  async killWorktreeSession(worktreeId: string): Promise<void> {
    const sessionName = TmuxManager.sessionName(worktreeId);
    await this.tmux.killSession(sessionName);
    this.windows.delete(worktreeId);
    this.aliases.delete(worktreeId);
    this.persistAliases();
    this.viewers.get(worktreeId)?.dispose();
    this.viewers.delete(worktreeId);
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

  /** On extension reload, scan tmux sessions to restore tracked windows. */
  async reconnect(worktrees: Worktree[]): Promise<void> {
    for (const wt of worktrees) {
      const sessionName = TmuxManager.sessionName(wt.id);
      if (!(await this.tmux.hasSession(sessionName))) continue;

      const tmuxWindows = await this.tmux.listWindows(sessionName);
      const wm = this.windowMap(wt.id);
      for (const w of tmuxWindows) {
        // Skip the default session window (index 0, named after the shell)
        if (w.index === 0 && w.name !== 'shell' && !isAgentWindowName(w.name)) continue;
        const provider = providerForWindowName(w.name);
        const kind: 'agent' | 'shell' = provider ? 'agent' : 'shell';
        const title = kind === 'agent' ? this.cleanTitle(w.title, w.name) : this.commandTitle(w.command);
        // Restore each window's own pre-reload state (e.g. "permission"),
        // falling back to "waiting" when nothing was persisted for it.
        //
        // "terminated" is deliberately NOT restored. The window is still listed
        // in tmux, so something is there; whether its agent process is alive is
        // not knowable here, and "waiting" is the recoverable guess — any hook
        // event corrects it, whereas a stale "terminated" is a dead end that
        // paints a live agent as dead until you kill the window. (It also
        // unpoisons state wrongly persisted by a past liveness-detection bug.)
        const persisted = kind === 'agent' ? this.persistedState(wt.id, w.index) : undefined;
        const restoredState = kind === 'agent'
          ? (persisted && persisted !== 'terminated' ? persisted : 'waiting')
          : 'idle';
        wm.set(w.index, { kind, provider, state: restoredState, name: w.name, title });
        if (kind === 'agent') {
          this.stateChangeEmitter.fire({ worktreeId: wt.id, state: restoredState });
        }
      }
    }

    // Claim any viewer terminals VSCode auto-restored after reload.
    // Without this, closeViewer() can't find them and switching leaves phantom
    // terminals open, then creates duplicates on the next getOrCreateViewer().
    for (const terminal of vscode.window.terminals) {
      if (terminal.exitStatus !== undefined) continue;
      for (const wt of worktrees) {
        if (this.viewers.has(wt.id)) continue;
        if (terminal.name.startsWith(this.label(wt))) {
          this.viewers.set(wt.id, terminal);
          break;
        }
      }
    }

    this.syncShellPolling();
    this.terminalsChangeEmitter.fire();
  }

  dispose(): void {
    for (const timer of this.titleTimers.values()) clearTimeout(timer);
    this.titleTimers.clear();
    if (this.shellTimer) { clearInterval(this.shellTimer); this.shellTimer = undefined; }
    this.stateChangeEmitter.dispose();
    this.terminalsChangeEmitter.dispose();
  }
}
