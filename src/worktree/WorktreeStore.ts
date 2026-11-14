import type { KeyValueStore } from '../core/KeyValueStore';
import { Worktree, WorktreeStoreData } from '../types';
import { STORE_KEY } from '../constants';
import { IWorktreeRepository } from '../ports/IWorktreeRepository';

/**
 * Fields older versions kept on each worktree for features since removed: the
 * debug port (and the per-worktree ports derived from it). Dropped on load, so
 * the next save writes the store without them.
 */
const RETIRED_WORKTREE_KEYS = ['debugPort'] as const;

export class WorktreeStore implements IWorktreeRepository {
  private ctx: { globalState: KeyValueStore };

  constructor(ctx: { globalState: KeyValueStore }) {
    this.ctx = ctx;
  }

  /**
   * The stored worktrees, shed of what older versions kept beside them — the
   * retired per-worktree fields above and the store's old `portRegistry`.
   */
  private load(): WorktreeStoreData {
    const stored = this.ctx.globalState.get<Partial<WorktreeStoreData>>(STORE_KEY, { worktrees: [] });
    const worktrees = Array.isArray(stored?.worktrees) ? stored.worktrees : [];
    return {
      worktrees: worktrees.map((wt) => {
        const copy = { ...wt } as Worktree & Record<string, unknown>;
        for (const key of RETIRED_WORKTREE_KEYS) delete copy[key];
        return copy;
      }),
    };
  }

  private async save(data: WorktreeStoreData): Promise<void> {
    await this.ctx.globalState.update(STORE_KEY, data);
  }

  getAll(): Worktree[] {
    return this.load().worktrees;
  }

  get(id: string): Worktree | undefined {
    return this.load().worktrees.find((w) => w.id === id);
  }

  async add(worktree: Worktree): Promise<void> {
    const data = this.load();
    data.worktrees.push(worktree);
    await this.save(data);
  }

  async patch(id: string, fields: Partial<Worktree>): Promise<void> {
    const data = this.load();
    const wt = data.worktrees.find((w) => w.id === id);
    if (wt) Object.assign(wt, fields);
    await this.save(data);
  }

  async setAlias(id: string, alias: string): Promise<void> {
    const data = this.load();
    const wt = data.worktrees.find((w) => w.id === id);
    if (wt) {
      wt.alias = alias;
      await this.save(data);
    }
  }

  async remove(id: string): Promise<void> {
    const data = this.load();
    data.worktrees = data.worktrees.filter((w) => w.id !== id);
    await this.save(data);
  }

  async pruneNonExistent(): Promise<Worktree[]> {
    const fs = await import('node:fs');
    const data = this.load();
    const alive = data.worktrees.filter((w) => fs.existsSync(w.path));
    if (alive.length < data.worktrees.length) {
      data.worktrees = alive;
      await this.save(data);
    }
    return alive;
  }
}
