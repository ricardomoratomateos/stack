import * as vscode from 'vscode';
import { findOwner } from './TabManager';

const STORE_KEY = 'foreman.breakpoints';

interface WorktreeRef { id: string; path: string }

/** Persistable form of a vscode.SourceBreakpoint. */
interface SavedBreakpoint {
  uri: string; // fsPath
  line: number; // 0-based
  character: number;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/**
 * Scopes the Breakpoints panel to the active worktree, mirroring how TabManager
 * scopes open editor tabs. On a worktree switch, source breakpoints owned by any
 * OTHER worktree are stashed (removed from VSCode) and the target worktree's
 * previously-stashed breakpoints are restored. Breakpoints outside every
 * worktree (and function breakpoints, which have no file) are always kept.
 */
export class BreakpointManager {
  private saved = new Map<string, SavedBreakpoint[]>();

  constructor(
    private globalState: vscode.Memento,
    private getWorktrees: () => WorktreeRef[],
  ) {
    const stored = globalState.get<Record<string, SavedBreakpoint[]>>(STORE_KEY, {});
    for (const [id, bps] of Object.entries(stored)) this.saved.set(id, bps);
  }

  /** Stashed (hidden) breakpoints for a worktree — exposed for tests. */
  getStashed(worktreeId: string): SavedBreakpoint[] {
    return this.saved.get(worktreeId) ?? [];
  }

  /**
   * Show only `targetId`'s breakpoints: stash the ones owned by other worktrees,
   * restore the target's stashed ones.
   */
  activate(targetId: string, worktrees: WorktreeRef[] = this.getWorktrees()): void {
    if (worktrees.length === 0) return;

    const toStash: vscode.SourceBreakpoint[] = [];
    for (const bp of vscode.debug.breakpoints) {
      if (!(bp instanceof vscode.SourceBreakpoint)) continue; // function breakpoints: always kept
      const owner = findOwner(bp.location.uri.fsPath, worktrees);
      if (owner && owner.id !== targetId) {
        const list = this.saved.get(owner.id) ?? [];
        list.push(this.serialize(bp));
        this.saved.set(owner.id, list);
        toStash.push(bp);
      }
    }
    if (toStash.length > 0) vscode.debug.removeBreakpoints(toStash);

    const restore = this.saved.get(targetId);
    if (restore && restore.length > 0) {
      vscode.debug.addBreakpoints(restore.map((s) => this.deserialize(s)));
      this.saved.delete(targetId);
    }

    this.persist();
  }

  private serialize(bp: vscode.SourceBreakpoint): SavedBreakpoint {
    const { uri, range } = bp.location;
    return {
      uri: uri.fsPath,
      line: range.start.line,
      character: range.start.character,
      enabled: bp.enabled,
      condition: bp.condition,
      hitCondition: bp.hitCondition,
      logMessage: bp.logMessage,
    };
  }

  private deserialize(s: SavedBreakpoint): vscode.SourceBreakpoint {
    const location = new vscode.Location(vscode.Uri.file(s.uri), new vscode.Position(s.line, s.character));
    return new vscode.SourceBreakpoint(location, s.enabled, s.condition, s.hitCondition, s.logMessage);
  }

  private persist(): void {
    const obj: Record<string, SavedBreakpoint[]> = {};
    for (const [id, bps] of this.saved.entries()) obj[id] = bps;
    this.globalState.update(STORE_KEY, obj);
  }
}
