import type { ProviderId } from './ports/IAgentProvider';

export type AgentSessionState = 'active' | 'waiting' | 'permission' | 'idle' | 'terminated';

export type PrStatus = { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; url: string } | null;

export type DockerContainerState = 'running' | 'stopped' | 'missing';

export interface DockerContainer {
  name: string;
  state: DockerContainerState;
}

export interface GitStatus {
  hasChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}

export interface Worktree {
  id: string;
  branch: string;
  alias?: string;
  path: string;
  repoRoot: string;
  xdebugPort: number;
  dockerProjectName: string;
  createdAt: number;
  isMain?: boolean;
}

export interface WorktreeState {
  worktree: Worktree;
  agent: AgentSessionState;
  docker: DockerContainer[];
  git: GitStatus;
  pr?: PrStatus | null;
}

export interface WorktreeStoreData {
  worktrees: Worktree[];
  portRegistry: Record<string, number>;
}

export interface DebugTemplate {
  type: string;
  request: string;
  name: string;
  port: string | number;
  pathMappings?: Record<string, string>;
  [key: string]: unknown;
}

export interface DockerConfig {
  /** Base compose file, relative to the worktree (default docker-compose.yml). */
  composeFile: string;
  /** Worktree-only override merged on top; carries the ${PORT} mappings. */
  overrideFile: string;
  /** Env var names to auto-generate a per-worktree port for (e.g. HTTP_PORT). */
  ports: string[];
  /** First port of the docker range (kept clear of the xdebug range). */
  basePort: number;
  /** Ports owned by each worktree = one contiguous block of this size. */
  portStride: number;
}

export interface UnmessConfig {
  worktreesDirectory: string;
  setupScript: string;
  teardownScript: string;
  /** Agent launched when no explicit provider is requested. */
  defaultProvider: ProviderId;
  claudeCommand: string;
  opencodeCommand: string;
  /** Toast when an agent finishes or asks for permission while unattended. */
  notifyOnAttention: boolean;
  /** Hide non-active worktree folders from search and Quick Open. */
  scopeSearchToActiveWorktree: boolean;
  /**
   * Clean-slate switching: close the other worktrees' editor tabs and viewer
   * terminals so only the active worktree is on screen. Off (the default) makes
   * switching a pure reveal — nothing is torn down, so there is no flicker and
   * VSCode keeps the tab order intact.
   */
  focusMode: boolean;
  /** Per-worktree docker orchestration (compose files + auto-generated ports). */
  docker: DockerConfig;
  xdebugBasePort: number;
  debugTemplate: DebugTemplate;
}

export type HookEntry = {
  matcher: string;
  hooks: { type: string; command: string }[];
};
