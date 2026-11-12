import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
// Must come first: the webview modules call acquireVsCodeApi() when they are evaluated.
import { loadWith, postToWebview, reviewShim } from '../sidebar/shim';
import '../sidebar/webviewStyles';
import { buildCommentPrompt } from '@core/diff/commentPrompt';
import type { DiffPanelExtMessage, DiffPanelMessage } from '@core/diff/types';
import type { WorktreeItem } from '@core/webview/types';
import { nameOf } from '@core/webview/derive';
import { liveAgentIndex } from '../model';
import type { StackdApi } from '../stackd/api';
import { reviewCss } from './css';

const STATE_KEY = (id: string) => `stack.review.${id}`;

function readState(id: string): unknown {
  try { const raw = localStorage.getItem(STATE_KEY(id)); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
}
function writeState(id: string, s: unknown): void {
  try { localStorage.setItem(STATE_KEY(id), JSON.stringify(s)); } catch { /* storage full or blocked: view prefs just don't persist */ }
}

const reason = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  const prefix = "couldn't compute the diff: ";
  return m.startsWith(prefix) ? m.slice(prefix.length) : m;
};

/**
 * The extension's PR-style review of one worktree (`DiffApp`), filling the centre. What `DiffPanelManager` +
 * `RemoteService` do for it in VS Code happens here: the diff and the comments go through stackd, the
 * clipboard destination is built and written locally, and `openFile` shows the place in the task's Code tab.
 * The panel and its stylesheet are loaded on first use.
 */
export function ReviewHost({ worktree, api, hidden, onClose, onSent, onNotice, onOpenFile }: {
  worktree: WorktreeItem;
  api: StackdApi;
  /** Esc in the review: back to the terminal. */
  onClose: () => void;
  /** The comments went to an agent: the session they went to (when known), to go and watch it. */
  onSent: (index: number | undefined, fellBack: boolean) => void;
  onNotice: (text: string) => void;
  /** A file header or a line was clicked: show it in the task's Code tab (path relative to the worktree). */
  onOpenFile: (path: string, line?: number) => void;
  /** The Code tab of this task is in front: stay mounted, out of sight, and leave Esc to it. */
  hidden?: boolean;
}) {
  const [Panel, setPanel] = useState<ComponentType | null>(null);
  const wtRef = useRef(worktree);
  wtRef.current = worktree;
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const hostRef = useRef<HTMLDivElement>(null);
  const id = worktree.id;

  const post = (msg: DiffPanelExtMessage) => postToWebview(msg);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [{ DiffApp }] = await Promise.all([
        loadWith(reviewShim, () => import('@core/diff/webview/DiffApp')),
      ]);
      if (!document.getElementById('stack-review-css')) {
        const el = document.createElement('style');
        el.id = 'stack-review-css';
        el.textContent = reviewCss();
        document.head.appendChild(el);
      }
      if (alive) setPanel(() => DiffApp);
    })();
    return () => { alive = false; };
  }, []);

  useLayoutEffect(() => {
    reviewShim.state = readState(id);
    reviewShim.onState = (s) => writeState(id, s);
    let live = true;
    const pushDiff = async (base: 'branch' | 'working'): Promise<void> => {
      let unified = '';
      let error: string | undefined;
      try {
        unified = (await api.command<{ unified: string }>('getDiff', { worktreeId: id, base })).unified;
      } catch (e) { error = reason(e); }
      if (!live) return;
      post({
        type: 'diff', base, unified, hasLiveAgent: wtRef.current.agentCount > 0, label: nameOf(wtRef.current),
        ...(error !== undefined ? { error } : {}),
      });
    };
    reviewShim.onMessage = (raw) => {
      const msg = raw as DiffPanelMessage;
      switch (msg.type) {
        case 'ready':
          void pushDiff('branch');
          break;
        case 'requestDiff':
          void pushDiff(msg.base);
          break;
        case 'send':
          void (async () => {
            let went: typeof msg.destination | false = false;
            let index: number | undefined;
            // The live agent is picked from the sessions as they were when the user sent.
            const liveIndex = liveAgentIndex(wtRef.current);
            try {
              const prompt = buildCommentPrompt(msg.comments);
              if (!prompt) went = false;
              else if (msg.destination === 'clipboard') { await navigator.clipboard.writeText(prompt); went = 'clipboard'; }
              else ({ went, index } = await api.command<{ went: typeof msg.destination | false; index?: number }>('sendComments', { worktreeId: id, destination: msg.destination, comments: msg.comments }));
            } catch { went = false; }
            if (!live) return;
            const fellBack = went !== false && went !== msg.destination;
            post({
              type: 'sent', destination: went || msg.destination, ok: went !== false,
              ...(fellBack ? { fellBack: true as const } : {}),
            });
            if (went === 'live') onSent(liveIndex, false);
            else if (went === 'new') onSent(index, fellBack);
          })();
          break;
        case 'openFile':
          openFileRef.current(msg.path, msg.line);
          break;
      }
    };
    return () => { live = false; reviewShim.onMessage = () => {}; reviewShim.onState = undefined; reviewShim.state = undefined; };
  }, [id, api, onNotice, onSent]);

  // Esc goes back to the terminal unless the panel is using it for a dialog, popover or comment box.
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (hostRef.current?.querySelector('[role="dialog"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, hidden]);

  return (
    <div className="review-host" ref={hostRef} hidden={hidden} tabIndex={-1} aria-label={`Review of ${nameOf(worktree)}`}>
      {Panel ? <Panel /> : <div className="placeholder">Loading the review…</div>}
    </div>
  );
}
