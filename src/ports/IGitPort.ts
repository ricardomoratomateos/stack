export interface GitWorktreeEntry {
  path: string;
  branch: string;
  head: string;
  /**
   * Git itself reports the directory as gone (`prunable` in the porcelain
   * output): the administrative entry outlived an `rm -rf` of the worktree.
   */
  prunable?: boolean;
}

/** One block of `git worktree list --porcelain`, whatever its HEAD is doing. */
export interface GitWorktreePath {
  path: string;
  /** See GitWorktreeEntry.prunable. */
  prunable: boolean;
}

export interface IGitPort {
  /** `git worktree list --porcelain`, parsed. Returns [] on git failure. */
  listWorktrees(repoRoot: string): GitWorktreeEntry[];
  /**
   * Every worktree git knows about, detached ones included — listWorktrees
   * drops any block without a branch line, which is every worktree in the middle
   * of a rebase. Resolves `undefined` when git failed, so "git could not answer"
   * can never be read as "git has no worktrees".
   */
  listWorktreePaths(repoRoot: string): Promise<GitWorktreePath[] | undefined>;
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
   * against its merge-base with the main branch (`<base>...HEAD`). Returns ''
   * only when there is nothing to show; rejects with a DiffError when git fails,
   * so the two never look alike. Async — a big repo's diff can be large, so it
   * must never block the extension host.
   */
  diff(worktreePath: string, opts: DiffOptions): Promise<string>;
  /**
   * What deleting this worktree would lose, read on demand — one
   * `git status --porcelain` and one count of the commits only this branch
   * has: against its upstream, or without one against `baseBranch` (its
   * `origin/` ref first). Resolves `undefined` when git could not answer, so
   * "could not check" is never read as "nothing to lose".
   */
  workAtRisk(cwd: string, baseBranch?: string): Promise<WorkAtRisk | undefined>;
}

/** A worktree's uncommitted changes and unpushed commits; see IGitPort.workAtRisk. */
export interface WorkAtRisk {
  staged: number;
  unstaged: number;
  untracked: number;
  /** The branch has an upstream, and `unpushed` counts the commits it does not have. */
  upstream: boolean;
  /** Commits that exist only here: not on the upstream, or (without one) not in `against`. */
  unpushed: number;
  /** Without an upstream: the base ref `unpushed` was counted against, when one resolved. */
  against?: string;
}

export type DiffBase = 'working' | 'branch';

export interface DiffOptions {
  base: DiffBase;
  /** Candidate main-branch names to resolve the merge-base against (branch mode). */
  mainBranchCandidates?: string[];
}

/**
 * The diff could not be computed — as opposed to there being nothing to show.
 *
 * Those two used to be the same empty string, so a repository git could not
 * read, a worktree removed underneath the panel, or a base ref that no longer
 * resolves all told the reviewer "No changes to review" — the one answer that
 * sends them away believing the agent did nothing. `reason` is git's own
 * one-line complaint, meant to be shown as is.
 */
export class DiffError extends Error {
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`couldn't compute the diff: ${reason}`, { cause });
    this.name = 'DiffError';
  }
}
