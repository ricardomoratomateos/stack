export interface TmuxWindow {
  index: number;
  name: string;
  /** Title of the window's active pane (set via OSC by the running program, e.g. Claude Code's live status). */
  title?: string;
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
   * per-line Enter), then submit once. Used to hand a review prompt to a live
   * agent without each newline triggering a submit.
   */
  paste(target: string, text: string): Promise<void>;
  /** Replace the window's process with a command run directly (nothing typed or echoed in the pane). */
  respawnWindow(session: string, windowIndex: number, command: string): Promise<void>;
  selectWindow(session: string, windowIndex: number): Promise<void>;
  killWindow(session: string, windowIndex: number): Promise<void>;
  killSession(name: string): Promise<void>;
  /** Detaches all clients; the session keeps running. */
  detachClients(sessionName: string): Promise<void>;
  listWindows(session: string): Promise<TmuxWindow[]>;
}
