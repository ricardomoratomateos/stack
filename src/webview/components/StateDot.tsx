import React from 'react';
import { T } from '../tokens';
import type { AgentState } from '../types';

const DOT_COLOR: Record<AgentState, string> = {
  active:     T.purple,
  waiting:    T.green,
  permission: T.amber,
  idle:       T.textMuted,
  terminated: T.red,
};

interface Props { state: AgentState; size?: number }

export function StateDot({ state, size = 7 }: Props) {
  const cls = state === 'active' ? 'u-dot-active' : state === 'permission' ? 'u-dot-perm' : '';
  return (
    <span
      className={cls}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: (DOT_COLOR[state] ?? DOT_COLOR.idle),
        flexShrink: 0,
      }}
    />
  );
}

export function ThinkingDots() {
  const s: React.CSSProperties = {
    display: 'inline-block',
    width: 4,
    height: 4,
    borderRadius: '50%',
    background: T.purple,
  };
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      <span className="u-dot-1" style={s} />
      <span className="u-dot-2" style={s} />
      <span className="u-dot-3" style={s} />
    </span>
  );
}
