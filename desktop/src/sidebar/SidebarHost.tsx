import { useLayoutEffect, useRef } from 'react';
// Must come first: the webview calls acquireVsCodeApi() when its modules are evaluated.
import { postToWebview, shim } from './shim';
import { App as Sidebar } from '@core/webview/App';
import type { StackState, WebMessage } from '@core/webview/types';
import './webviewStyles';

/**
 * The extension's own sidebar webview, rendered in the app. It gets the same messages the
 * extension posts and its outgoing messages come back through `onMessage`.
 */
export function SidebarHost({ state, onMessage }: { state: StackState | null; onMessage: (msg: WebMessage) => void }) {
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

  return <Sidebar />;
}
