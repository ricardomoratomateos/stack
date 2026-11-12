import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Emitter } from '../core/Emitter';
import { JsonFileStore } from '../core/JsonFileStore';
import type { KeyValueStore } from '../core/KeyValueStore';
import type { StackState } from '../webview/types';
import type { ProviderId } from '../ports/IAgentProvider';
import { PROVIDER_IDS } from '../ports/IAgentProvider';
import type { Worktree, WorktreeTicket } from '../types';
import { AgentSessionManager } from '../session/AgentSessionManager';
import { AttentionNotifier } from '../session/AttentionNotifier';
import { TmuxManager } from '../session/TmuxManager';
import { ProviderFactory } from '../providers/ProviderFactory';
import { HookRoutes } from '../providers/shared/HookRoutes';
import { ConfigFileError } from '../providers/shared/configFile';
import { HookServer } from '../server/HookServer';
import { GitWatcher } from '../git/GitWatcher';
import { PrMonitor } from '../pr/PrMonitor';
import { GitCliAdapter } from '../adapters/GitCliAdapter';
import { OsaNotifyAdapter } from '../adapters/OsaNotifyAdapter';
import { NodeFileSystem } from '../adapters/NodeFileSystem';
import { WorktreeStore } from '../worktree/WorktreeStore';
import { WorktreeManager } from '../worktree/WorktreeManager';
import { PortAllocator } from '../worktree/portAllocator';
import { PortReservationFile } from '../worktree/portReservations';
import { worktreesInRepo, canonicalPath } from '../worktree/worktreesInRepo';
import { buildControlSession } from '../worktree/controlSession';
import { WorktreeApplicationService } from '../application/WorktreeApplicationService';
import { ManagerTools } from '../mcp/ManagerTools';
import { WindowRegistry } from '../mcp/WindowRegistry';
import { resolveWindow } from '../mcp/discovery';
import type { ApiRequest, ApiResponse, WindowFile } from '../mcp/protocol';
import { BRIDGE_FILE } from '../mcp/protocol';
import { bridgeCommand, installBridge, type BridgeCommand } from '../mcp/workerMcp';
import { claudeBinary, enableManager, execRun, managerStatus, type Run } from '../mcp/registration';
import { installClaudeAssets } from '../mcp/claudeAssets';
import { NodeConfig } from './NodeConfig';
import { HeadlessHost, headlessTerminals, LogNotify, NO_BREAKPOINTS, NO_TABS, stateLike } from './headless';
import { readVsCodeGlobalState } from './vscodeState';

/** Keys of the daemon's own, next to the ones the core keeps in the same file. */
const REPOS_KEY = 'stackd.repos';
const IMPORTED_KEY = 'stackd.imported';

export interface DaemonOptions {
  /** `~/.config/stack`: state.json, settings.json, hook routes, discovery files, the socket. */
  configDir: string;
  /** Where the agents' own configs live (`~/.claude`, `~/.codex`). Defaults to the user's home. */
  home?: string;
  /** `tmux -L <name>`: a tmux server of its own. Default: the user's server. */
  tmuxSocket?: string;
  /** Install the agents' hooks (global files under `home`). Default true. */
  installHooks?: boolean;
  /** One-time import of the VS Code extension's state; default reads VS Code's own store. */
  importState?: () => Promise<Record<string, unknown>>;
  /**
   * Do not import at start: a client will hand its state over with the
   * `importState` command (the extension has its live Memento, which VS Code's
   * sqlite file may lag behind).
   */
  deferImport?: boolean;
  /** The MCP bridge to hand workers (`dist/stack-mcp.js`); none: workers start without it. */
  bridgeSource?: string;
  /** The manager skill and commands to install into ~/.claude (resources/claude); none: MCP registration only. */
  claudeAssets?: string;
  /** Runs `claude mcp …` for enableManager; default execFile. */
  run?: Run;
  /** Native notification sink for "the agent needs you"; default `osascript`. */
  notify?: (message: string) => void;
  log?: (line: string) => void;
}

interface RepoContext {
  root: string;
  config: NodeConfig;
  service: WorktreeApplicationService;
  tools: ManagerTools;
}

