import * as vscode from 'vscode';
import { Worktree } from '../types';

/** The muted grey VSCode uses for git-ignored files — makes non-active worktrees recede. */
export const DIM_COLOR = 'gitDecoration.ignoredResourceForeground';

/**
 * A path should be dimmed when it belongs to any worktree that is not the active
 * one — the main repo included. Ownership is resolved by longest path prefix, so
 * files under a nested worktree beat the main repo that contains them.
 */
export function isDimmed(fsPath: string, worktrees: Worktree[], activeWorktreeId: string | undefined): boolean {
  let owner: Worktree | undefined;
  for (const wt of worktrees) {
    const prefix = wt.path.endsWith('/') ? wt.path : wt.path + '/';
    if (fsPath.startsWith(prefix) || fsPath === wt.path) {
      if (!owner || wt.path.length > owner.path.length) owner = wt;
    }
  }
  return owner !== undefined && owner.id !== activeWorktreeId;
}

/**
 * Greys out files/folders belonging to non-active worktrees in the explorer, so
 * the worktree you're focused on stands out. Refreshed whenever the worktree list
 * or the active worktree changes.
 */
export class WorktreeDimDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private worktrees: Worktree[] = [];
  private activeWorktreeId?: string;

  update(worktrees: Worktree[], activeWorktreeId: string | undefined): void {
    this.worktrees = worktrees;
    this.activeWorktreeId = activeWorktreeId;
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    if (!isDimmed(uri.fsPath, this.worktrees, this.activeWorktreeId)) return undefined;
    return new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor(DIM_COLOR));
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
