import React from 'react';
import { STR } from '../strings';
import { Card, SwitchRow } from '../ui';
import type { Ctx } from './context';

export function NotificationsSection({ ctx }: { ctx: Ctx }) {
  return (
    <Card title={STR.notifyCard} scope="me" file={ctx.file}>
      <SwitchRow label={STR.notify} hint={STR.notifyHint} checked={ctx.user.notifyOnAttention} onChange={(v) => ctx.patchUser({ notifyOnAttention: v })} />
    </Card>
  );
}
