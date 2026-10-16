import React, { useEffect, useRef } from 'react';
import type { SendDestination } from '../types';
import { Icon } from './ui';

interface Option { id: SendDestination; icon: string; title: string; hint: (live: boolean) => string; needsLive?: true }

const OPTIONS: Option[] = [
  { id: 'live', icon: 'terminal', title: 'Running agent', needsLive: true,
    hint: (live) => (live ? 'Paste into the live session in this worktree' : 'No agent is running in this worktree') },
  { id: 'new', icon: 'rocket', title: 'New agent', hint: () => 'Launch a fresh agent seeded with the comments' },
  { id: 'clipboard', icon: 'copy', title: 'Clipboard', hint: () => 'Copy the prompt and paste it yourself' },
];

export function SendDialog({ count, hasLiveAgent, onPick, onClose }: {
  count: number; hasLiveAgent: boolean; onPick(d: SendDestination): void; onClose(): void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const firstEnabled = OPTIONS.find((o) => !o.needsLive || hasLiveAgent)?.id;

  return (
    <div className="rv-backdrop" onClick={onClose}>
      <div className="rv-dialog" role="dialog" aria-modal="true" aria-label="Send comments" onClick={(e) => e.stopPropagation()}>
        <h2>Send {count} comment{count === 1 ? '' : 's'} to…</h2>
        {OPTIONS.map((o) => {
          const disabled = o.needsLive === true && !hasLiveAgent;
          return (
            <button
              key={o.id}
              ref={o.id === firstEnabled ? first : undefined}
              className="rv-opt"
              disabled={disabled}
              onClick={() => onPick(o.id)}
            >
              <Icon name={o.icon} />
              <span className="rv-opt-text">
                <strong>{o.title}</strong>
                <span>{o.hint(hasLiveAgent)}</span>
              </span>
            </button>
          );
        })}
        <button className="rv-btn rv-dialog-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
