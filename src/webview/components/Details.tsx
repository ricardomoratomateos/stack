import React, { useState } from 'react';
import { send } from '../vscode';
import type { Described, DescribedPr } from '../derive';
import type { DockerContainer } from '../types';
import { stackRunning } from './ActionBar';

/** The gist of a container for one line: its service (or a trimmed name) and what it is doing. */
function containerLine(c: DockerContainer): { name: string; status: string; tone: 'ok' | 'bad' | 'muted' } {
  // strip common prefix noise like "my-app-" and "-1"
  const name = c.service ?? c.name.replace(/^[\w-]+-app-/, '').replace(/-\d+$/, '');
  const crashed = c.state === 'exited' && (c.exitCode ?? 0) !== 0;
  return {
    name,
    status: crashed ? `exited (${c.exitCode})` : c.state,
    tone: c.state === 'running' ? 'ok' : crashed ? 'bad' : 'muted',
  };
}

function changesText(d: Described): string {
  const g = d.wt.git;
  const parts = [
    g.staged > 0 ? `${g.staged} staged` : '',
    g.unstaged > 0 ? `${g.unstaged} unstaged` : '',
    g.untracked > 0 ? `${g.untracked} untracked` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'clean';
}

/**
 * What the selected worktree is sitting on: drift against its base, local
 * changes, the docker stack (with its start/stop and every container), the
 * ports it owns and its PR. Every layout shows this for the selected worktree,
 * so none of it depends on which look is chosen.
 */
export function Details({ d, dockerEnabled }: { d: Described; dockerEnabled?: boolean }) {
  const [showStack, setShowStack] = useState(false);
  const wt = d.wt;
  const running = stackRunning(wt);
  const hasStack = wt.docker.length > 0;

  return (
    <dl className="fm-det" aria-label={`Details of ${d.name}`}>
      <dt>Base</dt>
      <dd>
        {wt.git.base ? (
          <button
            type="button"
            className="fm-link"
            data-tone={d.base.tone}
            title={d.base.title}
            onClick={() => send({ type: 'refreshDrift', worktreeId: wt.id })}
          >
            {d.base.text}
          </button>
        ) : (
          <span data-tone="muted">{d.base.text}</span>
        )}
      </dd>

      <dt>Changes</dt>
      <dd>
        <span data-tone={wt.git.hasChanges ? 'plain' : 'muted'}>{changesText(d)}</span>
        {wt.git.ahead > 0 && <span className="fm-chip-text" data-tone="ok" title="Commits not pushed yet">↑{wt.git.ahead}</span>}
        {wt.git.behind > 0 && <span className="fm-chip-text" data-tone="bad" title="Commits upstream you do not have">↓{wt.git.behind}</span>}
      </dd>

      {(dockerEnabled || hasStack || wt.dockerError || d.stack.text !== '—') && (
        <>
          <dt>Stack</dt>
          <dd>
            <button
              type="button"
              className="fm-link"
              data-tone={d.stack.tone}
              title={d.stack.title}
              aria-expanded={hasStack ? showStack : undefined}
              disabled={!hasStack}
              onClick={() => setShowStack((v) => !v)}
            >
              {hasStack && <i className={`codicon codicon-chevron-${showStack ? 'down' : 'right'}`} aria-hidden="true" />}
              {d.stack.text}
            </button>
            {dockerEnabled && (
              <button
                type="button"
                className="fm-mini"
                disabled={!!wt.dockerBusy}
                aria-label={running ? 'Stop containers' : 'Start containers'}
                title={wt.dockerBusy ? `Docker is ${wt.dockerBusy === 'starting' ? 'starting' : 'stopping'} the stack` : running ? 'Stop containers' : 'Start containers'}
                onClick={() => send({ type: running ? 'dockerDown' : 'dockerUp', worktreeId: wt.id })}
              >
                <i className={`codicon codicon-${wt.dockerBusy ? 'loading codicon-modifier-spin' : running ? 'debug-stop' : 'play'}`} aria-hidden="true" />
              </button>
            )}
          </dd>
        </>
      )}

      {showStack && hasStack && (
        <dd className="fm-det-wide">
          <ul className="fm-containers" aria-label="Containers">
            {wt.docker.map((c) => {
              const line = containerLine(c);
              return (
                <li key={c.name} data-tone={line.tone} title={c.status ?? c.name}>
                  <span className="fm-container-dot" aria-hidden="true" />
                  <span className="fm-container-name">{line.name}</span>
                  <span className="fm-container-state">{line.status}</span>
                </li>
              );
            })}
          </ul>
        </dd>
      )}

      {wt.dockerError && (
        <dd className="fm-det-wide fm-error" role="alert">{wt.dockerError}</dd>
      )}

      {d.ports.length > 0 && (
        <>
          <dt>Ports</dt>
          <dd className="fm-ports">
            {d.ports.map((p) => p.openable ? (
              <button
                key={p.label}
                type="button"
                className="fm-port"
                title={`Open http://localhost:${p.port}`}
                onClick={() => send({ type: 'openPort', port: p.port })}
              >
                <span className="fm-port-label">{p.label}</span> :{p.port}
              </button>
            ) : (
              // The debug port: a debugger listener answers nothing a browser can
              // render, so there is no click to offer.
              <span key={p.label} className="fm-port" data-static title="Debug port">
                <span className="fm-port-label">{p.label}</span> :{p.port}
              </span>
            ))}
          </dd>
        </>
      )}

      {d.pr && (
        <>
          <dt>PR</dt>
          <dd><PrBadge worktreeId={wt.id} pr={d.pr} /></dd>
        </>
      )}
    </dl>
  );
}

const CI_TEXT: Record<NonNullable<DescribedPr['ci']>, string> = {
  pass: 'checks passed',
  fail: 'checks failed',
  pending: 'checks running',
};

/**
 * The PR as one clickable token — "#42 open", with a dot for its checks and a
 * mark when a reviewer asked for changes — that opens it on GitHub.
 *
 * `inCard` is for a badge drawn inside a card's own button (mission's metadata
 * grid): a button cannot hold another, so it is a span that keeps the click to
 * itself. The keyboard reaches the same link through the details block.
 */
export function PrBadge({ worktreeId, pr, inCard }: { worktreeId: string; pr: DescribedPr; inCard?: boolean }) {
  const label = pr.draft ? 'draft' : pr.state;
  const title = [
    `Pull request #${pr.number} is ${label}`,
    ...(pr.ci ? [CI_TEXT[pr.ci]] : []),
    ...(pr.changesRequested ? ['changes requested'] : []),
  ].join(' · ') + ' — open on GitHub';
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    send({ type: 'openPr', worktreeId });
  };
  const body = (
    <>
      {pr.ci && <span className="fm-pr-ci" data-ci={pr.ci} aria-hidden="true" />}
      <span className="fm-pr-num">#{pr.number}</span>
      <span className="fm-pr-state">{label}</span>
      {pr.changesRequested && <i className="codicon codicon-request-changes fm-pr-mark" aria-hidden="true" />}
    </>
  );
  const attrs = { className: 'fm-pr', 'data-state': pr.state, 'data-draft': pr.draft || undefined, title, onClick: open };
  return inCard
    ? <span {...attrs}>{body}</span>
    : <button type="button" {...attrs} aria-label={title}>{body}</button>;
}

/** "+40 −9", or "~4 files" when git could not count lines. */
export function DiffStat({ diff }: { diff: Described['diff'] }) {
  if (!diff) return null;
  if ('files' in diff) {
    return <span className="fm-diff" data-files title={`${diff.files} changed file${diff.files === 1 ? '' : 's'}`}>~{diff.files}</span>;
  }
  return (
    <span className="fm-diff" title={`${diff.added} lines added, ${diff.removed} removed`}>
      <span className="fm-add">+{diff.added}</span>
      <span className="fm-del">−{diff.removed}</span>
    </span>
  );
}
