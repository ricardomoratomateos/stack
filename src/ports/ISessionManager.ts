export interface TmuxWindow {
  index: number;
  name: string;
  /** Title of the window's active pane (set via OSC by the running program, e.g. Claude Code's live status). */
  title?: string;
  /**
   * Process running in the active pane right now — `zsh` when the shell is
   * sitting at a prompt, `npm`/`vim`/`psql` when it is not. Reported from the
   * pane's process group leader, so a child that shares the group (anything a
   * non-interactive `sh -c` runs) is invisible here; see `pid`.
   */
  command?: string;
  /** Pid of the pane's process, for looking past `command` at its children. */
  pid?: number;
}

export interface TmuxSession {
  name: string;
  /** Clients attached right now. */
  attached: number;
}

export interface TmuxClient {
  /** The client process — what a VS Code terminal running `tmux` reports as its processId. */
  pid: number;
  session: string;
}

/** Port over tmux session operations (implemented by TmuxManager). */
export interface ISessionManager {
  hasSession(name: string): Promise<boolean>;
  ensureSession(name: string, cwd: string): Promise<void>;
  /** Creates a new window and returns its index. */
  newWindow(session: string, name: string, cwd: string): Promise<number>;
  sendKeys(target: string, keys: string): Promise<void>;
  /**
   * Paste multi-line text into a window as a single bracketed-paste block (no
   * per-line Enter), left unsent. Submitting is a separate pressEnter, because
   * the receiving agent needs a beat to take the paste in first.
   */
  paste(target: string, text: string): Promise<void>;
  /**
   * The last `lines` lines of a window's visible pane and scrollback, as text
   * (no escape sequences; wrapped lines joined).
   */
  capturePane(target: string, lines: number): Promise<string>;
  /** Send a single Enter keypress to a window (submits whatever its input holds). */
  pressEnter(target: string): Promise<void>;
  /** Replace the window's process with a command run directly (nothing typed or echoed in the pane). */
  respawnWindow(session: string, windowIndex: number, command: string): Promise<void>;
  selectWindow(session: string, windowIndex: number): Promise<void>;
  killWindow(session: string, windowIndex: number): Promise<void>;
  killSession(name: string): Promise<void>;
  /**
   * Renames the session Foreman (the extension's old name) left for this
   * worktree, and its views, to Stack's names — running agents included.
   * True when it did.
   */
  adoptLegacySession(worktreeId: string): Promise<boolean>;
  /** Detaches all clients; the session keeps running. */
  detachClients(sessionName: string): Promise<void>;
  listWindows(session: string): Promise<TmuxWindow[]>;
  /** Every session on the tmux server; [] when there is none. */
  listSessions(): Promise<TmuxSession[]>;
  /** Every attached client; [] when there is none. */
  listClients(): Promise<TmuxClient[]>;
  /** Whether a process has at least one child — the way to see an agent a shell started. */
  hasChildProcess(pid: number): Promise<boolean>;
  /** A process's full command line (argv joined). Rejects when it cannot be read. */
  processCommandLine(pid: number): Promise<string>;
}
