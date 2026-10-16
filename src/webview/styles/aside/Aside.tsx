import React, { useState } from 'react';
import { send } from '../../vscode';
import { PRODUCT_NAME } from '../../brand';
import { GROUP_LABEL, GROUP_ORDER, GROUP_SHORT, countByGroup, formatAge, type Described, type WorktreeGroup } from '../../derive';
import { Details, DiffStat } from '../../components/Details';
import { LaunchSplit } from '../../components/LaunchSplit';
import { MoreMenu } from '../../components/MoreMenu';
import { visualFor } from '../../components/providers';
import { AskBox, ForgetActions, ReviewActions } from '../../components/RowParts';
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

/** The brand mark: three commits on a branch, the same drawing as the activity-bar icon. */
function Mark() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 64 64" fill="none" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 52V12" /><path d="M18 22h14a8 8 0 0 0 8-8" /><path d="M18 38h10a8 8 0 0 0 8-8" />
    </svg>
  );
}

export function Aside({ state, loaded, items, selectedId, select, dragFor, now }: LayoutProps) {
  const [filter, setFilter] = useState<WorktreeGroup | 'all'>('all');
  const counts = countByGroup(items);
  const visible = items.filter((d) => filter === 'all' || d.group === filter);
  const groups = GROUP_ORDER
    .map((group) => ({ group, items: visible.filter((d) => d.group === group) }))
    .filter((g) => g.items.length > 0);

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
        {!loaded ? <LoadingState /> : items.length === 0 ? <EmptyState /> : groups.length === 0 ? (
          <NothingHere text={NONE[filter as WorktreeGroup]} onClear={() => setFilter('all')} />
        ) : groups.map(({ group, items: rows }) => (
          <section key={group} aria-label={GROUP_LABEL[group]}>
            <h2 className="as-group-head">{GROUP_LABEL[group]}</h2>
            {rows.map((d) => (
              <Row key={d.wt.id} d={d} selected={d.wt.id === selectedId} now={now} state={state} select={select} drag={dragFor(d.wt)} />
            ))}
          </section>
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
      {d.group === 'review' && <ReviewActions d={d} buttonClass="fm-btn-primary" />}
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
              label="+ Agent"
              tone="solid"
            />
            <button type="button" className="fm-btn" onClick={() => send({ type: 'openTerminal', worktreeId: wt.id })}>Shell</button>
            <button type="button" className="fm-btn" onClick={() => send({ type: 'openDiff', worktreeId: wt.id })}>Diff</button>
            <MoreMenu wt={wt} dockerEnabled={state.dockerEnabled} />
          </div>
        </div>
      )}
    </div>
  );
}
