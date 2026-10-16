import * as vscode from 'vscode';
import { findOwner } from './TabManager';

const STORE_KEY = 'stack.breakpoints';

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

  /** Worktrees whose stash changed since the last persist — the only ones written. */
  private dirty = new Set<string>();

  constructor(
    private globalState: vscode.Memento,
    private getWorktrees: () => WorktreeRef[],
  ) {
    const stored = globalState.get<Record<string, SavedBreakpoint[]>>(STORE_KEY, {});
    for (const [id, bps] of Object.entries(stored)) this.saved.set(id, bps);
  }

  /**
   * Drop the stashed breakpoints of every worktree not in `liveIds` — the
   * whole store, every repository, for the same reason as TabManager.prune.
   * A deleted worktree's stash could never be restored and was kept forever.
   */
  prune(liveIds: ReadonlySet<string>): void {
    // persist() writes only dirty entries over what is stored now (another
    // window may have written since activation), so a pruned id has to be
    // marked dirty to be deleted — and ids only the store knows about, left
    // by a window that has since closed, are pruned too.
    const stored = this.globalState.get<Record<string, SavedBreakpoint[]>>(STORE_KEY, {});
    for (const id of new Set([...this.saved.keys(), ...Object.keys(stored)])) {
      if (liveIds.has(id)) continue;
      this.saved.delete(id);
      this.dirty.add(id);
    }
    if (this.dirty.size > 0) this.persist();
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
        this.dirty.add(owner.id);
        toStash.push(bp);
      }
    }
    if (toStash.length > 0) vscode.debug.removeBreakpoints(toStash);

    const restore = this.saved.get(targetId);
    if (restore && restore.length > 0) {
      vscode.debug.addBreakpoints(restore.map((s) => this.deserialize(s)));
      this.saved.delete(targetId);
      this.dirty.add(targetId);
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

  /**
   * Writes back only the worktrees this window changed, over what is stored now.
   *
   * globalState is shared by every window, and this used to write the whole
   * in-memory map, read once at activation: two windows open meant the last
   * one to switch worktrees overwrote the other's stash, and the breakpoints
   * stashed there were gone for good.
   */
  private persist(): void {
    const stored = { ...this.globalState.get<Record<string, SavedBreakpoint[]>>(STORE_KEY, {}) };
    for (const id of this.dirty) {
      const bps = this.saved.get(id);
      if (bps && bps.length > 0) stored[id] = bps;
      else delete stored[id];
    }
    this.dirty.clear();
    this.globalState.update(STORE_KEY, stored);
  }
}
