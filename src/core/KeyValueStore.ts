/**
 * The persistence the core needs: a synchronous read with a default and an
 * async write. Shaped like `vscode.Memento` (which satisfies it as is), so the
 * extension wraps `globalState` and `stackd` uses `JsonFileStore`.
 */
export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}
