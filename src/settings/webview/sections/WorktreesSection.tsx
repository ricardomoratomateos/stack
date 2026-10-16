import React from 'react';
import { STR } from '../strings';
import { Card, Field, Select, SwitchRow, TextInput } from '../ui';
import { RepoGate, RepoNotices, type Ctx } from './context';

export const WORKTREE_KEYS = ['worktreesDirectory', 'defaultBaseBranch'];

export function WorktreesSection({ ctx }: { ctx: Ctx }) {
  const { draft, errors, snap, user } = ctx;
  const branches = [...new Set([draft.project.defaultBaseBranch, ...snap.branches])].filter(Boolean);
  return (
    <>
      <RepoGate ctx={ctx}>
        <RepoNotices ctx={ctx} keys={WORKTREE_KEYS} />
        <Card title={STR.worktreesLocation} scope="repo" file={ctx.file}>
          <div className="st-grid">
            <Field label={STR.worktreesDir} hint={STR.worktreesDirHint} error={errors.worktreesDirectory && STR.required}>
              {(a) => <TextInput {...a} mono value={draft.project.worktreesDirectory} onChange={(v) => ctx.patch({ worktreesDirectory: v })} />}
            </Field>
            <Field label={STR.baseBranch} hint={STR.baseBranchHint} error={errors.defaultBaseBranch && STR.required}>
              {(a) => <Select id={a.id} describedBy={a.describedBy} value={draft.project.defaultBaseBranch} options={branches} onChange={(v) => ctx.patch({ defaultBaseBranch: v })} />}
            </Field>
          </div>
        </Card>
      </RepoGate>
      <Card title={STR.behaviour} scope="me" file={ctx.file}>
        <SwitchRow label={STR.focusMode} hint={STR.focusModeHint} checked={user.focusMode} onChange={(v) => ctx.patchUser({ focusMode: v })} />
        <SwitchRow label={STR.scopeSearch} hint={STR.scopeSearchHint} checked={user.scopeSearchToActiveWorktree} onChange={(v) => ctx.patchUser({ scopeSearchToActiveWorktree: v })} />
      </Card>
    </>
  );
}
