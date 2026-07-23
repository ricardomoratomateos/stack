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
  pr?: PrStatus | null;
}

export interface UnmessState {
  worktrees: WorktreeItem[];
  activeWorktreeId?: string;
  /** Provider launched by the main agent button (unmess.defaultProvider). */
  defaultProvider?: ProviderId;
  /** Show the docker start/stop button (unmess.docker.ports configured). */
  dockerEnabled?: boolean;
}

// Extension → WebView
export type ExtMessage = { type: 'state'; payload: UnmessState };

// WebView → Extension
export type WebMessage =
  | { type: 'launchAgent'; worktreeId: string; provider?: ProviderId }
  | { type: 'pickAgent'; worktreeId: string }
  | { type: 'openTerminal'; worktreeId: string }
  | { type: 'focusTerminal'; worktreeId: string }
  | { type: 'focusSession'; worktreeId: string; kind: 'agent' | 'shell'; index: number }
  | { type: 'killSession'; worktreeId: string; index: number }
  | { type: 'attachScreenshot'; worktreeId: string; index: number }
  | { type: 'dockerUp'; worktreeId: string }
  | { type: 'dockerDown'; worktreeId: string }
  | { type: 'deleteWorktree'; worktreeId: string }
  | { type: 'renameWorktree'; worktreeId: string }
  | { type: 'initWorktree'; worktreeId: string }
  | { type: 'openDiff'; worktreeId: string }
  | { type: 'createWorktree'; branch: string; title?: string; description?: string }
  | { type: 'selectWorktree'; worktreeId: string };
