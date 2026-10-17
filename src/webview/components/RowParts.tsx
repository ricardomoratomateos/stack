import React, { useEffect, useState } from 'react';
import { send } from '../vscode';
import { formatElapsed, sessionToOpen, type Described } from '../derive';

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

/** The row's one-line summary, with the setup's running clock beside "Preparing…". */
export function RowLine({ d }: { d: Described }) {
  const setup = d.wt.setup;
  if (setup?.state === 'failed') return <span data-tone="bad">{d.line}</span>;
  return (
    <>
      {d.line}
      {setup?.state === 'running' && <> <Elapsed since={setup.startedAt} /></>}
    </>
  );
}

/** Seconds since `since`, re-rendered every second while it is on screen. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="fm-elapsed">{formatElapsed(now - since)}</span>;
}

/**
 * What can be done about the setup script: its log while it runs, and after a
 * failure a retry and either "launch anyway" (an agent was waiting for it) or
 * dismiss. Icons, each with its tooltip, so the row stays one row.
 */
export function SetupActions({ d }: { d: Described }) {
  const setup = d.wt.setup;
  if (!setup) return null;
  const act = (action: 'log' | 'retry' | 'launch' | 'dismiss') => send({ type: 'setupAction', worktreeId: d.wt.id, action });
  const failed = setup.state === 'failed';
  return (
    <div className="fm-row-actions" role="group" aria-label="Setup script">
      <SetupButton icon="output" label="Show the setup log" onClick={() => act('log')} />
      {failed && <SetupButton icon="refresh" label="Retry the setup script" onClick={() => act('retry')} />}
      {failed && setup.held && <SetupButton icon="play" label="Launch the agent anyway" onClick={() => act('launch')} />}
      {failed && !setup.held && <SetupButton icon="close" label="Dismiss — leave it as it is" onClick={() => act('dismiss')} />}
    </div>
  );
}

function SetupButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className="fm-btn fm-btn-icon" aria-label={label} title={label} onClick={onClick}>
      <i className={`codicon codicon-${icon}`} aria-hidden="true" />
    </button>
  );
}
