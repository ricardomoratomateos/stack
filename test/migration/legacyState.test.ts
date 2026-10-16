import { describe, it, expect, beforeEach } from 'vitest';
import { FakeMemento } from 'vscode';
import { STATE_MIGRATED_KEY, migrateLegacyState } from '../../src/migration/legacyState';
import { STORE_KEY } from '../../src/constants';
import { ACTIVE_WORKTREE_KEY, WORKTREE_ORDER_KEY } from '../../src/application/WorktreeApplicationService';

describe('migrateLegacyState', () => {
  let memento: FakeMemento;
  beforeEach(() => { memento = new FakeMemento(); });

  it("renames every foreman.* key to its stack.* name — the ones Stack reads", async () => {
    const store = { worktrees: [{ id: 'wt-1' }], portRegistry: {} };
    await memento.update('foreman.store', store);
    await memento.update('foreman.tabs', { 'wt-1': { files: ['a.ts'] } });
    await memento.update('foreman.breakpoints', { 'wt-1': [] });
    await memento.update('foreman.claudeStates', { 'wt-1': { 1: 'permission' } });
    await memento.update('foreman.sessionOrder', { 'wt-1': [1, 2] });
    await memento.update('foreman.sessionAliases', { 'wt-1': { 1: 'redis' } });
    await memento.update('foreman.worktreeOrder', ['wt-1']);
    await memento.update('foreman.activeWorktreeId', null);
    await memento.update('foreman.setupNudged:/repo', true);
    await memento.update('unrelated', 1);

    const copied = await migrateLegacyState(memento as never);

    expect(copied).toHaveLength(9);
    expect(memento.get(STORE_KEY)).toEqual(store);
    expect(memento.get(WORKTREE_ORDER_KEY)).toEqual(['wt-1']);
    expect(memento.get(ACTIVE_WORKTREE_KEY)).toBeNull();
    for (const key of ['tabs', 'breakpoints', 'claudeStates', 'sessionOrder', 'sessionAliases', 'setupNudged:/repo']) {
      expect(memento.get(`stack.${key}`)).toEqual(memento.get(`foreman.${key}`));
    }
    // Read-through: the old keys stay, untouched.
    expect(memento.get('foreman.store')).toEqual(store);
    expect(memento.get('unrelated')).toBe(1);
  });

  it('never overwrites what Stack has already written', async () => {
    await memento.update('foreman.store', { worktrees: [{ id: 'old' }], portRegistry: {} });
    await memento.update(STORE_KEY, { worktrees: [{ id: 'new' }], portRegistry: {} });

    await expect(migrateLegacyState(memento as never)).resolves.toEqual([]);
    expect(memento.get(STORE_KEY)).toEqual({ worktrees: [{ id: 'new' }], portRegistry: {} });
  });

  it('runs once per memento', async () => {
    await migrateLegacyState(memento as never);
    expect(memento.get(STATE_MIGRATED_KEY)).toBe(true);

    await memento.update('foreman.tabs', { late: true });
    await expect(migrateLegacyState(memento as never)).resolves.toEqual([]);
    expect(memento.get('stack.tabs')).toBeUndefined();
  });
});
