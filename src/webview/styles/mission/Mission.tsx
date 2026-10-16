import React, { useState } from 'react';
import { send } from '../../vscode';
import { GROUP_SHORT, attentionQueue, countByGroup, formatAge, type Described, type WorktreeGroup } from '../../derive';
import { DiffStat, PrBadge, Details } from '../../components/Details';
import { LaunchSplit } from '../../components/LaunchSplit';
import { ActionBar } from '../../components/ActionBar';
import { visualFor } from '../../components/providers';
import { openAsking } from '../../components/RowParts';
import { SessionList } from '../../components/SessionList';
import { EmptyState, HealthStrip, LoadingState, NothingHere } from '../../components/Status';
import type { LayoutProps } from '../types';

const BADGE: Record<WorktreeGroup, string> = {
  needs: 'PERMISSION',
  review: 'REVIEW',
  working: 'WORKING',
  idle: 'IDLE',
  missing: 'MISSING',
};

/** The counters, in the order they read: most urgent first. Missing has no counter; it is not a state of work. */
const COUNTERS: WorktreeGroup[] = ['needs', 'review', 'working', 'idle'];

/** The shortcut for the next-in-queue command, as the platform writes it. */
const NEXT_HINT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥⌘J' : 'Ctrl+Alt+J';

/** What an empty filter says, in the words of the counter that produced it. */
const NONE: Record<WorktreeGroup, string> = {
  needs: 'Nothing needs you right now',
  review: 'Nothing is ready for review',
  working: 'No agent is working',
  idle: 'Nothing is idle',
  missing: 'No worktree is missing',
};

type Filter = WorktreeGroup | 'all';

