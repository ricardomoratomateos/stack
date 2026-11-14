import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { WorktreeItem } from '@core/webview/types';
import { nameOf } from '@core/webview/derive';
import type { StackdApi } from '../stackd/api';
import { openTask, stackdBackend, type ChangedFile } from './api';
import './code.css';

// Monaco is several MB: it is fetched the first time a Code tab opens, never with the app.
const CodeBrowser = lazy(() => import('./CodeBrowser').then((m) => ({ default: m.CodeBrowser })));

/** Where the Code tab should be looking (a file and line clicked in the Review). */
export interface CodeTarget { path?: string; line?: number; /** Open Find in Path (⌘F / ⇧⌘F from outside the tab). */ search?: boolean; tick: number }

/**
 * A task's worktree, to read: what the task changed, its files, and navigation through stackd.
 * Fills the centre like the Review; Esc goes back to the terminal.
 */
export function CodeHost({ worktree, api, target, hidden, onClose }: {
  worktree: WorktreeItem;
  api: StackdApi;
  target?: CodeTarget;
  /** Another tab of this task is in front: stay mounted (the editor keeps its place) but out of sight. */
  hidden?: boolean;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const backend = useMemo(() => stackdBackend(api, worktree.id), [api, worktree.id]);
  const [info, setInfo] = useState<{ root: string; changed: ChangedFile[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setInfo(null);
    setError('');
    openTask(api, worktree.id)
      .then((i) => { if (live) setInfo(i); })
      .catch((e) => { if (live) setError(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, [api, worktree.id]);

  // Esc goes back to the terminal, unless the editor is using it: a peek, the find box, quick open.
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      const host = hostRef.current;
      if (!host || host.querySelector('.code-palette, .peekview-widget, .find-widget.visible, .monaco-hover:not(.hidden), .context-view.monaco-menu-container')) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    // Capture: asked before Monaco handles the key, while its widgets are still on screen.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hidden, onClose]);

  return (
    <div className="code-host" ref={hostRef} hidden={hidden} aria-label={`Code of ${nameOf(worktree)}`}>
      {error ? <div className="placeholder"><p>{error}</p></div>
        : !info ? <div className="placeholder">Opening the code…</div>
        : (
          <Suspense fallback={<div className="placeholder">Loading the editor…</div>}>
            <CodeBrowser backend={backend} root={info.root} changed={info.changed} target={target} />
          </Suspense>
        )}
    </div>
  );
}
