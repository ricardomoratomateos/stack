import React from 'react';
import type { DockerConfig } from '../../../types';
import type { CommandKey, NumericField, ProjectDraft, ProjectErrors } from '../../draft';
import { problemKey } from '../../draft';
import type { FileField, ProjectValues, SettingsSnapshot, UserValues } from '../../types';
import { STR } from '../strings';
import { Banner, Button, Icon } from '../ui';

const REPO_KEYS = ['worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'setupInTerminal', 'teardownScript', 'docker', 'debugBasePort', 'debugTemplate'];

/** What every section reads and edits: the snapshot, both drafts, and the ways to change them. */
export interface Ctx {
  snap: SettingsSnapshot;
  hasRepo: boolean;
  /** The repo file in use, as a repo-relative path. */
  file: string;
  draft: ProjectDraft;
  user: UserValues;
  errors: ProjectErrors;
  userErrors: Partial<Record<CommandKey, 'required'>>;
  patch(p: Partial<ProjectValues>): void;
  patchDocker(d: Partial<DockerConfig>): void;
  setNumber(field: NumericField, text: string): void;
  setDockerOn(on: boolean): void;
  setTemplateText(text: string): void;
  patchUser(u: Partial<UserValues>): void;
  pick(field: FileField): void;
  createScript(kind: 'setup' | 'teardown'): void;
  clearOverrides(): void;
  openFile(): void;
  /** Register or remove the manager MCP with Claude Code — immediate, not part of the save bar. */
  setManager(enabled: boolean): void;
}

/**
 * What the repository file needs to say at the top of a section that writes to
 * it: that it is about to be created, that it is the legacy one, the problems
 * it reads back with (only those about this section's keys, plus any that name
 * no key), and the personal overrides that would shadow what is saved.
 */
export function RepoNotices({ ctx, keys }: { ctx: Ctx; keys: string[] }) {
  const { snap, file } = ctx;
  const problems = snap.projectFile.problems.filter((p) => {
    const key = problemKey(p);
    // A problem about a key none of the sections edit (an unknown one, say) has no home, so it shows everywhere.
    return key === undefined || keys.includes(key) || !REPO_KEYS.includes(key);
  });
  const overrides = snap.personalOverrides.filter((k) => keys.includes(k));
  return (
    <>
      {!snap.projectFile.present && <Banner tone="info" icon="new-file">{STR.newFile(file)}</Banner>}
      {snap.projectFile.legacy && <Banner tone="info">{STR.legacyFile(file)}</Banner>}
      {problems.length > 0 && (
        <Banner
          tone="warn" title={STR.fileProblems(file)}
          action={snap.projectFile.present ? <Button small icon="go-to-file" onClick={ctx.openFile}>{STR.openFile}</Button> : undefined}
        >
          {STR.fileProblemsHint}
          <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Banner>
      )}
      {overrides.length > 0 && (
        <Banner tone="warn" title="Overridden by your settings.json" action={<Button small onClick={ctx.clearOverrides}>{STR.clearOverrides}</Button>}>
          {STR.overrides(overrides.join(', '))}
        </Banner>
      )}
    </>
  );
}

/** Repository fields need a repository; without one, say so instead of showing inert inputs. */
export function RepoGate({ ctx, children }: { ctx: Ctx; children: React.ReactNode }) {
  if (ctx.hasRepo) return <>{children}</>;
  return (
    <div className="st-empty">
      <Icon name="repo" />
      <h3>{STR.noRepoTitle}</h3>
      <p>{STR.noRepoBody}</p>
    </div>
  );
}
