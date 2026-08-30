import * as vscode from 'vscode';
import * as path from 'node:path';
import { isImagePath, pickTerminalLabel } from './imageDrop';

export interface ImageDropDeps {
  /** Worktree whose viewer terminal carries this name, if any. */
  worktreeIdForTerminalName(name: string): string | undefined;
  hasTerminals(worktreeId: string): boolean;
  labelFor(worktreeId: string): string | undefined;
  /** Fallback when the drop landed in a group with no agent viewer in it. */
  activeWorktreeId(): string | undefined;
  /**
   * See looksLikeScreenshot — an intentionally opened image must be left alone.
   * Synchronous on purpose: see handle().
   */
  isScreenshotLike(file: string): boolean;
  attach(worktreeId: string, paths: string[]): Promise<void>;
  /** Tell the user what happened, with a way to get the image back as a tab. */
  notify(message: string, reopen: () => void): void;
}

/**
 * Turns "drop a screenshot on the agent's terminal" into an attachment.
 *
 * Agent viewers are terminal EDITORS, and dropping a file on an editor group
 * is claimed by VS Code's editor drop target: the image opens as a tab in that
 * group instead of the terminal inserting its path. There is no API to
 * intercept the drop — but the tab that opens carries everything: its group is
 * the group the user dropped onto, and the viewer sitting in that group says
 * which worktree. So this closes the tab and pastes the path into that agent.
 *
 * Nothing happens unless a worktree with an agent session can take the file,
 * so a window with no agents running keeps VS Code's normal behaviour.
 */
export class ImageDropCatcher implements vscode.Disposable {
  /** The terminal tab that was active in each group before the image took over. */
  private lastActiveTerminalByGroup = new Map<number, string>();
  /**
   * Files the user asked to see after all ("Open instead"): the next open of
   * each is left alone, otherwise the reopen is itself a fresh image tab in a
   * group with an agent — and gets caught and pasted all over again.
   */
  private letThrough = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly deps: ImageDropDeps) {
    this.subscription = vscode.window.tabGroups.onDidChangeTabs((e) => void this.onTabsChanged(e));
    this.snapshotActiveTerminals();
  }

  private onTabsChanged(e: vscode.TabChangeEvent): void {
    // Decide with the map as it was BEFORE this change: the image tab is
    // active now, but the terminal it displaced is what identifies the drop.
    for (const tab of e.opened) {
      try { this.handle(tab); } catch (err) { console.warn('[foreman] image drop failed', err); }
    }
    this.snapshotActiveTerminals();
  }

  private snapshotActiveTerminals(): void {
    for (const group of vscode.window.tabGroups.all) {
      const active = group.activeTab;
      if (active && active.input instanceof vscode.TabInputTerminal) {
        this.lastActiveTerminalByGroup.set(group.viewColumn, active.label);
      }
    }
  }

  /**
   * Everything up to the close runs synchronously inside the tab event: an
   * await before it yields to the event loop, which is exactly the frame the
   * image preview needs to paint — the flash the user would otherwise see.
   */
  private handle(tab: vscode.Tab): void {
    const uri = uriOf(tab.input);
    if (!uri || uri.scheme !== 'file' || !isImagePath(uri.fsPath)) return;
    const pass = this.letThrough.get(uri.fsPath);
    if (pass !== undefined) {
      clearTimeout(pass);
      this.letThrough.delete(uri.fsPath);
      return;
    }

    const labels = tab.group.tabs
      .filter((t) => t.input instanceof vscode.TabInputTerminal)
      .map((t) => t.label);
    const label = pickTerminalLabel(labels, this.lastActiveTerminalByGroup.get(tab.group.viewColumn));
    const target = (label && this.deps.worktreeIdForTerminalName(label)) || this.deps.activeWorktreeId();
    if (!target || !this.deps.hasTerminals(target)) return;
    if (!this.deps.isScreenshotLike(uri.fsPath)) return;

    void vscode.window.tabGroups.close(tab, true);
    void this.deps
      .attach(target, [uri.fsPath])
      .then(() => this.deps.notify(
        `Foreman: attached ${path.basename(uri.fsPath)} to ${this.deps.labelFor(target) ?? 'the agent'}`,
        () => this.reopen(uri),
      ))
      .catch((err) => console.warn('[foreman] image drop failed', err));
  }

  private reopen(uri: vscode.Uri): void {
    const key = uri.fsPath;
    clearTimeout(this.letThrough.get(key));
    // Consumed by the open below; the timer covers an open that never reports.
    this.letThrough.set(key, setTimeout(() => this.letThrough.delete(key), 5_000));
    void vscode.commands.executeCommand('vscode.open', uri);
  }

  dispose(): void {
    this.subscription.dispose();
    for (const timer of this.letThrough.values()) clearTimeout(timer);
    this.letThrough.clear();
  }
}

/** The file behind a tab, for the inputs an image can open as. */
function uriOf(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputText) return input.uri;
  return undefined;
}
