import React from 'react';
import { STR } from '../strings';
import { Banner, Button, Card, ChipList, Field, FileInput, PortInput, SwitchRow } from '../ui';
import { RepoGate, RepoNotices, type Ctx } from './context';

export const DOCKER_KEYS = ['docker'];

function Detected({ ctx }: { ctx: Ctx }) {
  const { detected } = ctx.snap;
  const { docker } = ctx.draft.project;
  if (ctx.draft.dockerOn || detected.composeFiles.length === 0) return null;
  const apply = () => {
    ctx.patchDocker({
      composeFile: detected.composeBase ?? docker.composeFile,
      overrideFile: detected.composeOverride ?? docker.overrideFile,
      ports: detected.portVars.length > 0 ? detected.portVars : docker.ports,
    });
    ctx.setDockerOn(true);
  };
  return (
    <Banner tone="accent" icon="sparkle" title="Docker setup detected" action={<Button small kind="accent" onClick={apply}>{STR.dockerUse}</Button>}>
      {STR.dockerFound(detected.composeFiles.join(', '))}
    </Banner>
  );
}

function Files({ ctx }: { ctx: Ctx }) {
  const { docker } = ctx.draft.project;
  return (
    <Card title={STR.files} scope="repo" file={ctx.file}>
      <div className="st-grid one">
        <Field label={STR.composeFile} hint={STR.composeFileHint}>
          {(a) => <FileInput {...a} value={docker.composeFile} onChange={(v) => ctx.patchDocker({ composeFile: v })} onPick={() => ctx.pick('composeFile')} />}
        </Field>
        <Field label={STR.overrideFile} hint={STR.overrideFileHint}>
          {(a) => <FileInput {...a} value={docker.overrideFile} onChange={(v) => ctx.patchDocker({ overrideFile: v })} onPick={() => ctx.pick('overrideFile')} />}
        </Field>
      </div>
      <details className="st-details">
        <summary>{STR.overrideMore}</summary>
        <div><p className="st-note">{STR.overrideMoreBody}</p></div>
      </details>
    </Card>
  );
}

function Ports({ ctx }: { ctx: Ctx }) {
  const { draft, errors, snap } = ctx;
  const { docker } = draft.project;
  const suggestions = snap.detected.portVars.filter((v) => !docker.ports.includes(v));
  const vars = docker.ports.filter((p) => p !== 'DEBUG_PORT').length;
  const stride = Number(draft.numbers.portStride);
  const tight = !errors.portStride && stride < vars;
  return (
    <Card title={STR.ports} scope="repo" file={ctx.file}>
      <Field label={STR.portsLabel} hint={STR.portsHint}>
        {(a) => <ChipList {...a} items={docker.ports} suggestions={suggestions} onChange={(ports) => ctx.patchDocker({ ports })} />}
      </Field>
      <div className="st-grid">
        <Field label={STR.basePort} hint={STR.basePortHint} error={errors.basePort && STR.portRange}>
          {(a) => <PortInput {...a} value={draft.numbers.basePort} onChange={(v) => ctx.setNumber('basePort', v)} />}
        </Field>
        <Field
          label={STR.portStride} error={errors.portStride && STR.portRange}
          hint={tight ? STR.strideTight(vars, stride) : STR.portStrideHint(stride)}
        >
          {(a) => <PortInput {...a} value={draft.numbers.portStride} onChange={(v) => ctx.setNumber('portStride', v)} />}
        </Field>
      </div>
    </Card>
  );
}

export function DockerSection({ ctx }: { ctx: Ctx }) {
  return (
    <RepoGate ctx={ctx}>
      <RepoNotices ctx={ctx} keys={DOCKER_KEYS} />
      <Detected ctx={ctx} />
      <Card title={STR.dockerCard} scope="repo" file={ctx.file}>
        <SwitchRow label={STR.dockerToggle} hint={STR.dockerToggleHint} checked={ctx.draft.dockerOn} onChange={ctx.setDockerOn} />
      </Card>
      {ctx.draft.dockerOn && <Files ctx={ctx} />}
      {ctx.draft.dockerOn && <Ports ctx={ctx} />}
    </RepoGate>
  );
}
