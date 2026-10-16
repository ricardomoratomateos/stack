import React from 'react';
import { SIDEBAR_STYLES, SIDEBAR_STYLE_INFO, type SidebarStyle } from '../../../sidebarStyle';
import type { UserValues } from '../../types';
import { STR } from '../strings';
import { Card, Field, Icon, Select } from '../ui';
import type { Ctx } from './context';
import { StylePreview } from './StylePreview';

export function AppearanceSection({ ctx }: { ctx: Ctx }) {
  const { user } = ctx;
  return (
    <>
      <Card title={STR.sidebarStyle} hint={STR.sidebarStyleHint} scope="me" file={ctx.file}>
        <div className="st-styles" role="radiogroup" aria-label={STR.sidebarStyle}>
          {SIDEBAR_STYLES.map((id) => (
            <label key={id} className={`st-style fm-${id}`}>
              <input type="radio" name="sidebar-style" value={id} checked={user.sidebarStyle === id} onChange={() => ctx.patchUser({ sidebarStyle: id as SidebarStyle })} />
              <StylePreview id={id} />
              <span className="st-style-body">
                <span className="st-style-name">
                  <i className="st-swatch" aria-hidden="true" />{SIDEBAR_STYLE_INFO[id].label}
                  <span className="st-style-check"><Icon name="check" /></span>
                </span>
                <span className="st-style-desc">{SIDEBAR_STYLE_INFO[id].description}</span>
              </span>
            </label>
          ))}
        </div>
      </Card>
      <Card title={STR.sessions} scope="me" file={ctx.file}>
        <Field label={STR.sessionTabs} hint={STR.sessionTabsHint}>
          {(a) => (
            <Select
              id={a.id} describedBy={a.describedBy} value={user.sessionTabs} options={['perSession', 'single']}
              labels={{ perSession: STR.perSession, single: STR.single }}
              onChange={(v) => ctx.patchUser({ sessionTabs: v as UserValues['sessionTabs'] })}
            />
          )}
        </Field>
      </Card>
    </>
  );
}
