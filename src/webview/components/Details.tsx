import React from 'react';
import { send } from '../vscode';
import type { Described } from '../derive';
import type { TicketItem } from '../types';

function changesText(d: Described): string {
  const g = d.wt.git;
  const parts = [
    g.staged > 0 ? `${g.staged} staged` : '',
    g.unstaged > 0 ? `${g.unstaged} unstaged` : '',
    g.untracked > 0 ? `${g.untracked} untracked` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'clean';
}

/** The selected worktree's local changes. The sidebar shows this for the selected worktree. */
export function Details({ d }: { d: Described }) {
  return (
    <dl className="fm-det" aria-label={`Details of ${d.name}`}>
      <dt>Changes</dt>
      <dd>
        <span data-tone={d.wt.git.hasChanges ? 'plain' : 'muted'}>{changesText(d)}</span>
      </dd>
    </dl>
  );
}

/**
 * The tracker ticket a worktree was created for, as a small chip beside its
 * name — "AS-1234" — that opens the ticket. A span, not a button: the
 * layout draws the name inside the row's own button.
 */
export function TicketChip({ worktreeId, ticket }: { worktreeId: string; ticket: TicketItem }) {
  const title = `${ticket.key}${ticket.title ? ` — ${ticket.title}` : ''} (${ticket.source})${ticket.url ? ' — open' : ''}`;
  const open = (e: React.MouseEvent) => {
    if (!ticket.url) return;
    e.stopPropagation();
    send({ type: 'openTicket', worktreeId });
  };
  return <span className="fm-ticket" data-link={ticket.url ? '' : undefined} title={title} onClick={open}>{ticket.key}</span>;
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
