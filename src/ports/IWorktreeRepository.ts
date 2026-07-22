import { Worktree } from '../types';

export interface IWorktreeRepository {
  getAll(): Worktree[];
  get(id: string): Worktree | undefined;
  add(worktree: Worktree): Promise<void>;
  patch(id: string, fields: Partial<Worktree>): Promise<void>;
  setAlias(id: string, alias: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** xdebug port registry, keyed by worktree PATH. */
  getPortRegistry(): Record<string, number>;
}
