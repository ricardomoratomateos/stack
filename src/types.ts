import type { ProviderId } from './ports/IAgentProvider';

export type AgentSessionState = 'active' | 'waiting' | 'permission' | 'idle' | 'terminated';

export interface GitStatus {
  hasChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  /**
   * Lines added and removed since the branch left its base (the main worktree:
   * since HEAD), uncommitted tracked changes included. Absent when there is
   * nothing to count or git could not say; untracked files are not in it.
   */
  lines?: { added: number; removed: number };
}

export interface Worktree {
  id: string;
  branch: string;
  alias?: string;
  path: string;
  repoRoot: string;
  createdAt: number;
  isMain?: boolean;
  /**
   * The standing control session, not a git worktree at all: no branch of its
   * own, not in WorktreeManager's store, never touched by reconcile or
   * stack_delete_task. Its `path` is the repo root, same as the main
   * checkout's, but it is a different entity — see controlSession.ts.
   */
  isControl?: true;
  /**
   * Branch this worktree was cut from, recorded at creation.
   *
   * Kept per worktree rather than read from the setting at display time: a
   * worktree started off release/3.2 must keep being compared with release/3.2
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

export interface WorktreeStoreData {
  worktrees: Worktree[];
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
  /**
   * Prepended to the first prompt of every agent launch, sent on its own when
   * there is none otherwise — a personal reminder (e.g. which skill to use)
   * that a fresh agent has no other way to pick up. Not repo-scoped: a habit
   * of yours, not something to impose on everyone who clones the repo.
   */
  promptPrefix: string;
  claudeCommand: string;
  opencodeCommand: string;
  /** Toast when an agent finishes or asks for permission while unattended. */
  notifyOnAttention: boolean;
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
  // ── The Code tab (see src/code/config.ts). The project's: ──
  phpNavigation: boolean;
  phpIndexDirs: string[];
  phpExcludeDirs: string[];
  phpExtensions: string[];
  phpAutoloader: string;
  phpBaseBranch: string;
  phpMaxChangedFiles: number;
  phpactorOptions: Record<string, unknown>;
  scriptExcludeDirs: string[];
  oxlintConfig: string;
  // ── …and yours (this machine): ──
  phpBaseOnStart: boolean;
  codeIdleMinutes: number;
  phpactorPath: string;
  oxlintPath: string;
  phpPath: string;
}

export type HookEntry = {
  matcher: string;
  hooks: { type: string; command: string }[];
};
