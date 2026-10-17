import React from 'react';
import type { FileField } from '../../types';
import { STR } from '../strings';
import { Card, Field, FileInput, SwitchRow } from '../ui';
import { RepoGate, RepoNotices, type Ctx } from './context';

export const SCRIPT_KEYS = ['setupScript', 'setupInTerminal', 'teardownScript'];
const ENV = ['STACK_REPO_ROOT', 'STACK_WORKTREE_PATH', 'STACK_BRANCH', 'STACK_COMPOSE_PROJECT', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE'];

function ScriptCard({ ctx, kind }: { ctx: Ctx; kind: 'setup' | 'teardown' }) {
  const key = kind === 'setup' ? 'setupScript' : 'teardownScript';
  const field: FileField = key;
  return (
    <Card title={kind === 'setup' ? STR.setup : STR.teardown} hint={kind === 'setup' ? STR.setupHint : STR.teardownHint} scope="repo" file={ctx.file}>
      <Field label="Script">
        {(a) => (
          <FileInput
            id={a.id} value={ctx.draft.project[key]} placeholder={STR.scriptPlaceholder}
            onChange={(v) => ctx.patch({ [key]: v })} onPick={() => ctx.pick(field)} onCreate={() => ctx.createScript(kind)}
          />
        )}
      </Field>
      {kind === 'setup' && (
        <SwitchRow
          label={STR.setupInTerminal} hint={STR.setupInTerminalHint}
          checked={ctx.draft.project.setupInTerminal} onChange={(v) => ctx.patch({ setupInTerminal: v })}
        />
      )}
    </Card>
  );
}

export function ScriptsSection({ ctx }: { ctx: Ctx }) {
  return (
    <RepoGate ctx={ctx}>
      <RepoNotices ctx={ctx} keys={SCRIPT_KEYS} />
      <ScriptCard ctx={ctx} kind="setup" />
      <ScriptCard ctx={ctx} kind="teardown" />
      <details className="st-details">
        <summary>{STR.scriptEnv}</summary>
        <div>
          <div className="st-envs">{ENV.map((v) => <code key={v}>{v}</code>)}</div>
          <p className="st-note">{STR.scriptEnvBody}</p>
        </div>
      </details>
    </RepoGate>
  );
}
