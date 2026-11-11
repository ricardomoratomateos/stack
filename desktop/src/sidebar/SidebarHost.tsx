import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
// Must come first: the webview calls acquireVsCodeApi() when its modules are evaluated.
import { postToWebview, shim } from './shim';
import { App as Sidebar } from '@core/webview/App';
import type { StackState, WebMessage } from '@core/webview/types';
import './webviewStyles';

/**
 * The extension's own sidebar webview, rendered in the app. It gets the same messages the
 * extension posts and its outgoing messages come back through `onMessage`.
 */
export function SidebarHost({ state, onMessage, actions }: { state: StackState | null; onMessage: (msg: WebMessage) => void; actions?: ReactNode }) {
  // `actions` (repo picker, "+") go into the slot the webview leaves in its brand row.
  const root = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<Element | null>(null);
  const latest = useRef({ state, onMessage });
  latest.current = { state, onMessage };

  // A layout effect: the webview's own effect (child, passive) sends `ready` and that must find this hooked up.
  useLayoutEffect(() => {
    shim.onMessage = (m) => {
      const msg = m as WebMessage;
      if (msg.type === 'ready') {
        if (latest.current.state) postToWebview({ type: 'state', payload: latest.current.state });
        return;
      }
      latest.current.onMessage(msg);
    };
    return () => { shim.onMessage = () => {}; };
  }, []);

  useLayoutEffect(() => {
    if (state) postToWebview({ type: 'state', payload: state });
  }, [state]);

  useLayoutEffect(() => {
    const found = root.current?.querySelector('[data-host-slot]') ?? null;
    if (found !== slot) setSlot(found);
  });

  return (
    <div ref={root} className="sidebar-webview">
      <Sidebar />
      {actions && (slot ? createPortal(actions, slot) : <div className="host-actions">{actions}</div>)}
    </div>
  );
}