export function Mission({ state, loaded, items, selectedId, select, dragFor, now }: LayoutProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const counts = countByGroup(items);
  const queue = attentionQueue(items);
  const cards = items.filter((d) => filter === 'all' || d.group === filter);

  const jumpTo = (d: Described) => {
    setFilter('all');
    select(d.wt.id);
    // The card may be far down the list; bring it into view once it has rendered.
    requestAnimationFrame(() => document.getElementById(`fm-wt-${d.wt.id}`)?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <div className="fm fm-mission">
      {loaded && items.length > 0 && (
        <div className="ms-stats" role="group" aria-label="Filter by state">
          {COUNTERS.map((group) => {
            const on = filter === group;
            return (
              <button
                key={group}
                type="button"
                className="ms-stat"
                data-group={group}
                aria-pressed={on}
                onClick={() => setFilter(on ? 'all' : group)}
              >
                <span className="ms-stat-n">{counts[group]}</span>
                <span className="ms-stat-label">{GROUP_SHORT[group]}</span>
              </button>
            );
          })}
        </div>
      )}

      {loaded && queue.length > 0 && (
        <section className="ms-queue" aria-label="Attention">
          <div className="ms-queue-head">
            <h2 className="ms-queue-title">Attention · {queue.length}</h2>
            <span className="ms-queue-hint" title="Jump to the next worktree waiting on you">{NEXT_HINT} next</span>
          </div>
          <ul>
            {queue.map((d) => (
              <li key={d.wt.id}>
                <button type="button" className="ms-q" onClick={() => jumpTo(d)}>
                  <span className="ms-badge" data-group={d.group}>{BADGE[d.group]}</span>
                  <span className="ms-q-text">
                    <span className="ms-q-name fm-ellipsis">{d.name}</span>
                    <span className="ms-q-why fm-ellipsis">{whyWaiting(d)}</span>
                  </span>
                  <span className="ms-when">{formatAge(d.wt.since, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="ms-cards">
        {!loaded ? <LoadingState /> : items.length === 0 ? <EmptyState /> : cards.length === 0 ? (
          <NothingHere text={NONE[filter as WorktreeGroup]} onClear={() => setFilter('all')} />
        ) : cards.map((d) => (
          <Card key={d.wt.id} d={d} selected={d.wt.id === selectedId} now={now} state={state} select={select} drag={dragFor(d.wt)} />
        ))}
      </div>

      {loaded && items.length > 0 && <HealthStrip items={items} state={state} />}
    </div>
  );
}

/** Why a worktree is in the queue, in the words the agent used when it has them. */
function whyWaiting(d: Described): string {
  if (d.group === 'needs') return d.attention?.command ? `Run ${d.attention.command}?` : d.attention?.text ?? d.line;
  const pr = d.pr ? ` · PR #${d.pr.number}` : '';
  return `Agent finished${pr}`;
}

function Card({ d, selected, now, state, select, drag }: {
  d: Described;
  selected: boolean;
  now: number;
  state: LayoutProps['state'];
  select: LayoutProps['select'];
  drag: ReturnType<LayoutProps['dragFor']>;
}) {
  const wt = d.wt;
  const pick = () => select(wt.id);
  const showMeta = d.group !== 'missing' && d.group !== 'idle';

  return (
    <article
      id={`fm-wt-${wt.id}`}
      className={`ms-card fm-drag${wt.deleting ? ' fm-deleting' : ''}`}
      data-group={d.group}
      data-selected={selected || undefined}
      data-dragging={drag.dragging || undefined}
      data-over={drag.over || undefined}
      {...drag.props}
    >
      <button type="button" className="ms-card-main" aria-current={selected || undefined} onClick={pick}>
        <span className="ms-card-top">
          <span className="ms-badge" data-group={d.group}>{BADGE[d.group]}</span>
          <span className="ms-name fm-ellipsis" title={wt.branch}>{d.name}</span>
          <span className="ms-when">{formatAge(wt.since, now)}</span>
        </span>
        <span className="ms-card-line">
          <span className="ms-provider">{d.agent ? visualFor(d.provider).label : wt.isMain ? 'main' : '—'}</span>
          <span className="fm-ellipsis">{d.line}</span>
        </span>
        {showMeta && (
          <span className="ms-meta">
            <span><span className="ms-k">diff</span>{d.diff ? <DiffStat diff={d.diff} /> : <span className="ms-v" data-tone="muted">—</span>}</span>
            <span><span className="ms-k">base</span><span className="ms-v fm-ellipsis" data-tone={d.base.tone}>{shortBase(d)}</span></span>
            <span><span className="ms-k">pr</span>{d.pr ? <PrBadge pr={d.pr} /> : <span className="ms-v" data-tone="muted">—</span>}</span>
            <span><span className="ms-k">stack</span><span className="ms-v fm-ellipsis" data-tone={d.stack.tone} title={d.stack.title}>{d.stack.text}{d.ports[0] ? ` :${d.ports[0].port}` : ''}</span></span>
          </span>
        )}
      </button>

      {wt.dockerError && !selected && <div className="fm-row-error ms-pad" title={wt.dockerError}>Stack: {wt.dockerError}</div>}

      {d.group === 'missing' && (
        <div className="ms-actions">
          <button type="button" className="fm-btn" title="Drop this entry. Nothing on disk is touched." onClick={() => send({ type: 'forgetWorktree', worktreeId: wt.id })}>
            Forget
          </button>
        </div>
      )}

      {selected && d.group !== 'missing' && (
        <div className="ms-expand">
          <SessionList wt={wt} variant="mission" onSelect={pick} />
          <Details d={d} dockerEnabled={state.dockerEnabled} />
          <div className="ms-actions">
            <Primary d={d} state={state} select={pick} />
            {/* The contextual button above may already be the launcher. */}
            {d.group !== 'working' && d.group !== 'idle' && (
              <LaunchSplit wt={wt} defaultProvider={state.defaultProvider} installedProviders={state.installedProviders} />
            )}
            <ActionBar wt={wt} dockerEnabled={state.dockerEnabled} className="ms-actionbar" />
          </div>
        </div>
      )}
    </article>
  );
}

/** Drift in a few characters: the card has a grid cell for it, the details block has the sentence. */
function shortBase(d: Described): string {
  const base = d.wt.git.base;
  if (!base) return '—';
  return base.behind > 0 ? `↓${base.behind}` : 'ok';
}

/** The one button the card leads with, chosen by what the worktree needs. */
function Primary({ d, state, select }: { d: Described; state: LayoutProps['state']; select: () => void }) {
  switch (d.group) {
    case 'needs':
      return <button type="button" className="fm-btn fm-btn-icon fm-btn-needs" aria-label="Answer the agent" title="Answer the agent" onClick={() => openAsking(d, select)}><i className="codicon codicon-comment-discussion" aria-hidden="true" /></button>;
    case 'review':
      return <button type="button" className="fm-btn fm-btn-icon fm-btn-ok" aria-label="Review diff" title="Review diff & comment" onClick={() => send({ type: 'openDiff', worktreeId: d.wt.id })}><i className="codicon codicon-git-compare" aria-hidden="true" /></button>;
    default:
      return (
        <LaunchSplit
          wt={d.wt}
          defaultProvider={state.defaultProvider}
          installedProviders={state.installedProviders}
          tone="solid"
        />
      );
  }
}
