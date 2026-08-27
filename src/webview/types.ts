export type AgentState = 'active' | 'waiting' | 'permission' | 'idle' | 'terminated';

/** Coding agent kinds a session window can run (type-only import, erased at build). */
export type { ProviderId } from '../ports/IAgentProvider';
import type { ProviderId } from '../ports/IAgentProvider';

export interface GitStatus {
  hasChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}

export interface DockerContainer {
  name: string;
  state: string;
}

/** One of the worktree's own auto-generated ports. */
export interface PortMapping {
  /** Env var name from `unmess.docker.ports`, e.g. HTTP_PORT. */
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
  name: string;
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
  docker: DockerContainer[];
  /** Ports this worktree owns — empty unless `unmess.docker.ports` is set. */
  ports: PortMapping[];
  pr?: PrStatus | null;
}

export interface UnmessState {
  worktrees: WorktreeItem[];
  activeWorktreeId?: string;
  /** Provider launched by the main agent button (unmess.defaultProvider). */
  defaultProvider?: ProviderId;
  /** Agents whose command resolves on PATH; the rest are shown dimmed. */
  installedProviders?: ProviderId[];
  /** Show the docker start/stop button (unmess.docker.ports configured). */
  dockerEnabled?: boolean;
  /** Local branches offered as the base for a new worktree (filled on demand). */
  branches?: string[];
  /** Branch preselected as the base — the main repo's current branch. */
  baseBranch?: string;
}

// Extension → WebView
export type ExtMessage =
  | { type: 'state'; payload: UnmessState }
  /** The native "+" in the view header asks the webview to open its new-task modal. */
  | { type: 'openNewTask' };

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
  | { type: 'openPort'; port: number }
  | { type: 'dockerUp'; worktreeId: string }
  | { type: 'dockerDown'; worktreeId: string }
  | { type: 'deleteWorktree'; worktreeId: string }
  | { type: 'renameWorktree'; worktreeId: string }
  | { type: 'initWorktree'; worktreeId: string }
  | { type: 'openDiff'; worktreeId: string }
  | { type: 'createWorktree'; branch: string; title?: string; description?: string; baseBranch?: string }
  | { type: 'listBranches' }
  | { type: 'selectWorktree'; worktreeId: string };
