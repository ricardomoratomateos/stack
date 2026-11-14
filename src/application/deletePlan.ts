import type { WorkAtRisk } from '../ports/IGitPort';

/** The words of the delete confirm and the buttons that go with them. `keepBranch` indexes `choices`. */
export interface DeletePlan {
  detail: string;
  choices: string[];
  keepBranch: number;
}

/**
 * What deleting a worktree would throw away, in the confirm's own words, and
 * the buttons to match — from its git state read at the moment the delete is
 * asked for (IGitPort.workAtRisk), never from numbers minutes old.
 *
 * The confirm used to say nothing at all, over a `git worktree remove
 * --force` that discards uncommitted work and a `git branch -D` that
 * discards unmerged commits. Now a loss is said plainly, and the branch
 * option counts the commits it would take with it. Those are the ones that
 * exist nowhere else: with an upstream, the unpushed ones; without one (never
 * pushed, or deleted on the remote after a merge), everything the branch
 * added over its base.
 *
 * `undefined` is git not answering, which is said as such: "could not check"
 * must not read as "nothing to lose".
 *
 * `keepBranch` is the index in `choices` of the one that keeps the branch.
 */
export function planDelete(work: WorkAtRisk | undefined): DeletePlan {
  if (!work) {
    return {
      detail: 'Could not check for uncommitted changes or unpushed commits.',
      choices: ['Delete', 'Delete + branch'],
      keepBranch: 0,
    };
  }
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const lines: string[] = [];
  const parts = [
    work.staged > 0 ? `${work.staged} staged` : '',
    work.unstaged > 0 ? `${work.unstaged} unstaged` : '',
    work.untracked > 0 ? `${work.untracked} untracked` : '',
  ].filter(Boolean);
  if (parts.length > 0) lines.push(`Uncommitted changes (${parts.join(', ')}) are lost with the worktree.`);
  const unsaved = work.unpushed;
  if (unsaved > 0) {
    lines.push(work.upstream
      ? `${commits(unsaved)} not pushed.`
      : `${commits(unsaved)} not in ${work.against ?? 'the base branch'}, and the branch was never pushed.`);
    lines.push(`Deleting the branch too discards ${unsaved === 1 ? 'that commit' : `those ${commits(unsaved)}`}; "Delete" keeps it.`);
  }
  if (lines.length === 0) lines.push('No uncommitted changes and no unpushed commits.');
  return {
    detail: lines.join('\n'),
    choices: ['Delete', unsaved > 0 ? `Delete + branch (discards ${commits(unsaved)})` : 'Delete + branch'],
    keepBranch: 0,
  };
}
