import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeMemento, resetVscodeMock } from '../__mocks__/vscode';
import { WorktreeStore } from '../../src/worktree/WorktreeStore';
import { IWorktreeRepository } from '../../src/ports/IWorktreeRepository';
import { Worktree } from '../../src/types';
import { InMemoryWorktreeRepository } from '../helpers/InMemoryWorktreeRepository';

const STORE_KEY = 'stack.store';

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    branch: 'feature/foo',
    path: '/tmp/stack-test/feature-foo',
    repoRoot: '/tmp/stack-test/repo',
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe('WorktreeStore (implements IWorktreeRepository)', () => {
  let memento: FakeMemento;
  let store: WorktreeStore;

  beforeEach(() => {
    resetVscodeMock();
    memento = new FakeMemento();
    store = new WorktreeStore({ globalState: memento });
  });

  it('is assignable to IWorktreeRepository', () => {
    const repo: IWorktreeRepository = store;
    expect(repo.getAll()).toEqual([]);
  });

  it('getAll returns empty array when nothing stored', () => {
    expect(store.getAll()).toEqual([]);
  });

  it('reads/writes the exact key "stack.store" as { worktrees }', async () => {
    // Write path: add() persists under the exact key with the exact shape.
    const wt = makeWorktree();
    await store.add(wt);
    expect(memento.keys()).toEqual([STORE_KEY]);
    expect(memento.get(STORE_KEY)).toEqual({ worktrees: [wt] });

    // Read path: data pre-seeded under the key is what getAll() returns.
    const other = makeWorktree({ id: 'seeded', path: '/tmp/seeded' });
    await memento.update(STORE_KEY, { worktrees: [other] });
    expect(store.getAll()).toEqual([other]);
  });

  it('add persists a worktree', async () => {
    const wt = makeWorktree({ path: '/tmp/wt-a' });
    await store.add(wt);
    expect(store.getAll()).toEqual([wt]);
  });

  it('get returns the worktree by id, undefined for unknown id', async () => {
    const wt = makeWorktree({ id: 'abc' });
    await store.add(wt);
    expect(store.get('abc')).toEqual(wt);
    expect(store.get('nope')).toBeUndefined();
  });

  it('remove deletes by id', async () => {
    const a = makeWorktree({ id: 'a', path: '/tmp/a' });
    const b = makeWorktree({ id: 'b', path: '/tmp/b' });
    await store.add(a);
    await store.add(b);

    await store.remove('a');
    expect(store.getAll()).toEqual([b]);
  });

  it('remove is a no-op for unknown id', async () => {
    const a = makeWorktree({ id: 'a', path: '/tmp/a' });
    await store.add(a);
    await store.remove('unknown');
    expect(store.getAll()).toEqual([a]);
  });

  it('setAlias updates alias field; no-op for unknown id', async () => {
    const a = makeWorktree({ id: 'a' });
    await store.add(a);

    await store.setAlias('a', 'My Alias');
    expect(store.get('a')?.alias).toBe('My Alias');

    // Unknown id: nothing changes, nothing new written.
    const before = memento.get(STORE_KEY);
    await store.setAlias('missing', 'nope');
    expect(memento.get(STORE_KEY)).toEqual(before);
    expect(store.getAll().map((w) => w.alias)).toEqual(['My Alias']);
  });

  it('patch merges partial update', async () => {
    const a = makeWorktree({ id: 'a', branch: 'old-branch' });
    await store.add(a);

    await store.patch('a', { branch: 'new-branch', isMain: true });
    expect(store.get('a')).toEqual({ ...a, branch: 'new-branch', isMain: true });
  });

  it('patch on unknown id changes no worktree (real behavior: still saves the data back)', async () => {
    const a = makeWorktree({ id: 'a' });
    await store.add(a);

    await store.patch('missing', { branch: 'x' });
    expect(store.getAll()).toEqual([a]);
    // Real behavior: save() runs unconditionally, so the key still exists.
    expect(memento.get(STORE_KEY)).toEqual({ worktrees: [a] });
  });

  describe('a store written by an older version', () => {
    // Versions with per-worktree ports and a debug port kept `debugPort` on
    // every worktree and a `portRegistry` beside them. Both are gone.
    const legacy = {
      worktrees: [
        { id: 'a', branch: 'feat/a', path: '/tmp/a', repoRoot: '/tmp/repo', createdAt: 1, debugPort: 9899, alias: 'A' },
        { id: 'm', branch: 'main', path: '/tmp/repo', repoRoot: '/tmp/repo', createdAt: 2, debugPort: 0, isMain: true },
      ],
      portRegistry: { '/tmp/a': 9899, '/tmp/repo': 0 },
    };

    it('loads, with the retired fields dropped and everything else kept', async () => {
      await memento.update(STORE_KEY, legacy);
      expect(store.getAll()).toEqual([
        { id: 'a', branch: 'feat/a', path: '/tmp/a', repoRoot: '/tmp/repo', createdAt: 1, alias: 'A' },
        { id: 'm', branch: 'main', path: '/tmp/repo', repoRoot: '/tmp/repo', createdAt: 2, isMain: true },
      ]);
      expect(store.get('a')).not.toHaveProperty('debugPort');
    });

    it('writes them out on the next save', async () => {
      await memento.update(STORE_KEY, legacy);
      await store.setAlias('a', 'Renamed');
      const saved = memento.get(STORE_KEY) as Record<string, unknown>;
      expect(saved).not.toHaveProperty('portRegistry');
      expect(JSON.stringify(saved)).not.toContain('debugPort');
      expect(store.get('a')?.alias).toBe('Renamed');
    });

    it('does not rewrite the stored blob on a read', async () => {
      await memento.update(STORE_KEY, legacy);
      store.getAll();
      expect(memento.get(STORE_KEY)).toEqual(legacy);
    });

    it('reads a blob without a worktrees array as empty', async () => {
      await memento.update(STORE_KEY, { portRegistry: {} });
      expect(store.getAll()).toEqual([]);
    });
  });

  describe('pruneNonExistent', () => {
    let aliveDir: string;

    beforeEach(() => {
      aliveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-store-test-'));
    });

    afterEach(() => {
      fs.rmSync(aliveDir, { recursive: true, force: true });
    });

    it('drops entries whose path is gone (currently unused — keep behavior)', async () => {
      const alive = makeWorktree({ id: 'alive', path: aliveDir });
      const gone = makeWorktree({ id: 'gone', path: path.join(os.tmpdir(), 'stack-definitely-missing-xyz') });
      await store.add(alive);
      await store.add(gone);

      const result = await store.pruneNonExistent();

      expect(result).toEqual([alive]);
      expect(store.getAll()).toEqual([alive]);
    });

    it('does not write when all paths exist', async () => {
      const alive = makeWorktree({ id: 'alive', path: aliveDir });
      await store.add(alive);
      const before = memento.get(STORE_KEY);

      const result = await store.pruneNonExistent();

      expect(result).toEqual([alive]);
      // Real behavior: save() is skipped when nothing was removed.
      expect(memento.get(STORE_KEY)).toBe(before);
    });

    it('returns [] on an empty store without writing', async () => {
      const result = await store.pruneNonExistent();
      expect(result).toEqual([]);
      expect(memento.keys()).toEqual([]);
    });
  });
});

