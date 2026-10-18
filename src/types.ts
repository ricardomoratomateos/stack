import type { ProviderId } from './ports/IAgentProvider';
import type { SidebarStyle } from './sidebarStyle';

export type AgentSessionState = 'active' | 'waiting' | 'permission' | 'idle' | 'terminated';

/** The PR's checks, summed up: any failure fails, else anything unfinished is pending. */
export type PrCi = 'pass' | 'fail' | 'pending';

export type PrStatus = {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  isDraft?: boolean;
  /** GitHub's own verdict; absent when the repository requires no review. */
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
  /** Absent when the PR has no checks at all. */
  ci?: PrCi;
} | null;

/**
 * Docker's own container state, lowercased: running, exited, created, paused,
 * restarting, dead, removing. Kept as docker reports it rather than folded into
 * running/stopped — "created" (never started, usually a port clash) and
 * "exited" (crashed) are different problems with different fixes.
 */
export type DockerContainerState = string;

export interface DockerContainer {
  name: string;
  state: DockerContainerState;
  /** Compose service the container runs. */
  service?: string;
  /** Exit code of an exited container; non-zero is why the stack is down. */
  exitCode?: number;
  /** Docker's status line, e.g. "Exited (1) 2 minutes ago". */
  status?: string;
  /** Host ports it publishes — so its own stack's ports are not mistaken for a stranger's. */
  ports?: number[];
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
   * The branch has an upstream to be ahead or behind of. Only ever present,
   * and then true: without one, ahead/behind are 0 and mean nothing — every
   * commit on the branch is local.
   */
  upstream?: true;
  /**
   * Against the branch this worktree was cut from: "should I rebase?".
   *
   * A different question from ahead/behind, and the one that actually goes
   * stale while you work. Absent when there is no base to compare to — the main
   * worktree, a base branch that no longer exists, a comparison git refused.
   */
  base?: BaseDrift;
  /**
   * Lines added and removed since the branch left its base (the main worktree:
   * since HEAD), uncommitted tracked changes included. Absent when there is
   * nothing to count or git could not say; untracked files are not in it.
   */
  lines?: { added: number; removed: number };
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
  /** The tracker ticket this worktree is for, when it was created from one (the MCP manager). */
  ticket?: WorktreeTicket;
  /**
   * The agent said it is done and asked for review (stack_request_review).
   * Shown as the row's line and puts it in "Ready for review"; cleared by the
   * next prompt the agent receives.
   */
  review?: { summary: string; at: number };
}

/** A tracker ticket, small enough to show as a chip beside the worktree's name. */
export interface WorktreeTicket {
  /** "jira", "linear", "github"… */
  source: string;
  key: string;
  url?: string;
  title?: string;
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

export interface StackConfig {
  worktreesDirectory: string;
  /**
   * Branch new worktrees start from. Without this, the base was whatever the
   * main checkout happened to be sitting on, so parking it on a feature branch
   * silently made every new worktree a child of that feature branch.
   */
  defaultBaseBranch: string;
  setupScript: string;
  /**
   * Run the setup script in a terminal you can see and type into, as it was
   * before, instead of headless and awaited. For scripts that ask questions;
   * the agent then starts without waiting for it.
   */
  setupInTerminal: boolean;
  teardownScript: string;
  /** Agent launched when no explicit provider is requested. */
  defaultProvider: ProviderId;
  claudeCommand: string;
  codexCommand: string;
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
  /**
   * How sessions reach the editor: a terminal tab per session (`perSession`,
   * draggable into groups side by side), or one terminal per worktree that
   * switches between them (`single`, the behaviour before tabs).
   */
  sessionTabs: 'perSession' | 'single';
  /** Which of the sidebar's layouts to render. */
  sidebarStyle: SidebarStyle;
  /** Per-worktree docker orchestration (compose files + auto-generated ports). */
  docker: DockerConfig;
  debugBasePort: number;
  debugTemplate: DebugTemplate;
}

export type HookEntry = {
  matcher: string;
  hooks: { type: string; command: string }[];
};
