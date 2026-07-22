import React from 'react';
import { T } from '../tokens';
import { StateDot, ThinkingDots } from './StateDot';
import { send } from '../vscode';
import type { WorktreeItem } from '../types';

interface Props {
  worktrees: WorktreeItem[];
  onSelect: (id: string) => void;
}

export function Overview({ worktrees, onSelect }: Props) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
      gap: 10,
      padding: 12,
      overflowY: 'auto',
      flex: 1,
    }}>
      {worktrees.map(wt => (
        <OvCard key={wt.id} wt={wt} onSelect={() => onSelect(wt.id)} />
      ))}
    </div>
  );
}

function OvCard({ wt, onSelect }: { wt: WorktreeItem; onSelect: () => void }) {
  const hasPerm = wt.agent === 'permission';

  const gitMeta: string[] = [];
  if (wt.git.hasChanges) gitMeta.push(`~${wt.git.unstaged + wt.git.staged}`);
  if (wt.git.ahead > 0) gitMeta.push(`↑${wt.git.ahead}`);

  return (
    <div
      onClick={onSelect}
      style={{
        borderRadius: 8,
        border: `1px solid ${hasPerm ? `color-mix(in srgb, ${T.amber} 40%, transparent)` : T.border}`,
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'border-color .15s, transform .15s',
        background: hasPerm ? `color-mix(in srgb, ${T.amber} 3%, transparent)` : T.surface,
        animation: 'unmess-fadein .2s ease',
      }}
    >
      {/* Head */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '9px 11px',
        background: T.surface2,
        borderBottom: `1px solid ${T.borderLight}`,
      }}>
        {wt.agent === 'active'
          ? <ThinkingDots />
          : <StateDot state={wt.agent} size={8} />}
        <span style={{
          fontWeight: 500, fontSize: 11, color: T.textStrong,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {wt.alias ?? wt.branch}
        </span>
      </div>

      {/* Ghost lines */}
      <div style={{ padding: '8px 11px', height: 56, overflow: 'hidden', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(to bottom, transparent 40%, ${wt.agent === 'permission' ? `color-mix(in srgb, ${T.amber} 3%, transparent)` : T.surface})`, zIndex: 1 }} />
        {[85, 62, 78, 45].map((w, i) => (
          <div key={i} style={{ height: 7, borderRadius: 2, marginBottom: 5, background: T.surface3, width: `${w}%`, opacity: 0.7 }} />
        ))}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 11px',
        borderTop: `1px solid ${T.borderLight}`,
        fontFamily: T.mono, fontSize: 10,
      }}>
        <StateBadge state={wt.agent} />
        <span style={{ flex: 1 }} />
        {gitMeta.length > 0 && (
          <span style={{ color: T.textMuted }}>{gitMeta.join(' ')}</span>
        )}
        {wt.pr && (
          <span style={{ color: T.blue }}>#{wt.pr.number}</span>
        )}
        {hasPerm && (
          <button
            onClick={(e) => { e.stopPropagation(); send({ type: 'focusTerminal', worktreeId: wt.id }); }}
            style={{
              padding: '2px 6px', borderRadius: 3, border: 'none',
              background: T.amber, color: '#000', fontSize: 9, fontFamily: T.mono,
            }}
          >
            View
          </button>
        )}
        {wt.agent === 'idle' && (
          <button
            onClick={(e) => { e.stopPropagation(); send({ type: 'launchAgent', worktreeId: wt.id }); }}
            style={{
              padding: '2px 6px', borderRadius: 3,
              border: `1px solid ${T.border}`, background: 'transparent',
              color: T.textDim, fontSize: 9, fontFamily: T.mono,
            }}
          >
            Launch
          </button>
        )}
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, [string, string]> = {
    active:     [T.purpleBg, T.purple],
    waiting:    [T.greenBg,  T.green],
    permission: [T.amberBg,  T.amber],
    terminated: [T.redBg,    T.red],
    idle:       [T.surface3, T.textDim],
  };
  const [bg, fg] = colors[state] ?? [T.surface3, T.textDim];
  return (
    <span style={{
      padding: '1px 6px', borderRadius: 3,
      background: bg, color: fg,
      fontSize: 9, fontFamily: T.mono,
    }}>
      {state}
    </span>
  );
}
