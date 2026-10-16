import React from 'react';
import { send } from '../vscode';
import { sessionToOpen, type Described } from '../derive';

/** Brings up the session that is asking (or the worktree's terminal when none is). */
export function openAsking(d: Described, select: () => void): void {
  select();
  const session = sessionToOpen(d.wt);
  if (session) send({ type: 'focusSession', worktreeId: d.wt.id, kind: session.kind, index: session.index });
  else send({ type: 'focusTerminal', worktreeId: d.wt.id });
}

/** The worktree's folder is gone; the only honest options are to forget it or to bring the folder back. */
export function ForgetActions({ d }: { d: Described }) {
  return (
    <div className="fm-row-actions">
      <button
        type="button"
        className="fm-btn fm-btn-icon"
        aria-label="Forget this worktree"
        title="Forget — drop this entry. Nothing on disk is touched."
        onClick={() => send({ type: 'forgetWorktree', worktreeId: d.wt.id })}
      >
        <i className="codicon codicon-close" aria-hidden="true" />
      </button>
    </div>
  );
}
