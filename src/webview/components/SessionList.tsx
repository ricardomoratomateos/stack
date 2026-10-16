import React, { useState } from 'react';
import { send } from '../vscode';
import type { AgentState, SessionItem, WorktreeItem } from '../types';
import { ProviderMark } from './providers';

export type SessionVariant = 'claude' | 'mission' | 'aside';

const STATE_LABEL: Record<AgentState, string> = {
  active: 'working',
  waiting: 'waiting',
  permission: 'needs you',
  idle: 'idle',
  terminated: 'ended',
};

/** What the marker in front of a session looks like, per layout. */
function Mark({ session, variant }: { session: SessionItem; variant: SessionVariant }) {
  if (variant !== 'claude') return <span className="fm-sess-dot" aria-hidden="true" />;
  return session.kind === 'agent'
    ? <ProviderMark provider={session.provider} size={13} />
    : <span className="fm-sess-prompt" aria-hidden="true">&gt;_</span>;
}

/**
 * A worktree's sessions: click one to bring its tmux window up, drag to
 * reorder, and rename or kill from the buttons that appear on hover or keyboard
 * focus. One implementation for all three layouts; only the marker differs.
 */
export function SessionList({ wt, variant, onSelect }: { wt: WorktreeItem; variant: SessionVariant; onSelect: () => void }) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  if (wt.sessions.length === 0) return null;

  // Move window `from` to the slot occupied by window `to`, and persist the
  // resulting order of tmux window indexes.
  const commitReorder = (from: number, to: number) => {
    const indexes = wt.sessions.map((s) => s.index);
    const fromPos = indexes.indexOf(from);
    const toPos = indexes.indexOf(to);
    if (fromPos === -1 || toPos === -1 || fromPos === toPos) return;
    const next = [...indexes];
    next.splice(toPos, 0, next.splice(fromPos, 1)[0]);
    send({ type: 'reorderSessions', worktreeId: wt.id, orderedIndexes: next });
  };
  const end = () => { setDragIndex(null); setOverIndex(null); };

  return (
    <ul className="fm-sessions" aria-label="Sessions">
      {wt.sessions.map((s) => {
        const name = s.alias ?? s.name;
        const isAgent = s.kind === 'agent';
        return (
          <li
            key={`${s.kind}-${s.index}`}
            className="fm-sess"
            data-state={isAgent ? s.state : 'shell'}
            data-dragging={dragIndex === s.index || undefined}
            data-over={(overIndex === s.index && dragIndex !== null && dragIndex !== s.index) || undefined}
            draggable
            // These stop propagation: the worktree row around them is draggable too.
            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; setDragIndex(s.index); }}
            onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setOverIndex(s.index); }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dragIndex !== null) commitReorder(dragIndex, s.index);
              end();
            }}
            onDragEnd={(e) => { e.stopPropagation(); end(); }}
          >
            <button
              type="button"
              className="fm-sess-main"
              title={`Open ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelect();
                send({ type: 'focusSession', worktreeId: wt.id, kind: s.kind, index: s.index });
              }}
            >
              <span className="fm-sess-mark"><Mark session={s} variant={variant} /></span>
              <span className="fm-sess-text">
                <span className="fm-sess-name">{name}</span>
                {s.title && <span className="fm-sess-sub" title={s.title}>{s.title}</span>}
              </span>
              {isAgent && <span className="fm-sess-state">{STATE_LABEL[s.state]}</span>}
            </button>
            <span className="fm-sess-actions">
              <button
                type="button"
                aria-label={`Rename ${name}`}
                title="Rename session"
                onClick={(e) => { e.stopPropagation(); send({ type: 'renameSession', worktreeId: wt.id, index: s.index }); }}
              >
                <i className="codicon codicon-edit" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Kill ${name}`}
                title="Kill session"
                onClick={(e) => { e.stopPropagation(); send({ type: 'killSession', worktreeId: wt.id, index: s.index }); }}
              >
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
