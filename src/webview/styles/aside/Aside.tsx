import React, { useState } from 'react';
import { send } from '../../vscode';
import { PRODUCT_NAME } from '../../brand';
import { GROUP_LABEL, GROUP_SHORT, countByGroup, formatAge, type Described, type WorktreeGroup } from '../../derive';
import { Details, DiffStat } from '../../components/Details';
import { LaunchSplit } from '../../components/LaunchSplit';
import { ActionBar } from '../../components/ActionBar';
import { visualFor } from '../../components/providers';
import { AskBox, ForgetActions } from '../../components/RowParts';
import { SessionList } from '../../components/SessionList';
import { EmptyState, HealthStrip, LoadingState, NothingHere } from '../../components/Status';
import type { LayoutProps } from '../types';

const CHIPS: WorktreeGroup[] = ['needs', 'review', 'working', 'idle'];

const NONE: Record<WorktreeGroup, string> = {
  needs: 'Nothing needs you right now',
  review: 'Nothing is ready for review',
  working: 'No agent is working',
  idle: 'Nothing is idle',
  missing: 'No worktree is missing',
};

/**
 * The brand mark: three worktrees stacked, the active one in front with a
 * prompt cut out of it — the same drawing as the activity-bar icon
 * (resources/icon.svg) and the Marketplace tile, in the tile's colours (the
 * lime box is `.as-mark`, the ink is currentColor). The mask ids are prefixed
 * so they cannot clash with anything else in the webview's one document.
 */
function Mark() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 100 100">
      <defs>
        <mask id="as-mark-mid" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <rect x="11" y="31" width="58" height="58" rx="16" fill="#000" />
        </mask>
        <mask id="as-mark-back" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <rect x="21" y="21" width="58" height="58" rx="16" fill="#000" />
        </mask>
        <mask id="as-mark-front" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <path d="M27.5 52l9 8-9 8" fill="none" stroke="#000" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M42.5 68h11" stroke="#000" strokeWidth="5.5" strokeLinecap="round" />
        </mask>
      </defs>
      <rect x="35" y="15" width="50" height="50" rx="12" fill="currentColor" opacity="0.32" mask="url(#as-mark-back)" />
      <rect x="25" y="25" width="50" height="50" rx="12" fill="currentColor" opacity="0.6" mask="url(#as-mark-mid)" />
      <rect x="15" y="35" width="50" height="50" rx="12" fill="currentColor" mask="url(#as-mark-front)" />
    </svg>
  );
}

export function Aside({ state, loaded, items, selectedId, select, dragFor, now }: LayoutProps) {
  const [filter, setFilter] = useState<WorktreeGroup | 'all'>('all');
  const counts = countByGroup(items);
  const visible = items.filter((d) => filter === 'all' || d.group === filter);

  return (
    <div className="fm fm-aside">
      {/* The native view header already says "Worktrees" and carries the + and
          the gear, so this row is only the brand. */}
      <div className="as-brand">
        <span className="as-mark"><Mark /></span>
        <span className="as-wordmark">{PRODUCT_NAME.toLowerCase()}</span>
        <span className="as-sub">/ aside</span>
      </div>

      <div className="as-composer-wrap">
        <button type="button" className="as-composer" aria-label="New task" onClick={() => send({ type: 'openNewTask' })}>
          <span className="as-placeholder fm-ellipsis">What should an agent build?</span>
          <span className="as-new">New</span>
        </button>
      </div>

      {loaded && items.length > 0 && (
        <div className="as-chips" role="group" aria-label="Filter by state">
          {CHIPS.map((group) => {
            const on = filter === group;
            return (
              <button key={group} type="button" className="as-chip" data-group={group} aria-pressed={on} onClick={() => setFilter(on ? 'all' : group)}>
                <span className="as-chip-dot" aria-hidden="true" />
                <span className="as-chip-n">{counts[group]}</span>
                <span>{GROUP_SHORT[group]}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="as-list">
        {/* The user's own order, never re-sorted by state: rows jumping between
            groups as agents worked was disorienting. The chips still filter. */}
        {!loaded ? <LoadingState /> : items.length === 0 ? <EmptyState /> : visible.length === 0 ? (
          <NothingHere text={NONE[filter as WorktreeGroup]} onClear={() => setFilter('all')} />
        ) : visible.map((d) => (
          <Row key={d.wt.id} d={d} selected={d.wt.id === selectedId} now={now} state={state} select={select} drag={dragFor(d.wt)} />
        ))}
      </div>

      {loaded && items.length > 0 && <HealthStrip items={items} state={state} />}
    </div>
  );
}

function Row({ d, selected, now, state, select, drag }: {
  d: Described;
  selected: boolean;
  now: number;
  state: LayoutProps['state'];
  select: LayoutProps['select'];
  drag: ReturnType<LayoutProps['dragFor']>;
}) {
  const wt = d.wt;
  const pick = () => select(wt.id);

  return (
    <div
      id={`fm-wt-${wt.id}`}
      className={`as-row fm-drag${wt.deleting ? ' fm-deleting' : ''}`}
      data-selected={selected || undefined}
      data-group={d.group}
      data-dragging={drag.dragging || undefined}
      data-over={drag.over || undefined}
      {...drag.props}
    >
      <button type="button" className="as-row-main" aria-current={selected || undefined} onClick={pick}>
        <span className="as-dot-wrap"><span className="as-dot" role="img" aria-label={GROUP_LABEL[d.group]} /></span>
        <span className="as-body">
          <span className="as-name fm-ellipsis" title={wt.branch}>{d.name}</span>
          <span className="as-line fm-ellipsis">
            {d.agent && <span className="as-provider">{visualFor(d.provider).label}</span>} {d.line}
          </span>
        </span>
        <span className="as-meta">
          <DiffStat diff={d.diff} />
          <span className="as-when">{formatAge(wt.since, now)}</span>
        </span>
      </button>

      {wt.dockerError && !selected && <div className="fm-row-error as-indent" title={wt.dockerError}>stack: {wt.dockerError}</div>}
      {d.group === 'needs' && <AskBox d={d} select={pick} />}
      {d.group === 'missing' && <ForgetActions d={d} />}

      {selected && d.group !== 'missing' && (
        <div className="as-expand">
          <Details d={d} dockerEnabled={state.dockerEnabled} />
          <SessionList wt={wt} variant="aside" onSelect={pick} />
          <div className="as-actions">
            <LaunchSplit
              wt={wt}
              defaultProvider={state.defaultProvider}
              installedProviders={state.installedProviders}
              tone="solid"
            />
            <ActionBar wt={wt} dockerEnabled={state.dockerEnabled} emphasis={d.group === 'review' ? 'diff' : undefined} />
          </div>
        </div>
      )}
    </div>
  );
}
