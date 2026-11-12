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
  /** The branch has an upstream; without one ahead/behind are 0 and mean nothing. */
  upstream?: true;
  /** Against the branch this worktree was cut from: "should I rebase?". */
  base?: BaseDrift;
  /** Lines added/removed since the branch left its base; see src/types.ts. */
  lines?: { added: number; removed: number };
}

export interface BaseDrift {
  /** What was compared against, e.g. "origin/develop". */
  ref: string;
  ahead: number;
  behind: number;
}

/** One of the worktree's own auto-generated ports. */
export interface PortMapping {
  /** Env var name from `stack.ports`, e.g. HTTP_PORT. */
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
  /** OPEN, MERGED or CLOSED, as GitHub spells it. */
  state: string;
  url?: string;
  isDraft?: boolean;
  /** APPROVED, CHANGES_REQUESTED or REVIEW_REQUIRED; absent when no review is required. */
  reviewDecision?: string;
  /** The checks summed up; absent when the PR has none. */
  ci?: 'pass' | 'fail' | 'pending';
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
  /** The agent has already taken a prompt: `waiting` means it is waiting on your reply, not freshly launched. */
  turned?: boolean;
  /** Live task title from the agent's terminal title (falls back to `name` in the UI). */
  title?: string;
  /**
   * What the agent said when it asked for you — the notification's message, or
   * the command it wants permission to run. Only set while the session is in
   * `permission`/`waiting`; the sidebar shows it only for `permission`.
   */
  attention?: string;
  index: number;
}

export interface WorktreeItem {
  id: string;
  /**
   * The worktree's directory is gone (deleted behind git's back). Only ever
   * present, and then `true`; the card offers an explicit "Forget".
   */
  missing?: true;
  /**
   * When (epoch ms) the worktree entered the state it is in now, as the
   * extension host saw it — drives the age on a row and the order of the
   * attention queue. Kept across reloads (workspaceState).
   */
  since?: number;
  branch: string;
  alias?: string;
  path: string;
  isMain: boolean;
  /** The standing control session shown pinned above the task list — see src/types.ts. */
  isControl?: true;
  deleting: boolean;
  agent: AgentState;
  agentCount: number;
  terminalCount: number;
  sessions: SessionItem[];
  git: GitStatus;
  /** Ports this worktree owns — empty unless `stack.ports` is set. */
  ports: PortMapping[];
  pr?: PrStatus | null;
  /** The setup script, while it runs headless or after it failed; absent once it succeeded. */
  setup?: SetupItem;
  /** The tracker ticket the worktree was created for: a chip beside its name. */
  ticket?: TicketItem;
  /** The agent asked for review with this summary: the row's line, and the review group. */
  review?: { summary: string; at: number };
  /**
   * The task's tmux session is gone (the Mac restarted) but its agent's
   * conversation is known: this agent can be resumed. The row offers "Resume".
   */
  resume?: ProviderId;
}

export interface TicketItem {
  source: string;
  key: string;
  /** Opened by the host, never handed to the browser from here. */
  url?: string;
  title?: string;
}

export interface SetupItem {
  state: 'running' | 'failed';
  /** Epoch ms the (latest) run started. */
  startedAt: number;
  /** Why it failed, in a few words: "exited with code 2". */
  error?: string;
  /** An agent is waiting for it, and starts when it succeeds (or on "Launch anyway"). */
  held?: boolean;
}

export interface StackState {
  worktrees: WorktreeItem[];
  /** The standing control session, pinned above the task list — never part of `worktrees`. */
  controlSession?: WorktreeItem;
  activeWorktreeId?: string;
  /** Provider launched by the main agent button (stack.defaultProvider). */
  defaultProvider?: ProviderId;
  /** Agents whose command resolves on PATH; the rest are shown dimmed. */
  installedProviders?: ProviderId[];
  /** Set by the desktop app, which hosts this webview: it fills the brand row's slot and has no composer. */
  host?: 'desktop';
  /** Local branches offered as the base for a new worktree (filled on demand). */
  branches?: string[];
  /** Branch preselected as the base — the main repo's current branch. */
  baseBranch?: string;
}

// Extension → WebView
export type ExtMessage =
  | { type: 'state'; payload: StackState };

// WebView → Extension
export type WebMessage =
  | { type: 'launchAgent'; worktreeId: string; provider?: ProviderId }
  /** Recreate a task's lost tmux session and resume its agent's conversation (see WorktreeItem.resume). */
  | { type: 'resumeAgent'; worktreeId: string }
  /** Choose which agent the card's big launch button starts. */
  | { type: 'pickDefaultProvider' }
  /** The webview finished mounting and is listening. See the handshake below. */
  | { type: 'ready' }
  /** Tell the user how to install an agent whose command is not on PATH. */
  | { type: 'showProviderInstall'; provider: ProviderId }
  | { type: 'openTerminal'; worktreeId: string }
  | { type: 'focusTerminal'; worktreeId: string }
  /** `toSide`: open (or move) the session's tab beside the active editor group. */
  | { type: 'focusSession'; worktreeId: string; kind: 'agent' | 'shell'; index: number; toSide?: boolean }
  | { type: 'killSession'; worktreeId: string; index: number }
  | { type: 'reorderSessions'; worktreeId: string; orderedIndexes: number[] }
  | { type: 'reorderWorktrees'; orderedIds: string[] }
  | { type: 'renameSession'; worktreeId: string; index: number }
  | { type: 'openPort'; port: number }
  /** Open the worktree's pull request in the browser. The URL is looked up on the host side. */
  | { type: 'openPr'; worktreeId: string }
  /** Open the worktree's ticket in the browser; the URL is looked up on the host side too. */
  | { type: 'openTicket'; worktreeId: string }
  | { type: 'refreshDrift'; worktreeId: string }
  | { type: 'deleteWorktree'; worktreeId: string }
  | { type: 'renameWorktree'; worktreeId: string }
  | { type: 'initWorktree'; worktreeId: string }
  /** The setup row's buttons: its output, run it again, start the held agent regardless, or drop a failure. */
  | { type: 'setupAction'; worktreeId: string; action: 'log' | 'retry' | 'launch' | 'dismiss' }
  | { type: 'openDiff'; worktreeId: string }
  /** The empty-state "New agent" button opens the full-screen panel. */
  | { type: 'openNewTask' }
  | { type: 'createWorktree'; branch: string; title?: string; description?: string; baseBranch?: string; provider?: ProviderId }
  | { type: 'listBranches' }
  | { type: 'selectWorktree'; worktreeId: string }
  /** The explicit answer to a `missing` worktree: drop its entry (nothing on disk is touched). */
  | { type: 'forgetWorktree'; worktreeId: string };
