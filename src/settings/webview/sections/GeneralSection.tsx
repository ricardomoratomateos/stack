import React from 'react';
import { PROVIDER_IDS, PROVIDER_INSTALL, type ProviderId } from '../../../ports/IAgentProvider';
import { ProviderMark } from '../../../webview/components/providers';
import type { CommandKey } from '../../draft';
import type { UserValues } from '../../types';
import { STR } from '../strings';
import { Card, Field, TextInput } from '../ui';
import type { Ctx } from './context';

export const commandKey = (id: ProviderId): CommandKey => `${id}Command` as CommandKey;

function AgentRow({ id, ctx }: { id: ProviderId; ctx: Ctx }) {
  const key = commandKey(id);
  const installed = ctx.snap.installedProviders.includes(id);
  const isDefault = ctx.user.defaultProvider === id;
  return (
    <li className="st-agent">
      <span className="st-agent-mark"><ProviderMark provider={id} size={16} /></span>
      <div>
        <span className="st-agent-name">{PROVIDER_INSTALL[id].label}</span>
        <span className="st-status" data-ok={installed}>{installed ? STR.installed : STR.notFound}</span>
        {!installed && <code className="st-install">{PROVIDER_INSTALL[id].install}</code>}
      </div>
      <Field label={STR.command} hideLabel error={ctx.userErrors[key] && STR.commandRequired}>
        {(a) => <TextInput {...a} mono value={ctx.user[key]} onChange={(v) => ctx.patchUser({ [key]: v } as Partial<UserValues>)} />}
      </Field>
      <label className="st-pick">
        <input type="radio" name="default-agent" checked={isDefault} onChange={() => ctx.patchUser({ defaultProvider: id })} />
        {isDefault ? STR.isDefault : STR.makeDefault}
      </label>
    </li>
  );
}

export function GeneralSection({ ctx }: { ctx: Ctx }) {
  return (
    <Card title={STR.agents} hint={STR.agentsHint} scope="me" file={ctx.file}>
      <ul role="radiogroup" aria-label={STR.agents} style={{ display: 'contents' }}>
        {PROVIDER_IDS.map((id) => <AgentRow key={id} id={id} ctx={ctx} />)}
      </ul>
    </Card>
  );
}
