/**
 * A tiny typed event emitter with no dependency on `vscode`, shaped like
 * `vscode.EventEmitter` so the core can be hosted by the extension or by
 * `stackd`. `Event<T>` is structurally assignable to `vscode.Event<T>` for the
 * way Stack uses it (subscribe, get something with `dispose()`).
 */
export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class Emitter<T> {
  private listeners: Array<(e: T) => void> = [];

  readonly event: Event<T> = (listener) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };

  fire(data: T): void {
    for (const l of [...this.listeners]) l(data);
  }

  dispose(): void {
    this.listeners = [];
  }
}
