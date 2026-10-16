import React, { useLayoutEffect, useRef, useState } from 'react';
import { send } from '../vscode';
import type { WorktreeItem } from '../types';
import { MenuItem, MenuPanel, MenuSeparator, useDropdown } from './Menu';

/**
 * Whether the stack is up, for the one start/stop control. Any running
 * container counts: a half-up stack is stopped, not started again.
 */
export const stackRunning = (wt: WorktreeItem) => wt.docker.some((c) => c.state === 'running');

interface Action {
  id: string;
  icon: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** Every worktree action, most used first: the end of the list is what overflows first. */
export function worktreeActions(wt: WorktreeItem, dockerEnabled?: boolean): Action[] {
  const running = stackRunning(wt);
  const actions: Action[] = [
    { id: 'terminal', icon: 'terminal', label: 'Open terminal', run: () => send({ type: 'openTerminal', worktreeId: wt.id }) },
    { id: 'diff', icon: 'git-compare', label: 'Review diff & comment', run: () => send({ type: 'openDiff', worktreeId: wt.id }) },
  ];
  if (dockerEnabled) {
    actions.push({
      id: 'docker',
      icon: wt.dockerBusy ? 'loading codicon-modifier-spin' : running ? 'debug-stop' : 'play',
      label: wt.dockerBusy ? `Docker is ${wt.dockerBusy} the stack` : running ? 'Stop containers' : 'Start containers',
      disabled: !!wt.dockerBusy,
      run: () => send({ type: running ? 'dockerDown' : 'dockerUp', worktreeId: wt.id }),
    });
  }
  if (!wt.isMain) {
    actions.push({ id: 'setup', icon: 'zap', label: 'Run setup script', run: () => send({ type: 'initWorktree', worktreeId: wt.id }) });
  }
  if (wt.git.base) {
    actions.push({ id: 'drift', icon: 'refresh', label: 'Fetch the base branch and check drift', run: () => send({ type: 'refreshDrift', worktreeId: wt.id }) });
  }
  actions.push(
    { id: 'rename', icon: 'edit', label: 'Rename / set title', run: () => send({ type: 'renameWorktree', worktreeId: wt.id }) },
    { id: 'delete', icon: 'trash', label: 'Delete worktree', danger: true, run: () => send({ type: 'deleteWorktree', worktreeId: wt.id }) },
  );
  return actions;
}

/** Icon button width plus the row gap — keep in step with .fm-btn-icon and .fm-actionbar's gap. */
const SLOT = 28 + 4;

/**
 * How many actions are shown inline for a bar `width` px wide holding `count`:
 * all of them when they fit, otherwise as many as fit beside the "⋯" that
 * carries the rest. Before the bar has been measured (width undefined, e.g. the
 * first paint) everything is shown — the measurement corrects it a frame later.
 */
export function visibleCount(width: number | undefined, count: number): number {
  if (width === undefined || count * SLOT - 4 <= width) return count;
  return Math.max(0, Math.floor((width - 28) / SLOT));
}

/**
 * The worktree's actions as a row of icons, measured against the space it is
 * given: everything inline when it fits, and a "⋯" only for what does not —
 * not a menu by default that hides actions there was room for.
 */
export function ActionBar({ wt, dockerEnabled, className = '' }: { wt: WorktreeItem; dockerEnabled?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();
  const menu = useDropdown();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const actions = worktreeActions(wt, dockerEnabled);
  const shown = visibleCount(width, actions.length);
  const inline = actions.slice(0, shown);
  const overflow = actions.slice(shown);

  return (
    <div ref={ref} className={`fm-actionbar ${className}`}>
      {inline.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`fm-btn fm-btn-icon${a.danger ? ' fm-btn-danger' : ''}`}
          aria-label={a.label}
          title={a.label}
          disabled={a.disabled}
          onClick={(e) => { e.stopPropagation(); a.run(); }}
        >
          <i className={`codicon codicon-${a.icon}`} aria-hidden="true" />
        </button>
      ))}
      {overflow.length > 0 && (
        <div ref={menu.anchorRef} className="fm-more">
          <button
            type="button"
            className="fm-btn fm-btn-icon"
            aria-label="More actions"
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={(e) => { e.stopPropagation(); menu.toggle(); }}
          >
            <i className="codicon codicon-ellipsis" aria-hidden="true" />
          </button>
          {menu.open && (
            <MenuPanel anchorRef={menu.anchorRef} onClose={menu.close} up={menu.up} alignEnd label={`Actions for ${wt.alias ?? wt.branch}`}>
              {overflow.map((a) => (
                <React.Fragment key={a.id}>
                  {a.danger && overflow.length > 1 && <MenuSeparator />}
                  <MenuItem danger={a.danger} disabled={a.disabled} onClick={() => { menu.close(); a.run(); }}>
                    <i className={`codicon codicon-${a.icon}`} aria-hidden="true" /><span className="fm-menu-label">{a.label}</span>
                  </MenuItem>
                </React.Fragment>
              ))}
            </MenuPanel>
          )}
        </div>
      )}
    </div>
  );
}
