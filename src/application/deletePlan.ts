import type { GitStatus, PrStatus } from '../webview/types';

/** The words of the delete confirm and the buttons that go with them. `keepBranch` indexes `choices`. */
export interface DeletePlan {
  detail: string;
  choices: string[];
  keepBranch: number;
}

/**
 * What deleting a worktree would throw away, in the confirm's own words, and
 * the buttons to match — from what Stack already knows: the git status, the
 * drift against the base, the PR.
 *
 * The confirm used to say nothing at all, over a `git worktree remove
 * --force` that discards uncommitted work and a `git branch -D` that
 * discards unmerged commits. Now a loss is said plainly, and the branch
 * option counts the commits it would take with it. Those are the ones that
 * exist nowhere else: with an upstream, the unpushed ones; without one (never
 * pushed, or deleted on the remote after a merge), everything the branch
 * added over its base — unless its PR was merged, which carried the work.
 *
 * A merged PR with nothing uncommitted and nothing unpushed is the end of
 * a task, not a risk, and the primary button says so: "Clean up", worktree
 * and branch both.
 *
 * `keepBranch` is the index in `choices` of the one that keeps the branch.
 */
export function planDelete(git: GitStatus, pr: PrStatus | null | undefined): DeletePlan {
  const merged = pr?.state === 'MERGED';
  const beyondBase = git.base?.ahead ?? 0;
  const unsaved = git.upstream ? git.ahead : merged ? 0 : beyondBase;
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

  const lines: string[] = [];
  if (git.hasChanges) {
    const parts = [
      git.staged > 0 ? `${git.staged} staged` : '',
      git.unstaged > 0 ? `${git.unstaged} unstaged` : '',
      git.untracked > 0 ? `${git.untracked} untracked` : '',
    ].filter(Boolean);
    lines.push(`Uncommitted changes (${parts.join(', ')}) are lost with the worktree.`);
  }
  if (git.upstream && git.ahead > 0) lines.push(`${commits(git.ahead)} not pushed.`);
  if (git.base && beyondBase > 0) {
    lines.push(`${commits(beyondBase)} not in ${git.base.ref}${git.upstream ? '' : ', and the branch was never pushed'}.`);
  }
  if (pr) lines.push(`PR #${pr.number} is ${pr.state === 'OPEN' && pr.isDraft ? 'a draft' : pr.state.toLowerCase()}.`);
  if (unsaved > 0) lines.push(`Deleting the branch too discards ${unsaved === 1 ? 'that commit' : `those ${commits(unsaved)}`}; "Delete" keeps it.`);

  if (merged && !git.hasChanges && unsaved === 0) {
    return {
      detail: `${lines.join('\n')}\nNothing here is uncommitted or unpushed: clean up removes the worktree and its branch.`,
      choices: ['Clean up', 'Delete, keep branch'],
      keepBranch: 1,
    };
  }
  if (lines.length === 0) lines.push('No uncommitted changes and no unpushed commits.');
  return {
    detail: lines.join('\n'),
    choices: ['Delete', unsaved > 0 ? `Delete + branch (discards ${commits(unsaved)})` : 'Delete + branch'],
    keepBranch: 0,
  };
}

