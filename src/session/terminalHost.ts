import type { Worktree } from '../types';

/**
 * How a worktree's sessions reach the editor (`stack.sessionTabs`).
 *
 * - `perSession`: every session (agent or shell) is a terminal tab of its own,
 *   so two of them can sit side by side, be dragged between editor groups and
 *   resized — all of it VS Code's own editor layout.
 * - `single`: one terminal per worktree attached to its tmux session; switching
 *   sessions switches the tmux window inside it. The behaviour before tabs.
 */
export type SessionTabsMode = 'perSession' | 'single';

/** What a Stack terminal shows: a worktree's whole session (the single viewer), or one window of it (a tab). */
export interface TerminalTarget {
  worktreeId: string;
  /** Set for a session tab; absent for the single-mode viewer. */
  windowIndex?: number;
}

/** What a tab says about its session. */
export interface TabInfo {
  /** The worktree's display label (displayLabel). */
  label: string;
  /** The session's name as the sidebar shows it: its alias, else the window name. */
  session: string;
  kind: 'agent' | 'shell';
}

/** A tab closed by closeAll (focus mode), to be reopened where it was. */
export interface ParkedTab {
  index: number;
  viewColumn?: number;
}

/**
 * What AgentSessionManager needs from whatever shows sessions on screen. `T` is
 * the host's terminal handle (a `vscode.Terminal` inside the extension). The
 * VS Code implementation is SessionTerminals; a headless host (stackd) has none.
 */
export interface SessionTerminalHost<T extends { show(): void }> {
  openViewer(worktree: Worktree, name: string): T;
  openViewerBeside(worktree: Worktree, name: string): T;
  openTab(
    worktree: Worktree,
    windowIndex: number,
    info: TabInfo,
    opts?: { beside?: boolean; viewColumn?: number },
  ): Promise<T>;
  current(worktreeId: string): T | undefined;
  focusedWindow(worktreeId: string): number | undefined;
  lastFocusedWindow(worktreeId: string): number | undefined;
  targetOf(terminal: T): TerminalTarget | undefined;
  targetOfName(name: string): TerminalTarget | undefined;
  closeTab(worktreeId: string, windowIndex: number): Promise<void>;
  closeTabsExcept(worktreeId: string, windowIndexes: ReadonlySet<number>): Promise<void>;
  closeAll(worktreeId: string): Promise<void>;
  takeParked(worktreeId: string): ParkedTab[];
  closeViewer(worktreeId: string): Promise<void>;
  disposeAll(worktreeId: string): void;
  claim(worktrees: Worktree[], labelOf: (wt: Worktree) => string): Promise<void>;
  pruneViews(): Promise<void>;
  killViews(worktreeId: string): Promise<void>;
  dispose(): void;
}
