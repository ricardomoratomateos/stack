import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorktreeEntry, IGitPort, DiffOptions } from '../ports/IGitPort';
import { MAIN_BRANCH_CANDIDATES } from '../constants';

const execAsync = promisify(exec);
// git worktree add on a huge repo streams a lot of "Updating files" progress to
// stderr — give it room so exec never fails with "maxBuffer exceeded".
const MAX_BUFFER = 1024 * 1024 * 64;

/**
 * Parses `git worktree list --porcelain` output.
 * A block needs BOTH a `worktree` path and a `branch` line to be included —
 * detached-HEAD worktrees (no branch line) are intentionally skipped.
 */
export function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const worktrees: GitWorktreeEntry[] = [];
  const blocks = output.trim().split('\n\n');
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const wt: Partial<GitWorktreeEntry> = {};
    for (const line of lines) {
      if (line.startsWith('worktree ')) wt.path = line.slice(9).trim();
      if (line.startsWith('HEAD ')) wt.head = line.slice(5).trim();
      if (line.startsWith('branch ')) wt.branch = line.slice(7).replace('refs/heads/', '').trim();
    }
    if (wt.path && wt.branch) worktrees.push(wt as GitWorktreeEntry);
  }
  return worktrees;
}

/** IGitPort implementation backed by the git CLI (synchronous, matching the port). */
export class GitCliAdapter implements IGitPort {
  listWorktrees(repoRoot: string): GitWorktreeEntry[] {
    try {
      const output = execSync('git worktree list --porcelain', { cwd: repoRoot, encoding: 'utf8' });
      return parseWorktreeList(output);
    } catch {
      return [];
    }
  }

  async createWorktree(
    worktreePath: string,
    branch: string,
    repoRoot: string,
    newBranch: boolean,
    baseBranch?: string,
    trackRemote?: string,
  ): Promise<void> {
    // A new branch can start from an explicit base ref; without one git uses the
    // repo's current HEAD. Reusing an existing branch ignores the base entirely.
    //
    // trackRemote is the third case: the branch exists only on the remote. It
    // must start from that ref and track it, or the work already pushed there is
    // silently replaced by an empty branch cut from the base.
    const cmd = trackRemote
      ? `git worktree add --track -b "${branch}" "${worktreePath}" "${trackRemote}"`
      : newBranch
      ? `git worktree add -b "${branch}" "${worktreePath}"${baseBranch ? ` "${baseBranch}"` : ''}`
      : `git worktree add "${worktreePath}" "${branch}"`;
    await execAsync(cmd, { cwd: repoRoot, maxBuffer: MAX_BUFFER });
  }

  /**
   * The remote ref for a branch with no local counterpart.
   *
   * `branchExists` uses `rev-parse --verify <branch>`, which does NOT resolve a
   * remote-only branch — so typing the name of a branch you pushed from another
   * machine looked like a brand-new branch, and Foreman cut an empty one from the
   * base under that same name.
   */
  remoteBranch(branch: string, repoRoot: string): string | undefined {
    try {
      const remotes = execSync('git remote', { cwd: repoRoot, encoding: 'utf8' })
        .split('\n').map((r) => r.trim()).filter(Boolean);
      for (const remote of remotes) {
        const ref = `${remote}/${branch}`;
        try {
          execSync(`git rev-parse --verify --quiet "${ref}^{commit}"`, { cwd: repoRoot, stdio: 'pipe' });
          return ref;
        } catch { /* try the next remote */ }
      }
    } catch { /* no remotes, or git failed */ }
    return undefined;
  }

