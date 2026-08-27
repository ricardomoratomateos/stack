export interface GitWorktreeEntry {
  path: string;
  branch: string;
  head: string;
}

export interface IGitPort {
  /** `git worktree list --porcelain`, parsed. Returns [] on git failure. */
  listWorktrees(repoRoot: string): GitWorktreeEntry[];
  /** `git worktree add` (reuses branch) or `add -b` (creates it, off `baseBranch`
   *  when given, else the repo's current HEAD). Async so the huge checkout never
   *  blocks the extension host. Rejects on git failure. */
  createWorktree(
    worktreePath: string,
    branch: string,
    repoRoot: string,
    newBranch: boolean,
    baseBranch?: string,
    /** Remote ref to start from and track, for a branch that exists only on the remote. */
    trackRemote?: string,
  ): Promise<void>;
  /** Local branch names, most-recently-committed first. Returns [] on git failure. */
  listBranches(repoRoot: string): string[];
  /** `git worktree remove --force`. Async. Rejects on failure (caller decides to swallow). */
  deleteWorktree(worktreePath: string, repoRoot: string): Promise<void>;
  /** `git branch -D`. Throws on failure. */
  deleteBranch(branch: string, repoRoot: string): void;
  /** `git rev-parse --verify <branch>`. LOCAL branches only — see remoteBranch. */
  branchExists(branch: string, repoRoot: string): boolean;
  /** The remote ref for a branch that has no local counterpart, e.g. "origin/foo". */
  remoteBranch(branch: string, repoRoot: string): string | undefined;
  /**
   * The repository's own main line — the first of main/master/develop that
   * resolves, locally or on a remote. Undefined in a repo that has none.
   */
  mainBranch(repoRoot: string): string | undefined;
  /** `git branch --show-current`. Returns '' on detached HEAD, throws on git failure. */
  currentBranch(cwd: string): string;
  /**
   * Unified diff for a worktree. `base: 'working'` diffs the working tree against
   * HEAD (staged + unstaged + untracked); `base: 'branch'` diffs the whole branch
   * against its merge-base with the main branch (`<base>...HEAD`). Returns '' on
   * git failure or when there is nothing to show. Async — a big repo's diff can be
   * large, so it must never block the extension host.
   */
  diff(worktreePath: string, opts: DiffOptions): Promise<string>;
}

export type DiffBase = 'working' | 'branch';

export interface DiffOptions {
  base: DiffBase;
  /** Candidate main-branch names to resolve the merge-base against (branch mode). */
  mainBranchCandidates?: string[];
}
