import * as vscode from 'vscode';
import * as fs from 'node:fs';

const STORE_KEY = 'foreman.tabs';

interface WorktreeRef { id: string; path: string }

interface TabState {
  uris: string[];     // ordered list of open file paths
  active?: string;    // fsPath of the focused tab
  hadViewer?: boolean; // whether the tmux viewer terminal was open
}

export function findOwner(fsPath: string, worktrees: WorktreeRef[]): WorktreeRef | undefined {
  let best: WorktreeRef | undefined;
  for (const wt of worktrees) {
    const prefix = wt.path.endsWith('/') ? wt.path : wt.path + '/';
    if (fsPath.startsWith(prefix) || fsPath === wt.path) {
      if (!best || wt.path.length > best.path.length) best = wt;
    }
  }
  return best;
}

function openFileTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap(g => g.tabs)
    .filter(t => t.input instanceof vscode.TabInputText && (t.input as vscode.TabInputText).uri.scheme === 'file');
}

export class TabManager {
  private saved = new Map<string, TabState>();
  private closingProgrammatically = 0;

  constructor(
    private globalState: vscode.Memento,
    private getWorktrees: () => WorktreeRef[],
  ) {
    const stored = globalState.get<Record<string, TabState>>(STORE_KEY, {});
    for (const [id, state] of Object.entries(stored)) {
      this.saved.set(id, state);
    }

    // Live snapshot on every tab open/close/change
    vscode.window.tabGroups.onDidChangeTabs(() => {
      if (this.closingProgrammatically > 0) return;
      this.liveSnapshot();
    });

    // Live snapshot on active editor change (captures reorders)
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (this.closingProgrammatically > 0) return;
      this.liveSnapshot();
    });
  }

  private liveSnapshot(): void {
    const worktrees = this.getWorktrees();
    if (worktrees.length === 0) return;

    const activeFsPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const byWorktree = new Map<string, string[]>();

    for (const tab of openFileTabs()) {
      const uri = (tab.input as vscode.TabInputText).uri;
      const owner = findOwner(uri.fsPath, worktrees);
      if (!owner) continue;
      if (!byWorktree.has(owner.id)) byWorktree.set(owner.id, []);
      byWorktree.get(owner.id)!.push(uri.fsPath);
    }

    // Only update worktrees that have tabs currently open — never wipe saved
    // state for a worktree whose tabs were closed programmatically.
    for (const [id, uris] of byWorktree.entries()) {
      const current = this.saved.get(id) ?? { uris: [] };
      const ownerOfActive = activeFsPath ? findOwner(activeFsPath, worktrees) : undefined;
      const active = ownerOfActive?.id === id ? activeFsPath : current.active;
      this.saved.set(id, { ...current, uris, active });
    }

    this.persist();
  }

  private persist(): void {
    const obj: Record<string, TabState> = {};
    for (const [id, state] of this.saved.entries()) obj[id] = state;
    this.globalState.update(STORE_KEY, obj);
  }

  getState(worktreeId: string): TabState | undefined {
    return this.saved.get(worktreeId);
  }

  /** Snapshot hadViewer before closing viewers on a worktree switch. */
  updateViewerState(worktrees: WorktreeRef[], viewerOpenIds: Set<string>): void {
    for (const wt of worktrees) {
      const current = this.saved.get(wt.id) ?? { uris: [] };
      this.saved.set(wt.id, { ...current, hadViewer: viewerOpenIds.has(wt.id) });
    }
    this.persist();
  }

  /** Close all file tabs that belong to a worktree other than the target. */
  async closeOtherTabs(targetId: string, worktrees: WorktreeRef[]): Promise<void> {
    const toClose = openFileTabs().filter(tab => {
      const uri = (tab.input as vscode.TabInputText).uri;
      const owner = findOwner(uri.fsPath, worktrees);
      return owner && owner.id !== targetId;
    });
    if (toClose.length === 0) return;
    this.closingProgrammatically++;
    try {
      await vscode.window.tabGroups.close(toClose);
    } finally {
      setTimeout(() => this.closingProgrammatically--, 50);
    }
  }

  /**
   * Restore saved tabs for a worktree in saved order.
   * Closes currently open file tabs first, then reopens all in saved order.
   *
   * `preserveFocus: false` is load-bearing, not incidental: `workbench.editor.
   * openPositioning` defaults to "right", so each editor opens to the right of
   * the ACTIVE one. Letting each opened tab become active walks the insertion
   * point forward and yields the saved order. With preserveFocus: true the
   * anchor never moves, so every tab lands next to the first one and the result
   * comes out reversed. The saved active tab is re-focused at the end.
   */
  async restoreTabs(worktreeId: string): Promise<void> {
    const state = this.saved.get(worktreeId);
    if (!state || state.uris.length === 0) return;

    // A single guard spanning the whole operation, released 50ms afterwards to
    // absorb the tab events VSCode fires late. (This used to be two independent
    // increments with two independent timers — same net effect, harder to read.)
    this.closingProgrammatically++;
    try {
      const current = openFileTabs();
      if (current.length > 0) await vscode.window.tabGroups.close(current);

      const existingUris = state.uris.filter(f => fs.existsSync(f));
      if (existingUris.length === 0) return;

      for (const fsPath of existingUris) {
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(fsPath), {
            preview: false,
            preserveFocus: false,
          });
        } catch { /* file unreadable */ }
      }

      // Re-focus whatever the user was last looking at; without this the last
      // file in the list keeps the focus it stole while walking the order.
      if (state.active && existingUris.includes(state.active)) {
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(state.active), {
            preview: false,
            preserveFocus: false,
          });
        } catch { /* file unreadable */ }
      }
    } finally {
      setTimeout(() => this.closingProgrammatically--, 50);
    }
  }
}
