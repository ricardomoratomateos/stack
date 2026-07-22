import { Worktree } from '../../src/types';
import { IWorktreeRepository } from '../../src/ports/IWorktreeRepository';

/**
 * In-memory IWorktreeRepository for tests. Mirrors WorktreeStore semantics:
 * - add() registers the worktree's xdebug port in the registry keyed by PATH
 * - remove() drops both the worktree and its port-registry entry
 * - patch() merges partial fields into an existing worktree (no-op on unknown id)
 * - setAlias() no-ops on unknown id
 * - getAll() returns [] when empty
 */
export class InMemoryWorktreeRepository implements IWorktreeRepository {
  private worktrees = new Map<string, Worktree>();
  private portRegistry: Record<string, number> = {};

  getAll(): Worktree[] {
    return [...this.worktrees.values()];
  }

  get(id: string): Worktree | undefined {
    return this.worktrees.get(id);
  }

  async add(worktree: Worktree): Promise<void> {
    this.worktrees.set(worktree.id, worktree);
    this.portRegistry[worktree.path] = worktree.xdebugPort;
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
    const wt = this.worktrees.get(id);
    if (wt) delete this.portRegistry[wt.path];
    this.worktrees.delete(id);
  }

  getPortRegistry(): Record<string, number> {
    return this.portRegistry;
  }
}
