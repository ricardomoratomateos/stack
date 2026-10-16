import React from 'react';
import { send } from '../vscode';
import type { WorktreeItem } from '../types';
import { MenuItem, MenuPanel, MenuSeparator, useDropdown } from './Menu';

/**
 * Whether the stack is up, for the one start/stop control. Any running
 * container counts: a half-up stack is stopped, not started again.
 */
export const stackRunning = (wt: WorktreeItem) => wt.docker.some((c) => c.state === 'running');

/** The rarely-needed actions, behind a "⋯" so the row keeps only the frequent ones. */
export function MoreMenu({ wt, dockerEnabled }: { wt: WorktreeItem; dockerEnabled?: boolean }) {
  const menu = useDropdown();
  const run = (action: () => void) => () => { menu.close(); action(); };
  const running = stackRunning(wt);

  return (
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
          {!wt.isMain && (
            <MenuItem title="Run the setup script again" onClick={run(() => send({ type: 'initWorktree', worktreeId: wt.id }))}>
              <i className="codicon codicon-zap" aria-hidden="true" /><span className="fm-menu-label">Run setup script</span>
            </MenuItem>
          )}
          {dockerEnabled && (
            <MenuItem
              disabled={!!wt.dockerBusy}
              onClick={run(() => send({ type: running ? 'dockerDown' : 'dockerUp', worktreeId: wt.id }))}
            >
              <i className={`codicon codicon-${running ? 'debug-stop' : 'play'}`} aria-hidden="true" />
              <span className="fm-menu-label">{running ? 'Stop containers' : 'Start containers'}</span>
            </MenuItem>
          )}
          {wt.git.base && (
            <MenuItem title="Fetch the base branch and check again" onClick={run(() => send({ type: 'refreshDrift', worktreeId: wt.id }))}>
              <i className="codicon codicon-refresh" aria-hidden="true" /><span className="fm-menu-label">Check base drift</span>
            </MenuItem>
          )}
          <MenuItem onClick={run(() => send({ type: 'renameWorktree', worktreeId: wt.id }))}>
            <i className="codicon codicon-edit" aria-hidden="true" /><span className="fm-menu-label">Rename / set title</span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={run(() => send({ type: 'deleteWorktree', worktreeId: wt.id }))}>
            <i className="codicon codicon-trash" aria-hidden="true" /><span className="fm-menu-label">Delete worktree</span>
          </MenuItem>
        </MenuPanel>
      )}
    </div>
  );
}