describe('InMemoryWorktreeRepository parity with WorktreeStore semantics', () => {
  let repo: InMemoryWorktreeRepository;

  beforeEach(() => {
    repo = new InMemoryWorktreeRepository();
  });

  it('getAll returns [] by default', () => {
    expect(repo.getAll()).toEqual([]);
  });

  it('add stores the worktree', async () => {
    const wt = makeWorktree({ id: 'a', path: '/tmp/a' });
    await repo.add(wt);
    expect(repo.getAll()).toEqual([wt]);
    expect(repo.get('a')).toEqual(wt);
  });

  it('remove drops the worktree', async () => {
    const a = makeWorktree({ id: 'a', path: '/tmp/a' });
    const b = makeWorktree({ id: 'b', path: '/tmp/b' });
    await repo.add(a);
    await repo.add(b);

    await repo.remove('a');
    expect(repo.getAll()).toEqual([b]);

    // Unknown id: no-op.
    await repo.remove('unknown');
    expect(repo.getAll()).toEqual([b]);
  });

  it('patch merges partial fields; no-op on unknown id', async () => {
    const a = makeWorktree({ id: 'a', branch: 'old' });
    await repo.add(a);

    await repo.patch('a', { branch: 'new', isMain: true });
    expect(repo.get('a')).toEqual({ ...a, branch: 'new', isMain: true });

    await repo.patch('missing', { branch: 'x' });
    expect(repo.getAll()).toEqual([{ ...a, branch: 'new', isMain: true }]);
  });

  it('setAlias updates alias; no-ops on unknown id', async () => {
    const a = makeWorktree({ id: 'a' });
    await repo.add(a);

    await repo.setAlias('a', 'Nice Name');
    expect(repo.get('a')?.alias).toBe('Nice Name');

    await repo.setAlias('missing', 'nope');
    expect(repo.getAll().map((w) => w.alias)).toEqual(['Nice Name']);
  });

  it('get returns undefined for unknown id', () => {
    expect(repo.get('nope')).toBeUndefined();
  });
});
