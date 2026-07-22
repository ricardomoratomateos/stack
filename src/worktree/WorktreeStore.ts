import * as vscode from 'vscode';
import { Worktree, WorktreeStoreData } from '../types';
import { STORE_KEY } from '../constants';
import { IWorktreeRepository } from '../ports/IWorktreeRepository';

export class WorktreeStore implements IWorktreeRepository {
  private ctx: { globalState: vscode.Memento };

  constructor(ctx: { globalState: vscode.Memento }) {
    this.ctx = ctx;
  }

  private load(): WorktreeStoreData {
    return this.ctx.globalState.get<WorktreeStoreData>(STORE_KEY, {
      worktrees: [],
      portRegistry: {},
    });
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
    data.portRegistry[worktree.path] = worktree.xdebugPort;
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
    const worktree = data.worktrees.find((w) => w.id === id);
    if (worktree) {
      delete data.portRegistry[worktree.path];
    }
    data.worktrees = data.worktrees.filter((w) => w.id !== id);
    await this.save(data);
  }

  getPortRegistry(): Record<string, number> {
    return this.load().portRegistry;
  }

  async pruneNonExistent(): Promise<Worktree[]> {
    const fs = await import('node:fs');
    const data = this.load();
    const alive = data.worktrees.filter((w) => fs.existsSync(w.path));
    const removed = data.worktrees.filter((w) => !fs.existsSync(w.path));
    if (removed.length > 0) {
      data.worktrees = alive;
      removed.forEach((w) => delete data.portRegistry[w.path]);
      await this.save(data);
    }
    return alive;
  }
}
