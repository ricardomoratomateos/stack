export type AgentState = 'active' | 'waiting' | 'permission' | 'idle' | 'terminated';

/** Coding agent kinds a session window can run (type-only import, erased at build). */
export type { ProviderId } from '../ports/IAgentProvider';
import type { ProviderId } from '../ports/IAgentProvider';

export interface GitStatus {
  hasChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  /** Against the branch's own upstream: "have I pushed?". */
  ahead: number;
  behind: number;
  /** Against the branch this worktree was cut from: "should I rebase?". */
  base?: BaseDrift;
}

export interface BaseDrift {
  /** What was compared against, e.g. "origin/develop". */
  ref: string;
  ahead: number;
  behind: number;
}

export interface DockerContainer {
  name: string;
  /** Docker's state, lowercased: running, exited, created, paused, restarting, dead. */
  state: string;
  /** Compose service name (shorter and steadier than the container name). */
  service?: string;
  /** Set for an exited container; non-zero means it crashed. */
  exitCode?: number;
  /** Docker's status line, e.g. "Exited (1) 2 minutes ago" or "Up 5 minutes". */
  status?: string;
}

/** One of the worktree's own auto-generated ports. */
export interface PortMapping {
  /** Env var name from `foreman.docker.ports`, e.g. HTTP_PORT. */
  name: string;
  port: number;
  /**
   * Whether opening `http://localhost:<port>` in a browser makes sense. False
   * for the debug port, which is a debugger listener and not a server.
   */
  openable: boolean;
}

export interface PrStatus {
  number: number;
  state: string;
}

export interface SessionItem {
  /** Window name from tmux — "claude", "shell". Says what is running. */
  name: string;
  /** What the user calls this session, if they have named it. Wins over `name`. */
  alias?: string;
  kind: 'agent' | 'shell';
  /** Which agent runs in this window (only for kind 'agent'). */
  provider?: ProviderId;
  state: AgentState;
  /** Live task title from the agent's terminal title (falls back to `name` in the UI). */
  title?: string;
  index: number;
}

export interface WorktreeItem {
  id: string;
  branch: string;
  alias?: string;
  path: string;
  isMain: boolean;
  deleting: boolean;
  agent: AgentState;
  agentCount: number;
  terminalCount: number;
  sessions: SessionItem[];
  git: GitStatus;
  /** Every container of the stack, stopped ones included (`ps -a`). */
  docker: DockerContainer[];
  /** Foreman is starting or stopping the stack right now; the button should not offer ▶/■. */
  dockerBusy?: 'starting' | 'stopping';
  /**
   * Why the last start/stop failed — compose's error, or Foreman's own (port
   * conflict, daemon down). Cleared by the next one that succeeds.
   */
  dockerError?: string;
  /** Ports this worktree owns — empty unless `foreman.docker.ports` is set. */
  ports: PortMapping[];
  pr?: PrStatus | null;
}

export interface ForemanState {
  worktrees: WorktreeItem[];
  activeWorktreeId?: string;
  /** Provider launched by the main agent button (foreman.defaultProvider). */
  defaultProvider?: ProviderId;
  /** Agents whose command resolves on PATH; the rest are shown dimmed. */
  installedProviders?: ProviderId[];
  /** Show the docker start/stop button (foreman.docker.ports configured). */
  dockerEnabled?: boolean;
  /**
   * Docker itself could not be listed on the last poll (daemon down or hung,
   * CLI missing). While set, an empty stack means "unknown", not "down".
   */
  dockerUnavailable?: string;
  /** Local branches offered as the base for a new worktree (filled on demand). */
  branches?: string[];
  /** Branch preselected as the base — the main repo's current branch. */
  baseBranch?: string;
}

// Extension → WebView
export type ExtMessage =
  | { type: 'state'; payload: ForemanState };

// WebView → Extension
export type WebMessage =
  | { type: 'launchAgent'; worktreeId: string; provider?: ProviderId }
  /** Choose which agent the card's big launch button starts. */
  | { type: 'pickDefaultProvider' }
  /** The webview finished mounting and is listening. See the handshake below. */
  | { type: 'ready' }
  /** Tell the user how to install an agent whose command is not on PATH. */
  | { type: 'showProviderInstall'; provider: ProviderId }
  | { type: 'openTerminal'; worktreeId: string }
  | { type: 'focusTerminal'; worktreeId: string }
  | { type: 'focusSession'; worktreeId: string; kind: 'agent' | 'shell'; index: number }
  | { type: 'killSession'; worktreeId: string; index: number }
  | { type: 'reorderSessions'; worktreeId: string; orderedIndexes: number[] }
  | { type: 'reorderWorktrees'; orderedIds: string[] }
  | { type: 'renameSession'; worktreeId: string; index: number }
  | { type: 'openPort'; port: number }
  | { type: 'refreshDrift'; worktreeId: string }
  | { type: 'dockerUp'; worktreeId: string }
  | { type: 'dockerDown'; worktreeId: string }
  | { type: 'deleteWorktree'; worktreeId: string }
  | { type: 'renameWorktree'; worktreeId: string }
  | { type: 'initWorktree'; worktreeId: string }
  | { type: 'openDiff'; worktreeId: string }
  /** The empty-state "New agent" button opens the full-screen panel. */
  | { type: 'openNewTask' }
  | { type: 'createWorktree'; branch: string; title?: string; description?: string; baseBranch?: string }
  | { type: 'listBranches' }
  | { type: 'selectWorktree'; worktreeId: string };
