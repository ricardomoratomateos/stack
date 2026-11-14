import { Worktree } from '../../src/types';
import { IWorktreeRepository } from '../../src/ports/IWorktreeRepository';

/**
 * In-memory IWorktreeRepository for tests. Mirrors WorktreeStore semantics:
 * - patch() merges partial fields into an existing worktree (no-op on unknown id)
 * - setAlias() no-ops on unknown id
 * - getAll() returns [] when empty
 */
export class InMemoryWorktreeRepository implements IWorktreeRepository {
  private worktrees = new Map<string, Worktree>();

  getAll(): Worktree[] {
    return [...this.worktrees.values()];
  }

  get(id: string): Worktree | undefined {
    return this.worktrees.get(id);
  }

  async add(worktree: Worktree): Promise<void> {
    this.worktrees.set(worktree.id, worktree);
  }

  async patch(id: string, fields: Partial<Worktree>): Promise<void> {
    const wt = this.worktrees.get(id);
    if (wt) Object.assign(wt, fields);
  }

  async setAlias(id: string, alias: string): Promise<void> {
    const wt = this.worktrees.get(id);
    if (wt) wt.alias = alias;
  }

  async remove(id: string): Promise<void> {
    this.worktrees.delete(id);
  }
}