/** One repository's slice of the snapshot. */
export interface RepoSnapshot {
  repoRoot: string;
  state: StackState;
}

export interface Snapshot {
  /** Bumped on every change: a client can tell "new" from "same". */
  seq: number;
  tmux: { socket?: string };
  repos: RepoSnapshot[];
}

export class CommandError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Body = Record<string, unknown>;

/** The sidebar messages the daemon runs itself (see the `message` command). */
const DAEMON_MESSAGES = ['reorderSessions', 'reorderWorktrees', 'setupAction', 'refreshDrift', 'forgetWorktree'];

const str = (b: Body, k: string): string | undefined => {
  const v = b[k];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new CommandError(`"${k}" must be a string.`);
  return v;
};
const need = (b: Body, k: string): string => str(b, k) ?? (() => { throw new CommandError(`"${k}" is required.`); })();
const provider = (b: Body): ProviderId | undefined => {
  const p = str(b, 'provider');
  if (p !== undefined && !PROVIDER_IDS.includes(p as ProviderId)) throw new CommandError(`Unknown provider "${p}".`);
  return p as ProviderId | undefined;
};
const windowIndex = (b: Body): number | undefined => {
  const v = b['windowIndex'];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new CommandError('"windowIndex" must be a non-negative integer.');
  return v;
};

/**
 * `stackd serve`: the single owner of Stack's state for one user, all repos.
 *
 * Composes the core (session manager, hook server, MCP tools, git watcher,
 * PR monitor, one WorktreeApplicationService per repository) over
 * Node adapters, keeps its state in `<configDir>/state.json`, and answers the
 * agents' hooks. The HTTP/SSE API in front of it lives in api.ts; everything
 * it can do is here, as `snapshot()` and `command()`.
 */
export class StackDaemon {
  readonly store: KeyValueStore;
  readonly tmux: TmuxManager;
  readonly agents: AgentSessionManager;
  readonly hooks: HookServer;
  readonly routes: HookRoutes;
  readonly registry: WindowRegistry;
  private readonly providers: ProviderFactory;
  private readonly git = new GitWatcher();
  private readonly pr = new PrMonitor();
  private readonly worktreeStore: WorktreeStore;
  private readonly attention: AttentionNotifier;
  private readonly repos = new Map<string, RepoContext>();
  private readonly changes = new Emitter<void>();
  private readonly log: (line: string) => void;
  private hookUrl = '';
  private seq = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private bridge?: BridgeCommand;
  /** `<configDir>/stack-mcp.js`, once installed: what Claude Code is pointed at. */
  private bridgePath?: string;
  private readonly global: NodeConfig;
  private readonly settingsPath: string;
  /** Settings clients pushed with `setSettings`; see NodeConfig. */
  private pushed: Record<string, unknown> = {};
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  /** How many clients follow `/events`; the API server keeps it current. */
  clients: () => number = () => 0;

  /** Fires (debounced) whenever anything a client shows may have changed. */
  readonly onChange = this.changes.event;

