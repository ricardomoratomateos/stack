import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
// Must come first: the webview modules call acquireVsCodeApi() when they are evaluated.
import { loadWith, postToWebview, reviewShim } from '../sidebar/shim';
import '../sidebar/webviewStyles';
import { invoke } from '@tauri-apps/api/core';
import { buildCommentPrompt } from '@core/diff/commentPrompt';
import type { DiffPanelExtMessage, DiffPanelMessage } from '@core/diff/types';
import type { WorktreeItem } from '@core/webview/types';
import { nameOf } from '@core/webview/derive';
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
 * clipboard destination is built and written locally, and `openFile` opens VS Code at the line.
 * The panel and its stylesheet are loaded on first use.
 */
export function ReviewHost({ worktree, api, onClose, onNotice }: {
  worktree: WorktreeItem;
  api: StackdApi;
  /** Esc in the review: back to the terminal. */
  onClose: () => void;
  onNotice: (text: string) => void;
}) {
  const [Panel, setPanel] = useState<ComponentType | null>(null);
  const wtRef = useRef(worktree);
  wtRef.current = worktree;
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
            try {
              const prompt = buildCommentPrompt(msg.comments);
              if (!prompt) went = false;
              else if (msg.destination === 'clipboard') { await navigator.clipboard.writeText(prompt); went = 'clipboard'; }
              else went = (await api.command<{ went: typeof msg.destination | false }>('sendComments', { worktreeId: id, destination: msg.destination, comments: msg.comments })).went;
            } catch { went = false; }
            if (!live) return;
            post({
              type: 'sent', destination: went || msg.destination, ok: went !== false,
              ...(went && went !== msg.destination ? { fellBack: true as const } : {}),
            });
          })();
          break;
        case 'openFile':
          invoke('open_in_editor', { path: `${wtRef.current.path.replace(/\/+$/, '')}/${msg.path}`, line: msg.line ?? null })
            .catch((e) => onNotice(String(e)));
          break;
      }
    };
    return () => { live = false; reviewShim.onMessage = () => {}; reviewShim.onState = undefined; reviewShim.state = undefined; };
  }, [id, api, onNotice]);

  // Esc goes back to the terminal unless the panel is using it for a dialog, popover or comment box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (hostRef.current?.querySelector('[role="dialog"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="review-host" ref={hostRef} tabIndex={-1} aria-label={`Review of ${nameOf(worktree)}`}>
      {Panel ? <Panel /> : <div className="placeholder">Loading the review…</div>}
    </div>
  );
}
