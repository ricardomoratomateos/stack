import React from 'react';
import { GROUP_LABEL, sessionGroup, type WorktreeGroup } from '../derive';
import type { AgentState } from '../types';

const STATE_WORD: Record<AgentState, string> = {
  active: 'Working',
  waiting: 'Waiting',
  permission: 'Needs you',
  idle: 'Idle',
  terminated: 'Ended',
};

/**
 * The state indicator, drawn once: the worktree card's square (filled for live
 * states, hollow for idle, dashed for missing). Give it a worktree `group` or a
 * session `state`; the colour comes from the group, so every place that shows a
 * state looks the same. Its palette is its own, so it reads the same inside the
 * sidebar and in the desktop chrome.
 */
export function StatusDot({ group, state, size = 'md', title, className }: {
  group?: WorktreeGroup;
  state?: AgentState;
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
}) {
  const g: WorktreeGroup = group ?? (state ? sessionGroup(state) : 'idle');
  const label = state ? STATE_WORD[state] : GROUP_LABEL[g];
  return <span className={className ? `fm-dot ${className}` : 'fm-dot'} data-group={g} data-size={size} role="img" aria-label={label} title={title} />;
}
