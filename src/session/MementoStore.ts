import type * as vscode from 'vscode';
import type { KeyValueStore } from '../core/KeyValueStore';

/** VS Code side of KeyValueStore: wraps a Memento (e.g. `ctx.globalState`). */
export class MementoStore implements KeyValueStore {
  constructor(private memento: vscode.Memento) {}
  get<T>(key: string, defaultValue: T): T {
    return this.memento.get<T>(key, defaultValue);
  }
  update(key: string, value: unknown): PromiseLike<void> {
    return this.memento.update(key, value);
  }
}
