import React from 'react';
import { send } from '../vscode';
import type { Described } from '../derive';

export function LoadingState() {
  return (
    <div className="fm-empty" role="status" aria-label="Loading tasks">
      <span className="u-dot-1 fm-loading-dot" />
      <span className="u-dot-2 fm-loading-dot" />
      <span className="u-dot-3 fm-loading-dot" />
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="fm-empty">
      <span className="fm-empty-text">No tasks yet</span>
      <button type="button" className="fm-btn" onClick={() => send({ type: 'openNewTask' })}>
        + New task
      </button>
    </div>
  );
}

/** Shown when a filter hides everything, so an empty list is never a mystery. */
export function NothingHere({ text, onClear }: { text: string; onClear: () => void }) {
  return (
    <div className="fm-empty">
      <span className="fm-empty-text">{text}</span>
      <button type="button" className="fm-btn" onClick={onClear}>Show all</button>
    </div>
  );
}

/**
 * The strip along the bottom: how many agents are live and how many worktrees
 * have a tmux session.
 */
export function HealthStrip({ items }: { items: Described[] }) {
  const agents = items.reduce((n, d) => n + d.wt.sessions.filter((s) => s.kind === 'agent' && s.state !== 'terminated').length, 0);
  const asking = items.filter((d) => d.group === 'needs').length;
  const tmux = items.filter((d) => d.wt.sessions.length > 0).length;

  return (
    <footer className="fm-health" aria-label="Health">
      <span title={`${agents} live agent session${agents === 1 ? '' : 's'}`}>
        <i className="fm-health-dot" data-tone={asking > 0 ? 'warn' : 'ok'} aria-hidden="true" />agents {agents}
      </span>
      <span title={`${tmux} task${tmux === 1 ? '' : 's'} with a tmux session`}>
        <i className="fm-health-dot" data-tone="ok" aria-hidden="true" />tmux {tmux}
      </span>
    </footer>
  );
}