  constructor(private readonly opts: DaemonOptions) {
    this.log = opts.log ?? (() => {});
    const dir = opts.configDir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.settingsPath = path.join(dir, 'settings.json');
    this.store = new JsonFileStore(path.join(dir, 'state.json'));
    this.worktreeStore = new WorktreeStore({ globalState: this.store });
    this.tmux = new TmuxManager(opts.tmuxSocket);

    if (opts.bridgeSource) {
      try {
        const installed = installBridge(opts.bridgeSource, dir);
        if (installed) {
          this.bridgePath = installed;
          this.bridge = bridgeCommand(installed);
        }
      } catch (e) {
        this.log(`[stackd] installing the MCP bridge (${BRIDGE_FILE}) failed: ${String(e)}`);
      }
    }
    const global = new NodeConfig(() => undefined, this.settingsPath, () => this.pushed);
    this.global = global;
    this.providers = new ProviderFactory(global, dir, opts.home, () => this.bridge);
    this.agents = new AgentSessionManager(this.providers, this.store, this.tmux, undefined, undefined, undefined, () => 'perSession', () => global.get().promptPrefix, headlessTerminals());
    this.hooks = new HookServer(this.agents);
    this.routes = new HookRoutes(dir);
    this.registry = new WindowRegistry(dir);

    const osa = new OsaNotifyAdapter();
    this.attention = new AttentionNotifier({
      onStateChange: this.agents.onStateChange,
      labelFor: (id) => this.labelFor(id),
      sessionTitle: (id, index) => this.agents.getSessions(id).find((s) => s.index === index)?.title,
      isWatching: () => false,
      enabled: () => global.get().notifyOnAttention,
      // A connected client (the extension) shows its own badge and notification, and
      // knows whether its window has the focus; the daemon speaks only when nobody listens.
      notify: (message) => { if (this.clients() === 0) (opts.notify ?? ((m: string) => osa.notify(m)))(message); },
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.opts.deferImport) await this.importOnce();
    this.hookUrl = await this.hooks.start();
    this.routes.setDefault(this.hookUrl);

    if (this.opts.installHooks !== false) {
      for (const p of this.providers.all()) {
        try {
          p.installHooks(this.hookUrl);
        } catch (e) {
          this.log(e instanceof ConfigFileError ? e.message : `[stackd] could not install the ${p.label} hooks: ${String(e)}`);
        }
      }
    }

    this.subscriptions.push(
      this.agents.onStateChange(() => this.changed()),
      this.agents.onTerminalsChange(() => { this.claimRoutes(); this.changed(); }),
      this.hooks.onHookEvent((e) => {
        this.agents.noteSession(e);
        if (this.agents.noteHookEvent(e)) this.changed();
        if (e.event === 'UserPromptSubmit' && e.workspaceId) void this.contextOf(e.workspaceId)?.service.clearReview(e.workspaceId);
      }),
    );

    this.hooks.setApi({ token: this.registry.token, handle: (tool, request) => this.handleTool(tool, request) });
    try { this.registry.sweep(); } catch { /* best effort */ }
    this.updateRegistry();

    await this.loadKnownRepos();
  }

  /** Every repository this user has worktrees for, plus the ones added explicitly. */
  private async loadKnownRepos(): Promise<void> {
    const roots = new Set<string>(this.store.get<string[]>(REPOS_KEY, []));
    for (const wt of this.worktreeStore.getAll()) if (wt.repoRoot) roots.add(wt.repoRoot);
    for (const root of roots) {
      await this.addRepo(root).catch((e: unknown) => this.log(`[stackd] could not load ${root}: ${String(e)}`));
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.subscriptions) s.dispose();
    this.attention.dispose();
    this.agents.dispose();
    this.git.dispose();
    this.pr.dispose();
    try { this.routes.release(this.hookUrl); } catch { /* best effort */ }
    this.registry.dispose();
    this.hooks.dispose();
    this.changes.dispose();
  }

  /**
   * First run: bring the extension's state over (worktrees, sessions, aliases)
   * so nothing is lost by switching. Never overwrites what is already here,
   * and runs once — the extension keeps its own copy until T3b.
   */
  private async importOnce(): Promise<void> {
    if (this.store.get<boolean>(IMPORTED_KEY, false)) return;
    let seed: Record<string, unknown> = {};
    try { seed = await (this.opts.importState ?? (() => readVsCodeGlobalState()))(); } catch { /* nothing to import */ }
    let copied = 0;
    for (const [key, value] of Object.entries(seed)) {
      if (!key.startsWith('stack.') || this.store.get<unknown>(key, undefined) !== undefined) continue;
      await this.store.update(key, value);
      copied++;
    }
    await this.store.update(IMPORTED_KEY, true);
    if (copied > 0) this.log(`[stackd] imported ${copied} keys from the VS Code extension's state`);
  }

  // ── Repositories ──────────────────────────────────────────────────────────

  /** Starts managing a repository (idempotent): loads its worktrees, watches them, reconnects its sessions. */
  async addRepo(repoRoot: string): Promise<RepoContext> {
    const key = canonicalPath(repoRoot);
    const known = [...this.repos.values()].find((r) => canonicalPath(r.root) === key);
    if (known) return known;
    if (!fs.existsSync(path.join(repoRoot, '.git'))) throw new CommandError(`${repoRoot} is not a git repository.`);

    const config = new NodeConfig(() => repoRoot, this.settingsPath, () => this.pushed);
    // The window-scoped parts of the service, kept per repository in the one store.
    const scoped = stateLike(this.store, `repo:${key}:`);
    const portAllocator = new PortAllocator(this.worktreeStore, () => config.get().debugBasePort, {
      config: () => config.get(),
      shared: new PortReservationFile(this.opts.configDir),
    });
    const manager = new WorktreeManager(this.worktreeStore, portAllocator, config, this.agents, new GitCliAdapter(), new NodeFileSystem());
    const service = new WorktreeApplicationService({
      manager,
      agentManager: this.agents,
      tabManager: NO_TABS,
      breakpointManager: NO_BREAKPOINTS,
      store: this.worktreeStore,
      config: config,
      notify: new LogNotify(this.log),
      host: new HeadlessHost(repoRoot, this.log),
      git: new GitCliAdapter(),
      gitWatcher: this.git,
      prMonitor: this.pr,
      globalState: stateLike(this.store),
      workspaceState: scoped,
    });
    service.setUi({
      pushWebview: () => this.changed(),
      syncDecorations() {},
      openDiffPanel() {},
      openNewTask() {},
    });
    const tools = new ManagerTools({
      repoRoot: () => repoRoot,
      worktrees: () => service.windowWorktrees(),
      items: () => service.buildState().worktrees,
      createWorktree: async (o) => { const r = await service.createWorktree(o); this.claimRoutes(); return r; },
      deleteWorktree: (id, o) => service.deleteWorktreeById(id, o),
      launchAgent: async (id, prompt) => {
        const wt = service.windowWorktrees().find((w) => w.id === id);
        if (!wt) return false;
        await this.agents.launchWithPrompt(wt, prompt);
        return true;
      },
      requestReview: (id, summary) => service.requestReview(id, summary),
      clearReview: (id) => service.clearReview(id),
      taskEnv: (id) => service.taskEnv(id),
      sendPrompt: (wt, text, index) => this.agents.sendPromptToAgent(wt, text, index),
      capturePane: (id, index, lines) => this.agents.capturePane(id, index, lines),
      agentState: (id) => this.agents.getState(id),
      onStateChange: (listener) => this.agents.onStateChange(listener),
    });
    const ctx: RepoContext = { root: repoRoot, config, service, tools };
    this.repos.set(repoRoot, ctx);
    const roots = new Set(this.store.get<string[]>(REPOS_KEY, []));
    if (!roots.has(repoRoot)) await this.store.update(REPOS_KEY, [...roots, repoRoot]);

    await service.start();
    this.claimRoutes();
    this.updateRegistry();
    this.changed();
    return ctx;
  }

  private contextOf(worktreeId: string): RepoContext | undefined {
    for (const ctx of this.repos.values()) {
      if (buildControlSession(ctx.root).id === worktreeId) return ctx;
      if (ctx.service.windowWorktrees().some((w) => w.id === worktreeId)) return ctx;
    }
    return undefined;
  }

  private findWorktree(id: string): { wt: Worktree; ctx: RepoContext } {
    for (const ctx of this.repos.values()) {
      const control = buildControlSession(ctx.root);
      if (control.id === id) return { wt: control, ctx };
      const wt = ctx.service.windowWorktrees().find((w) => w.id === id);
      if (wt) return { wt, ctx };
    }
    throw new CommandError(`No worktree "${id}".`, 404);
  }

  private repoFor(b: Body): RepoContext {
    const repo = str(b, 'repo');
    if (!repo) {
      if (this.repos.size === 1) return [...this.repos.values()][0];
      throw new CommandError('"repo" is required.');
    }
    const key = canonicalPath(repo);
    const ctx = [...this.repos.values()].find((r) => canonicalPath(r.root) === key);
    if (!ctx) throw new CommandError(`Not managing ${repo}; add it first (addRepo).`, 404);
    return ctx;
  }

  private labelFor(id: string): string | undefined {
    const wt = this.worktreeStore.getAll().find((w) => w.id === id);
    if (wt) return wt.alias ?? wt.branch;
    for (const ctx of this.repos.values()) if (buildControlSession(ctx.root).id === id) return 'Manager';
    return undefined;
  }

  /** Points every worktree's hooks at this daemon, and tells the MCP bridge where it is. */
  private claimRoutes(): void {
    try {
      const ids: string[] = [];
      for (const ctx of this.repos.values()) {
        ids.push(buildControlSession(ctx.root).id, ...ctx.service.windowWorktrees().map((w) => w.id));
      }
      this.routes.claim(ids, this.hookUrl);
    } catch { /* best effort */ }
    this.updateRegistry();
  }

  private updateRegistry(): void {
    if (!this.hookUrl) return;
    try {
      const roots = [...this.repos.keys()];
      this.registry.update({
        port: this.hooks.listeningPort,
        repoRoots: [...new Set([...roots, ...this.worktreeStore.getAll().map((w) => w.path)])],
        workspaceFolders: roots,
        worktreeIds: this.worktreeStore.getAll().map((w) => w.id),
      });
      this.registry.focus();
    } catch (e) {
      this.log(`[stackd] writing the discovery file failed: ${String(e)}`);
    }
  }

  // ── State ─────────────────────────────────────────────────────────────────

  private changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.seq++;
      this.changes.fire();
    }, 25);
  }

  snapshot(): Snapshot {
    return {
      seq: this.seq,
      tmux: { socket: this.opts.tmuxSocket },
      repos: [...this.repos.values()].map((ctx) => ({ repoRoot: ctx.root, state: ctx.service.buildState() })),
    };
  }

  // ── MCP: the manager agent's tools, routed to the repo they are about ─────

  private async handleTool(tool: string, request: ApiRequest): Promise<ApiResponse> {
    const windows: WindowFile[] = [...this.repos.values()].map((ctx, i) => ({
      pid: i, port: 0, token: '', focusedAt: 0,
      repoRoots: [ctx.root, ...worktreesInRepo(this.worktreeStore.getAll(), ctx.root).map((w) => w.path)],
      workspaceFolders: [ctx.root],
      worktreeIds: ctx.service.windowWorktrees().map((w) => w.id),
    }));
    const args = request.args ?? {};
    const repo = typeof args.repo === 'string' ? args.repo : undefined;
    const taskId = typeof args.task_id === 'string' ? args.task_id : request.context?.taskId;
    const paths = [request.context?.cwd].filter((p): p is string => !!p);
    // stackd is answering, so "none" means no repository has been added yet, not that Stack is down.
    if (windows.length === 0) return { ok: false, error: 'No repository is in Stack yet: add one in Stack.app.' };
    const resolved = resolveWindow(windows, { repo, taskId, paths });
    if ('error' in resolved) return { ok: false, error: resolved.error };
    const ctx = [...this.repos.values()][resolved.window.pid];
    return ctx.tools.handle(tool, request);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  /** What a client can ask for; each takes a JSON object and answers one. */
  async command(name: string, b: Body): Promise<unknown> {
    switch (name) {
      case 'addRepo': {
        const ctx = await this.addRepo(need(b, 'repo'));
        return { repoRoot: ctx.root };
      }
      case 'createTask': {
        const ctx = this.repoFor(b);
        const ticket = b['ticket'] as WorktreeTicket | undefined;
        const result = await ctx.service.createWorktree({
          branch: need(b, 'branch'), title: str(b, 'title'), description: str(b, 'description'),
          baseBranch: str(b, 'baseBranch'), provider: provider(b), ticket, silent: true, select: false,
        });
        this.claimRoutes();
        if (!result.ok) throw new CommandError(result.error ?? 'Could not create the task.');
        return { worktree: result.worktree };
      }
      case 'deleteTask': {
        const { wt, ctx } = this.findWorktree(need(b, 'worktreeId'));
        const result = await ctx.service.deleteWorktreeById(wt.id, { deleteBranch: b['deleteBranch'] === true });
        if (!result.ok) throw new CommandError(result.error ?? 'Could not delete the task.');
        this.claimRoutes();
        return {};
      }
      case 'spawnAgent': {
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        const before = new Set(this.agents.getSessions(wt.id).map((s) => s.index));
        await this.agents.launch(wt, { provider: provider(b), prompt: str(b, 'prompt') });
        return { windowIndex: this.newWindow(wt.id, before) };
      }
      case 'resumeAgent': {
        // The task's tmux session did not survive (a restart): its agents again, on their conversations.
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        if ((await this.agents.resume(wt)) === 0) throw new CommandError('Nothing to resume for that task.', 409);
        return { windowIndex: this.agents.getSessions(wt.id)[0]?.index };
      }
      case 'spawnShell': {
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        const before = new Set(this.agents.getSessions(wt.id).map((s) => s.index));
        await this.agents.openTerminal(wt);
        return { windowIndex: this.newWindow(wt.id, before) };
      }
      case 'killWindow': {
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        const index = windowIndex(b);
        if (index === undefined) throw new CommandError('"windowIndex" is required.');
        await this.agents.killWindow(wt.id, index);
        return {};
      }
      case 'sendToAgent': {
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        const delivered = await this.agents.sendPromptToAgent(wt, need(b, 'text'), windowIndex(b));
        if (!delivered) throw new CommandError('No live agent took the message.', 409);
        return {};
      }
      case 'respondPermission': {
        // v1: keys to the pane. `allow` is Enter (the default choice of the agents' prompts), `deny` is Escape.
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        const index = windowIndex(b);
        if (index === undefined) throw new CommandError('"windowIndex" is required.');
        const answer = str(b, 'answer');
        const keys = Array.isArray(b['keys']) ? (b['keys'] as unknown[]).map(String)
          : answer === 'allow' ? ['Enter'] : answer === 'deny' ? ['Escape'] : undefined;
        if (!keys || keys.length === 0) throw new CommandError('Give "answer" (allow|deny) or "keys".');
        const target = `${TmuxManager.sessionName(wt.id)}:${index}`;
        for (const key of keys) await this.tmux.sendKey(target, key);
        return {};
      }
      case 'attachTarget': {
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        const session = TmuxManager.sessionName(wt.id);
        if (!(await this.tmux.hasSession(session))) throw new CommandError('That worktree has no tmux session yet.', 409);
        const index = windowIndex(b);
        // The extension attaches a plain tmux client, which shows the session's current window;
        // the desktop app picks panes itself and passes `select: false` (one tmux exec less, and
        // other clients' current window left alone).
        if (index !== undefined && b['select'] !== false) await this.tmux.selectWindow(session, index);
        const socket = this.opts.tmuxSocket;
        return {
          socket, session, window: index,
          target: index === undefined ? `=${session}` : `=${session}:${index}`,
          command: ['tmux', ...(socket ? ['-L', socket] : []), 'attach', '-t', `=${session}`],
        };
      }
      case 'importState': {
        // The extension's live Memento (global keys, and the window's workspace keys for its repo).
        const global = (b['global'] ?? {}) as Record<string, unknown>;
        const workspace = (b['workspace'] ?? {}) as Record<string, unknown>;
        const repo = str(b, 'repo');
        let copied = 0;
        const copy = async (prefix: string, values: Record<string, unknown>): Promise<void> => {
          for (const [key, value] of Object.entries(values)) {
            if (!key.startsWith('stack.') || this.store.get<unknown>(prefix + key, undefined) !== undefined) continue;
            await this.store.update(prefix + key, value);
            copied++;
          }
        };
        if (!this.store.get<boolean>(IMPORTED_KEY, false)) {
          await copy('', global);
          await this.store.update(IMPORTED_KEY, true);
        }
        if (repo) {
          const marker = `${IMPORTED_KEY}:${canonicalPath(repo)}`;
          if (!this.store.get<boolean>(marker, false)) {
            await copy(`repo:${canonicalPath(repo)}:`, workspace);
            await this.store.update(marker, true);
          }
        }
        if (copied > 0) {
          this.log(`[stackd] imported ${copied} keys from the extension's state`);
          await this.loadKnownRepos();
        }
        return { copied };
      }
      case 'setSettings': {
        this.pushed = (b['values'] && typeof b['values'] === 'object' ? b['values'] : {}) as Record<string, unknown>;
        this.changed();
        return {};
      }
      case 'message': {
        // The sidebar's own messages that act on state alone; the ones that open terminals or ask questions stay with the client.
        const msg = b['message'] as { type?: string; worktreeId?: string } | undefined;
        if (!msg || typeof msg.type !== 'string' || !DAEMON_MESSAGES.includes(msg.type)) throw new CommandError('Not a daemon message.');
        const ctx = typeof msg.worktreeId === 'string' ? this.findWorktree(msg.worktreeId).ctx : this.repoFor(b);
        await ctx.service.handleMessage(msg as never);
        return {};
      }
      case 'renameTask': {
        const { wt, ctx } = this.findWorktree(need(b, 'worktreeId'));
        await ctx.service.setWorktreeAlias(wt.id, typeof b['alias'] === 'string' ? b['alias'] : '');
        return {};
      }
      case 'renameSession': {
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        const index = windowIndex(b);
        if (index === undefined) throw new CommandError('"windowIndex" is required.');
        this.agents.setSessionAlias(wt.id, index, typeof b['name'] === 'string' ? b['name'] : '');
        this.changed();
        return {};
      }
      case 'initTask': {
        const { wt, ctx } = this.findWorktree(need(b, 'worktreeId'));
        await ctx.service.initWorktree(wt);
        return {};
      }
      case 'refreshGit': {
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        if (fs.existsSync(wt.path)) await this.git.refreshNow(wt.path);
        return {};
      }
      case 'getDiff': {
        const { wt, ctx } = this.findWorktree(need(b, 'worktreeId'));
        const base = b['base'] === 'working' ? 'working' : 'branch';
        return { unified: await ctx.service.getDiff(wt.id, base) };
      }
      case 'sendComments': {
        const { wt, ctx } = this.findWorktree(need(b, 'worktreeId'));
        const destination = str(b, 'destination');
        if (destination !== 'live' && destination !== 'new') throw new CommandError('"destination" must be live or new.');
        const comments = Array.isArray(b['comments']) ? (b['comments'] as never[]) : [];
        const before = new Set(this.agents.getSessions(wt.id).map((s) => s.index));
        const went = await ctx.service.send(wt.id, destination, comments);
        // A fresh agent: its window, so the app can show it picking the comments up.
        return { went, ...(went === 'new' ? { index: this.newWindow(wt.id, before) } : {}) };
      }
      case 'paste': {
        const { wt } = this.findWorktree(need(b, 'worktreeId'));
        await this.agents.pasteToActiveWindow(wt.id, need(b, 'text'), windowIndex(b));
        return {};
      }
      case 'newTaskInit': {
        return this.repoFor(b).service.newTaskInit();
      }
      case 'managerStatus': {
        return managerStatus(path.join(this.home, '.claude.json'), this.bridgePath);
      }
      case 'enableManager': {
        // The stable copy of the bridge, run by the node this daemon runs on: both outlive app updates.
        if (!this.bridgePath) throw new CommandError(`The MCP bridge (${BRIDGE_FILE}) is missing from this build.`, 409);
        const run = this.opts.run ?? execRun;
        const result = await enableManager(run, claudeBinary(this.global.get().claudeCommand), { command: process.execPath, args: [this.bridgePath] });
        if (!result.ok) throw new CommandError(result.message, 409);
        let message = result.message;
        if (this.opts.claudeAssets) {
          try {
            const { skipped } = installClaudeAssets(path.join(this.home, '.claude'), this.opts.claudeAssets);
            message += ' Try /stack, /stack-task or /stack-next.';
            if (skipped.length) message += ` (Kept your own ${skipped.join(', ')}.)`;
          } catch (e) {
            this.log(`[stackd] could not install the Claude skill/commands: ${String(e)}`);
          }
        }
        return { message, ...managerStatus(path.join(this.home, '.claude.json'), this.bridgePath) };
      }
      default:
        throw new CommandError(`Unknown command "${name}".`, 404);
    }
  }

  /** Where ~/.claude and ~/.claude.json live. */
  private get home(): string {
    return this.opts.home ?? os.homedir();
  }

  private newWindow(worktreeId: string, before: Set<number>): number | undefined {
    return this.agents.getSessions(worktreeId).map((s) => s.index).find((i) => !before.has(i));
  }
}
