/**
 * `acquireVsCodeApi()` for the desktop app. Import this BEFORE anything from `@core/webview`: the
 * webview's `vscode.ts` calls the global when it is evaluated.
 */
export interface Shim {
  /** Called with every message the webview posts. */
  onMessage: (msg: unknown) => void;
  state: unknown;
}

export const shim: Shim = { onMessage: () => {}, state: undefined };

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (msg: unknown) => shim.onMessage(msg),
  getState: () => shim.state,
  setState: (s: unknown) => { shim.state = s; },
});

/** Delivers a message to the webview the way VS Code does: a `message` event on `window`. */
export function postToWebview(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}