  /**
   * The repository's own main line, so Foreman does not have to assume one.
   * Reuses the same resolution the diff already relies on.
   */
  mainBranch(repoRoot: string): string | undefined {
    const ref = this.resolveMainBranch(repoRoot, MAIN_BRANCH_CANDIDATES);
    // Strip the remote prefix: callers want a branch to start FROM, and
    // `git worktree add -b x <path> origin/main` and `... main` differ only in
    // which one exists locally.
    return ref?.replace(/^origin\//, '');
  }

  listBranches(repoRoot: string): string[] {
    try {
      // The format must be quoted: unquoted parentheses are shell syntax.
      const out = execSync(
        "git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/",
        { cwd: repoRoot, encoding: 'utf8' },
      );
      return out.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async deleteWorktree(worktreePath: string, repoRoot: string): Promise<void> {
    await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: repoRoot, maxBuffer: MAX_BUFFER });
  }

  deleteBranch(branch: string, repoRoot: string): void {
    execSync(`git branch -D "${branch}"`, { cwd: repoRoot });
  }

  branchExists(branch: string, repoRoot: string): boolean {
    try {
      execSync(`git rev-parse --verify "${branch}"`, { cwd: repoRoot, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  currentBranch(cwd: string): string {
    return execSync('git branch --show-current', { cwd, encoding: 'utf8' }).trim();
  }

  /** First candidate that resolves to a real ref (local or origin/), else undefined. */
  private resolveMainBranch(cwd: string, candidates: string[]): string | undefined {
    for (const name of candidates) {
      for (const ref of [name, `origin/${name}`]) {
        try {
          execSync(`git rev-parse --verify --quiet "${ref}^{commit}"`, { cwd, stdio: 'pipe' });
          return ref;
        } catch { /* try next */ }
      }
    }
    return undefined;
  }

  async diff(worktreePath: string, opts: DiffOptions): Promise<string> {
    try {
      if (opts.base === 'working') {
        // Tracked changes vs HEAD…
        const tracked = await execAsync('git diff HEAD', { cwd: worktreePath, maxBuffer: MAX_BUFFER });
        // …plus untracked files rendered as additions (git diff HEAD omits them).
        const untracked = await this.untrackedDiff(worktreePath);
        return tracked.stdout + untracked;
      }
      const candidates = opts.mainBranchCandidates ?? MAIN_BRANCH_CANDIDATES;
      const mainRef = this.resolveMainBranch(worktreePath, candidates);
      // Three-dot: diff from the merge-base, i.e. only what THIS branch introduced.
      // With no main ref (e.g. main itself, or a fresh repo) fall back to vs-HEAD.
      const range = mainRef ? `${mainRef}...HEAD` : 'HEAD';
      const { stdout } = await execAsync(`git diff ${range}`, { cwd: worktreePath, maxBuffer: MAX_BUFFER });
      return stdout;
    } catch {
      return '';
    }
  }

  /** Diff each untracked file against /dev/null so new files show up in the review. */
  private async untrackedDiff(cwd: string): Promise<string> {
    try {
      const { stdout } = await execAsync('git ls-files --others --exclude-standard -z', { cwd, maxBuffer: MAX_BUFFER });
      const files = stdout.split('\0').filter(Boolean);
      let out = '';
      for (const file of files) {
        try {
          // Exit code 1 (differences found) is the normal case — swallow via `|| true`.
          const { stdout: d } = await execAsync(
            `git diff --no-index -- /dev/null "${file}" || true`,
            { cwd, maxBuffer: MAX_BUFFER },
          );
          out += d;
        /* v8 ignore next 2 -- `|| true` keeps git from erroring; defensive only */
        } catch { /* binary / unreadable — skip */ }
      }
      return out;
    /* v8 ignore next 3 -- ls-files can't fail once `git diff HEAD` has succeeded */
    } catch {
      return '';
    }
  }

  async fetchBranch(cwd: string, remote: string, branch: string): Promise<void> {
    // Both come from git's own output or a validated ref, but they land in a
    // shell command, so anything that is not ref-shaped is refused rather than
    // escaped.
    for (const part of [remote, branch]) {
      if (!/^[\w./-]+$/.test(part)) throw new Error(`refusing to fetch "${part}"`);
    }
    await execAsync(`git fetch "${remote}" "${branch}"`, { cwd, maxBuffer: MAX_BUFFER });
  }
}
