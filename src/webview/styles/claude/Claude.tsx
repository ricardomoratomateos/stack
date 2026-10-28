import React from 'react';
import { send } from '../../vscode';
import { GROUP_LABEL, formatAge, type Described, type WorktreeGroup } from '../../derive';
import { Details, DiffStat, TicketChip } from '../../components/Details';
import { LaunchSplit } from '../../components/LaunchSplit';
import { ActionBar } from '../../components/ActionBar';
import { ProviderMark, visualFor } from '../../components/providers';
import { ForgetActions, RowLine, SetupActions } from '../../components/RowParts';
import { SessionList } from '../../components/SessionList';
import { EmptyState, HealthStrip, LoadingState } from '../../components/Status';
import type { LayoutProps } from '../types';

/** The state glyph in front of a row: the thing the eye finds first. */
function Glyph({ group }: { group: WorktreeGroup }) {
  switch (group) {
    case 'needs':
      return (
        <svg role="img" aria-label="Needs you" width="14" height="14" viewBox="0 0 16 16" className="cl-glyph-needs">
          <circle cx="8" cy="8" r="7" />
          <path d="M8 4.2v4.6" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="1.1" className="cl-glyph-ink" />
        </svg>
      );
    case 'review':
      return (
        <svg role="img" aria-label="Ready for review" width="14" height="14" viewBox="0 0 16 16" className="cl-glyph-review">
          <circle cx="8" cy="8" r="7" fill="none" strokeWidth="1.6" />
          <path d="M5 8.2l2 2 4-4.2" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'working':
      return <span role="img" aria-label="Working" className="cl-glyph-working u-dot-active">✻</span>;
    case 'missing':
      return (
        <svg role="img" aria-label="Missing" width="12" height="12" viewBox="0 0 16 16" className="cl-glyph-idle">
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.6" strokeDasharray="2.5 2.5" />
        </svg>
      );
    case 'idle':
      return (
        <svg role="img" aria-label="Idle" width="12" height="12" viewBox="0 0 16 16" className="cl-glyph-idle">
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.6" />
        </svg>
      );
  }
}

export function Claude({ state, loaded, items, controlItem, selectedId, select, dragFor, now }: LayoutProps) {
  const selected = items.find((d) => d.wt.id === selectedId);

  return (
    <div className="fm fm-claude">
      {/* Opens the same full-screen panel as the "+" in the view header: a task
          is described once, in one place. */}
      <div className="cl-composer-wrap">
        <button type="button" className="cl-composer" aria-label="New task: describe a task for a new agent" onClick={() => send({ type: 'openNewTask' })}>
          <span className="cl-prompt" aria-hidden="true">❯</span>
          <span className="cl-placeholder fm-ellipsis">Describe a task for a new agent…</span>
        </button>
      </div>

      {loaded && controlItem && (
        <div className="cl-pinned">
          <Row d={controlItem} selected={controlItem.wt.id === selectedId} now={now} state={state} select={select} drag={dragFor(controlItem.wt)} />
        </div>
      )}

      <div className="cl-list">
        {/* One list in the user's own order (drag to reorder). Grouping by state
            moved worktrees up and down every time an agent changed state; the
            state is on the row instead — its glyph, the question, the diff. */}
        {!loaded ? <LoadingState /> : items.length === 0 ? <EmptyState /> : items.map((d) => (
          <Row
            key={d.wt.id}
            d={d}
            selected={d.wt.id === selectedId}
            now={now}
            state={state}
            select={select}
            drag={dragFor(d.wt)}
          />
        ))}
      </div>

      {loaded && selected && !selected.wt.missing && (
        <section className="cl-foot" aria-label="Selected worktree">
          <div className="cl-foot-head">
            <span className="cl-foot-name fm-ellipsis">{selected.name}</span>
            <span className="cl-foot-branch fm-ellipsis" title={selected.wt.branch}>{selected.wt.branch}</span>
          </div>
          <Details d={selected} dockerEnabled={state.dockerEnabled} />
        </section>
      )}
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
  const provider = visualFor(d.provider);

  return (
    <div
      id={`fm-wt-${wt.id}`}
      className={`cl-row fm-drag${wt.deleting ? ' fm-deleting' : ''}${wt.isControl ? ' fm-control' : ''}`}
      data-selected={selected || undefined}
      data-group={d.group}
      data-dragging={drag.dragging || undefined}
      data-over={drag.over || undefined}
      {...drag.props}
    >
      <button type="button" className="cl-row-main" aria-current={selected || undefined} onClick={pick}>
        <span className="cl-glyph"><Glyph group={d.group} /></span>
        <span className="cl-body">
          <span className="cl-name">
            <span className="cl-name-text fm-ellipsis" title={d.wt.branch}>{d.name}</span>
            {wt.ticket && <TicketChip worktreeId={wt.id} ticket={wt.ticket} />}
            {wt.isMain && <span className="cl-tag">main</span>}
          </span>
          <span className="cl-line">
            {d.agent && <span className="cl-line-mark" title={provider.label}><ProviderMark provider={d.provider} size={11} /></span>}
            <span className="fm-ellipsis"><RowLine d={d} /></span>
          </span>
        </span>
        <span className="cl-meta">
          <DiffStat diff={d.diff} />
          <span className="cl-when">{formatAge(wt.since, now)}</span>
        </span>
      </button>

      {wt.dockerError && !selected && <div className="fm-row-error cl-indent" title={wt.dockerError}>Stack: {wt.dockerError}</div>}
      {d.group === 'missing' && <ForgetActions d={d} />}
      {wt.setup && !wt.deleting && <SetupActions d={d} />}

      {selected && d.group !== 'missing' && (
        <div className="cl-expand">
          <SessionList wt={wt} variant="claude" onSelect={pick} />
          <div className="cl-actions">
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
