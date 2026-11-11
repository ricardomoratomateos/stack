import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
// Must come first: the webview modules call acquireVsCodeApi() when they are evaluated.
import { loadWith, newTaskShim, postToWebview } from '../sidebar/shim';
import '../sidebar/webviewStyles';
import type { NewTaskExtMessage, NewTaskMessage } from '@core/newtask/types';

/**
 * The extension's own new-task panel, rendered full-window over the app. Its messages come back
 * through `onMessage`; the host answers with `post`-ed `init` / `error` (see `NewTaskPanelManager`).
 * The panel and its stylesheet are loaded on first use.
 */
export function NewTaskHost({ style, onMessage, registerPost }: {
  style: string;
  onMessage: (msg: NewTaskMessage) => void;
  /** Gives the owner a way to send `init` / `error` to the panel. */
  registerPost: (post: ((msg: NewTaskExtMessage) => void) | null) => void;
}) {
  const [Panel, setPanel] = useState<ComponentType | null>(null);
  const latest = useRef(onMessage);
  latest.current = onMessage;

  useLayoutEffect(() => {
    newTaskShim.onMessage = (m) => latest.current(m as NewTaskMessage);
    registerPost((msg) => postToWebview(msg));
    return () => { newTaskShim.onMessage = () => {}; registerPost(null); };
  }, [registerPost]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [{ NewTaskPanel }, { NEWTASK_CSS }] = await Promise.all([
        loadWith(newTaskShim, () => import('@core/newtask/webview/NewTaskPanel')),
        import('@core/newtask/webview/newtask.css'),
      ]);
      if (!document.getElementById('stack-newtask-css')) {
        const el = document.createElement('style');
        el.id = 'stack-newtask-css';
        el.textContent = NEWTASK_CSS;
        document.head.appendChild(el);
      }
      if (alive) setPanel(() => NewTaskPanel);
    })();
    return () => { alive = false; };
  }, []);

  return <div className="newtask-host" data-style={style}>{Panel && <Panel />}</div>;
}
