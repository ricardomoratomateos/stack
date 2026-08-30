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
  /** See looksLikeScreenshot — an intentionally opened image must be left alone. */
  isScreenshotLike(file: string): Promise<boolean>;
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
  private readonly subscription: vscode.Disposable;

  constructor(private readonly deps: ImageDropDeps) {
    this.subscription = vscode.window.tabGroups.onDidChangeTabs((e) => void this.onTabsChanged(e));
    this.snapshotActiveTerminals();
  }

  private async onTabsChanged(e: vscode.TabChangeEvent): Promise<void> {
    // Decide with the map as it was BEFORE this change: the image tab is
    // active now, but the terminal it displaced is what identifies the drop.
    for (const tab of e.opened) {
      await this.handle(tab).catch((err) => console.warn('[foreman] image drop failed', err));
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

  private async handle(tab: vscode.Tab): Promise<void> {
    const uri = uriOf(tab.input);
    if (!uri || uri.scheme !== 'file' || !isImagePath(uri.fsPath)) return;

    const labels = tab.group.tabs
      .filter((t) => t.input instanceof vscode.TabInputTerminal)
      .map((t) => t.label);
    const label = pickTerminalLabel(labels, this.lastActiveTerminalByGroup.get(tab.group.viewColumn));
    const target = (label && this.deps.worktreeIdForTerminalName(label)) || this.deps.activeWorktreeId();
    if (!target || !this.deps.hasTerminals(target)) return;
    if (!(await this.deps.isScreenshotLike(uri.fsPath))) return;

    await vscode.window.tabGroups.close(tab, true);
    await this.deps.attach(target, [uri.fsPath]);
    this.deps.notify(
      `Foreman: attached ${path.basename(uri.fsPath)} to ${this.deps.labelFor(target) ?? 'the agent'}`,
      () => void vscode.commands.executeCommand('vscode.open', uri),
    );
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

/** The file behind a tab, for the inputs an image can open as. */
function uriOf(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputCustom) return input.uri;
  if (input instanceof vscode.TabInputText) return input.uri;
  return undefined;
}
