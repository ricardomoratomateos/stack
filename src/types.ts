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
  /** Against the branch's own upstream: "have I pushed?". */
  ahead: number;
  behind: number;
  /**
   * Against the branch this worktree was cut from: "should I rebase?".
   *
   * A different question from ahead/behind, and the one that actually goes
   * stale while you work. Absent when there is no base to compare to — the main
   * worktree, a base branch that no longer exists, a comparison git refused.
   */
  base?: BaseDrift;
}

export interface BaseDrift {
  /** What was compared against, e.g. "origin/develop" or "develop". */
  ref: string;
  /** Commits on this branch that the base does not have. */
  ahead: number;
  /** Commits on the base that this branch does not have. */
  behind: number;
}

export interface Worktree {
  id: string;
  branch: string;
  alias?: string;
  path: string;
  repoRoot: string;
  debugPort: number;
  dockerProjectName: string;
  createdAt: number;
  isMain?: boolean;
  /**
   * Branch this worktree was cut from, recorded at creation.
   *
   * Kept per worktree rather than read from the setting at display time: a
   * worktree started off release/3.2 must keep measuring against release/3.2
   * after the setting moves on. Absent for worktrees adopted from git, which
   * carry no record of it — those fall back to the configured base.
   */
  baseBranch?: string;
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
  /** First port of the docker range (kept clear of the debug range). */
  basePort: number;
  /** Ports owned by each worktree = one contiguous block of this size. */
  portStride: number;
}

export interface ForemanConfig {
  worktreesDirectory: string;
  /**
   * Branch new worktrees start from. Without this, the base was whatever the
   * main checkout happened to be sitting on, so parking it on a feature branch
   * silently made every new worktree a child of that feature branch.
   */
  defaultBaseBranch: string;
  setupScript: string;
  teardownScript: string;
  /** Agent launched when no explicit provider is requested. */
  defaultProvider: ProviderId;
  claudeCommand: string;
  codexCommand: string;
  grokCommand: string;
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
  debugBasePort: number;
  debugTemplate: DebugTemplate;
}

export type HookEntry = {
  matcher: string;
  hooks: { type: string; command: string }[];
};
