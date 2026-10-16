import React, { useMemo } from 'react';
import { parseTemplate } from '../../draft';
import { DEBUG_PRESETS, STACK_ORDER, presetFor } from '../../presets';
import type { Stack } from '../../types';
import { STR } from '../strings';
import { Banner, Button, Card, Field, Icon, PortInput, Select } from '../ui';
import { RepoGate, RepoNotices, type Ctx } from './context';

export const DEBUG_KEYS = ['debugBasePort', 'debugTemplate'];
const text = (s: Stack) => JSON.stringify(DEBUG_PRESETS[s].template, null, 2);

export function DebuggingSection({ ctx }: { ctx: Ctx }) {
  const { draft, errors, snap } = ctx;
  const parsed = useMemo(() => parseTemplate(draft.templateText), [draft.templateText]);
  const current = 'value' in parsed ? presetFor(parsed.value) : undefined;
  const suggested = snap.detected.stack && snap.detected.stack !== current ? snap.detected.stack : undefined;
  const error = errors.debugTemplate === 'json' ? STR.templateBad : errors.debugTemplate === 'shape' ? STR.templateShape : undefined;
  const format = () => { if ('value' in parsed) ctx.setTemplateText(JSON.stringify(parsed.value, null, 2)); };
  return (
    <RepoGate ctx={ctx}>
      <RepoNotices ctx={ctx} keys={DEBUG_KEYS} />
      {suggested && (
        <Banner tone="accent" icon="sparkle" title={STR.stackHint(DEBUG_PRESETS[suggested].label.split(' — ')[0])}
          action={<Button small kind="accent" onClick={() => ctx.setTemplateText(text(suggested))}>{STR.usePreset}</Button>} />
      )}
      <Card title={STR.debugPorts} scope="repo" file={ctx.file}>
        <div className="st-grid">
          <Field label={STR.debugBasePort} hint={STR.debugBasePortHint} error={errors.debugBasePort && STR.portRange}>
            {(a) => <PortInput {...a} value={draft.numbers.debugBasePort} onChange={(v) => ctx.setNumber('debugBasePort', v)} />}
          </Field>
          <Field label={STR.debugger} hint={STR.debuggerHint}>
            {(a) => (
              <Select
                id={a.id} describedBy={a.describedBy} value={current ?? 'custom'} options={[...STACK_ORDER, 'custom']}
                labels={{ ...Object.fromEntries(STACK_ORDER.map((s) => [s, DEBUG_PRESETS[s].label])), custom: STR.custom }}
                onChange={(v) => { if (v !== 'custom') ctx.setTemplateText(text(v as Stack)); }}
              />
            )}
          </Field>
        </div>
      </Card>
      <Card title={STR.templateCard} scope="repo" file={ctx.file}>
        <Field label={STR.template} hint={STR.templateHint} error={error}>
          {(a) => (
            <>
              <textarea
                id={a.id} className="st-input mono" value={draft.templateText} spellCheck={false}
                aria-describedby={a.describedBy} aria-invalid={a.invalid || undefined}
                rows={Math.min(16, Math.max(6, draft.templateText.split('\n').length + 1))}
                onChange={(e) => ctx.setTemplateText(e.target.value)}
              />
              <div className="st-editor-head">
                <span className="st-valid" data-bad={!!error}><Icon name={error ? 'error' : 'check'} />{error ? STR.templateBad : STR.templateOk}</span>
                <Button small kind="ghost" icon="list-flat" onClick={format} disabled={!!error}>{STR.format}</Button>
              </div>
            </>
          )}
        </Field>
      </Card>
    </RepoGate>
  );
}
