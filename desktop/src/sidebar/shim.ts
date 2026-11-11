/**
 * `acquireVsCodeApi()` for the desktop app. Import this BEFORE anything from `@core/webview`: the
 * webview's `vscode.ts` calls the global when it is evaluated.
 *
 * Every webview module calls it once, at evaluation, and keeps the result. The sidebar is imported
 * statically and gets `shim`; the new-task panel is imported later through `loadWith`, which points
 * the global at its own channel for the duration of the import.
 */
export interface Shim {
  /** Called with every message the webview posts. */
  onMessage: (msg: unknown) => void;
  state: unknown;
}

export const shim: Shim = { onMessage: () => {}, state: undefined };
export const newTaskShim: Shim = { onMessage: () => {}, state: undefined };

let current = shim;

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => {
  const channel = current;
  return {
    postMessage: (msg: unknown) => channel.onMessage(msg),
    getState: () => channel.state,
    setState: (s: unknown) => { channel.state = s; },
  };
};

/** Evaluates `load` (a dynamic import) with `acquireVsCodeApi` bound to `channel`. */
export async function loadWith<T>(channel: Shim, load: () => Promise<T>): Promise<T> {
  const previous = current;
  current = channel;
  try {
    return await load();
  } finally {
    current = previous;
  }
}

/** Delivers a message to the webview the way VS Code does: a `message` event on `window`. */
export function postToWebview(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}
