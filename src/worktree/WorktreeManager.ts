import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worktree } from '../types';
import { PortAllocator } from './portAllocator';
import { ConfigManager } from '../config/ConfigManager';
import { AgentSessionManager } from '../session/AgentSessionManager';
import { IGitPort, GitWorktreeEntry } from '../ports/IGitPort';
import { IFileSystem } from '../ports/IFileSystem';
import { IWorktreeRepository } from '../ports/IWorktreeRepository';
import { GitCliAdapter } from '../adapters/GitCliAdapter';
import { NodeFileSystem } from '../adapters/NodeFileSystem';
import { LAUNCH_JSON_PATH, SETTINGS_JSON_PATH, WORKTREE_SETTINGS_EXCLUSIONS } from '../constants';

export class WorktreeManager {
  constructor(
    private store: IWorktreeRepository,
    private portAllocator: PortAllocator,
    private config: ConfigManager,
    private agentManager?: AgentSessionManager,
    private git: IGitPort = new GitCliAdapter(),
    private fs: IFileSystem = new NodeFileSystem(),
  ) {}

  list(): Worktree[] {
    return this.store.getAll().sort((a, b) => Number(b.isMain) - Number(a.isMain));
  }

  /**
   * Two-way sync between git worktree list and the store.
   * - Removes store entries that no longer exist in git.
   * - Adds git worktrees not yet in the store.
   * Returns the full current list after sync.
   */
  async reconcile(repoRoot: string): Promise<{ adopted: Worktree[]; removed: Worktree[]; current: Worktree[] }> {
    const gitWorktrees = this.listFromGit(repoRoot);
    const normalizedRepoRoot = path.normalize(repoRoot);

    // If git failed (returned empty), abort — never wipe the store on a git error
    if (gitWorktrees.length === 0) {
      return { adopted: [], removed: [], current: this.store.getAll() };
    }

    const removed: Worktree[] = [];

    // Add git worktrees missing from store (including main worktree)
    const storedPaths = new Set(this.store.getAll().map((w) => path.normalize(w.path)));
    const adopted: Worktree[] = [];

    // Patch isMain and branch on already-stored worktrees.
    // Only the one whose path matches repoRoot exactly is the main worktree.
    // Also sync branch names — a store entry can have a stale branch if the
    // worktree was switched to a different branch outside of Unmess.
    for (const stored of this.store.getAll()) {
      const shouldBeMain = path.normalize(stored.path) === normalizedRepoRoot;
      const matchingGit = gitWorktrees.find(
        (wt) => path.normalize(wt.path) === path.normalize(stored.path),
      );
      const updates: Partial<Worktree> = {};
      if (stored.isMain !== shouldBeMain) updates.isMain = shouldBeMain;
      if (matchingGit && matchingGit.branch && stored.branch !== matchingGit.branch) {
        updates.branch = matchingGit.branch;
      }
      if (Object.keys(updates).length > 0) {
        await this.store.patch(stored.id, updates);
      }
    }

    for (const wt of gitWorktrees) {
      if (storedPaths.has(path.normalize(wt.path))) continue;

      const isMain = path.normalize(wt.path) === normalizedRepoRoot;
      const xdebugPort = isMain ? 0 : this.portAllocator.allocate();
      const worktree: Worktree = {
        id: randomUUID(),
        branch: wt.branch,
        path: wt.path,
        repoRoot,
        xdebugPort,
        dockerProjectName: wt.branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
        createdAt: Date.now(),
        isMain,
      };

      if (!isMain && !this.fs.exists(path.join(wt.path, LAUNCH_JSON_PATH))) {
        this.generateLaunchJson(worktree);
      }
      if (!isMain && !this.fs.exists(path.join(wt.path, SETTINGS_JSON_PATH))) {
        this.generateSettingsJson(worktree);
      }

      await this.store.add(worktree);
      adopted.push(worktree);
    }

    return { adopted, removed, current: this.store.getAll() };
  }

  listFromGit(repoRoot: string): GitWorktreeEntry[] {
    return this.git.listWorktrees(repoRoot);
  }

  async create(branch: string, repoRoot: string, alias?: string): Promise<Worktree> {
    const worktreesDir = this.resolveWorktreesDir(repoRoot);
    this.fs.mkdir(worktreesDir);

    const safeDirName = branch.replace(/\//g, '-');
    const worktreePath = path.join(worktreesDir, safeDirName);

    const branchExists = this.git.branchExists(branch, repoRoot);
    await this.git.createWorktree(worktreePath, branch, repoRoot, !branchExists);

    console.log(`[unmess] create branch=${branch} path=${worktreePath} existsAfterAdd=${this.fs.exists(worktreePath)} branchExisted=${branchExists}`);
    // Guard against git reporting success without actually materializing the
    // worktree (e.g. it created only the branch): never register a phantom entry.
    if (!this.fs.exists(worktreePath)) {
      throw new Error(`git worktree add did not create the directory: ${worktreePath}`);
    }

    const xdebugPort = this.portAllocator.allocate();
    const worktree: Worktree = {
      id: randomUUID(),
      branch,
      alias: alias || undefined,
      path: worktreePath,
      repoRoot,
      xdebugPort,
      dockerProjectName: branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
      createdAt: Date.now(),
    };

    this.generateLaunchJson(worktree);
    this.generateSettingsJson(worktree);
    await this.store.add(worktree);

    return worktree;
  }

  async delete(id: string, deleteBranch = false): Promise<void> {
    const worktree = this.store.get(id);
    if (!worktree) return;

    this.agentManager?.terminateSession(worktree.id);

    try {
      await this.git.deleteWorktree(worktree.path, worktree.repoRoot);
    } catch {
      // worktree may already be gone
    }

    if (deleteBranch) {
      try {
        this.git.deleteBranch(worktree.branch, worktree.repoRoot);
      } catch {
        // branch may not exist
      }
    }

    await this.store.remove(id);
  }

  private resolveWorktreesDir(repoRoot: string): string {
    const dir = this.config.get().worktreesDirectory;
    return path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
  }

  private generateLaunchJson(worktree: Worktree): void {
    const template = this.config.get().debugTemplate;
    if (!template.name) template.name = `Unmess: Xdebug (${worktree.branch})`;

    const config = JSON.parse(
      JSON.stringify(template)
        .replace(/"\{\{PORT\}\}"/g, String(worktree.xdebugPort))
        .replace(/\{\{WORKTREE_PATH\}\}/g, worktree.path)
        .replace(/\{\{PORT\}\}/g, String(worktree.xdebugPort)),
    );

    const launchJson = { version: '0.2.0', configurations: [config] };
    const launchPath = path.join(worktree.path, LAUNCH_JSON_PATH);
    this.fs.mkdir(path.dirname(launchPath));
    this.fs.writeFile(launchPath, JSON.stringify(launchJson, null, 4));
  }

  private generateSettingsJson(worktree: Worktree): void {
    const settingsPath = path.join(worktree.path, SETTINGS_JSON_PATH);
    this.fs.mkdir(path.dirname(settingsPath));
    this.fs.writeFile(settingsPath, JSON.stringify(WORKTREE_SETTINGS_EXCLUSIONS, null, 4));
  }

}
