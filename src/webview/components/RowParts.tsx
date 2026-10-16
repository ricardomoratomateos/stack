import React from 'react';
import { send } from '../vscode';
import { sessionToOpen, type Described } from '../derive';
import { PrBadge } from './Details';

/** Brings up the session that is asking (or the worktree's terminal when none is). */
export function openAsking(d: Described, select: () => void): void {
  select();
  const session = sessionToOpen(d.wt);
  if (session) send({ type: 'focusSession', worktreeId: d.wt.id, kind: session.kind, index: session.index });
  else send({ type: 'focusTerminal', worktreeId: d.wt.id });
}

/**
 * What the agent asked, in a box under the row, with a way to go and answer.
 * There is deliberately no "Allow" here: approving a command from a sidebar,
 * without seeing the agent's context, is a decision for its terminal.
 */
export function AskBox({ d, select, openLabel = 'Open the session that is asking' }: { d: Described; select: () => void; openLabel?: string }) {
  const ask = d.attention;
  return (
    <div className="fm-ask">
      {(ask?.command ?? ask?.text) ? (
        <span className="fm-ask-text" title={ask?.command ?? ask?.text} data-command={ask?.command ? '' : undefined}>
          {ask?.command ? `$ ${ask.command}` : ask?.text}
        </span>
      ) : (
        <span className="fm-ask-text fm-ask-quiet">{d.line}</span>
      )}
      <div className="fm-ask-actions">
        <button type="button" className="fm-btn fm-btn-icon fm-btn-needs" aria-label={openLabel} title={openLabel} onClick={() => openAsking(d, select)}>
          <i className="codicon codicon-arrow-right" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Review diff, plus the PR when there is one. */
export function ReviewActions({ d, buttonClass }: { d: Described; buttonClass: string }) {
  return (
    <div className="fm-row-actions">
      <button type="button" className={`fm-btn fm-btn-icon ${buttonClass}`} aria-label="Review diff" title="Review diff & comment" onClick={() => send({ type: 'openDiff', worktreeId: d.wt.id })}>
        <i className="codicon codicon-git-compare" aria-hidden="true" />
      </button>
      {d.pr && <PrBadge pr={d.pr} />}
    </div>
  );
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
