import type * as vscode from 'vscode';

/** The prefix every globalState/workspaceState key had under Foreman. */
export const LEGACY_STATE_PREFIX = 'foreman.';
/** The prefix the same keys have under Stack. */
export const STATE_PREFIX = 'stack.';
/** Set in each memento once its legacy keys have been carried over. */
export const STATE_MIGRATED_KEY = 'stack.migration.state';

/**
 * Carries Foreman's persisted state over to Stack's key names, once per
 * memento (globalState and workspaceState each call this).
 *
 * Every key moved from `foreman.<rest>` to `stack.<rest>`: the worktree store,
 * saved tabs and breakpoints, agent states, session order and aliases, the
 * worktree order, the selected worktree, the per-repository setup nudges.
 * The memento is keyed by extension id, which changed with the rename, so
 * these legacy keys are only here when Foreman's rows were copied into this
 * extension's storage; this then renames them in place. Read-through: a key
 * Stack has already written is never overwritten, and the legacy keys are
 * left where they are rather than deleted — harmless, and a way back.
 *
 * Returns the legacy keys it copied.
 */
export async function migrateLegacyState(memento: vscode.Memento): Promise<string[]> {
  if (memento.get<boolean>(STATE_MIGRATED_KEY)) return [];
  const copied: string[] = [];
  for (const key of memento.keys()) {
    if (!key.startsWith(LEGACY_STATE_PREFIX)) continue;
    const next = STATE_PREFIX + key.slice(LEGACY_STATE_PREFIX.length);
    if (memento.get(next) !== undefined) continue;
    await memento.update(next, memento.get(key));
    copied.push(key);
  }
  await memento.update(STATE_MIGRATED_KEY, true);
  return copied;
}
