import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeMemento, resetVscodeMock } from '../__mocks__/vscode';
import { WorktreeStore } from '../../src/worktree/WorktreeStore';
import { IWorktreeRepository } from '../../src/ports/IWorktreeRepository';
import { Worktree } from '../../src/types';
import { InMemoryWorktreeRepository } from '../helpers/InMemoryWorktreeRepository';

const STORE_KEY = 'foreman.store';

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    branch: 'feature/foo',
    path: '/tmp/foreman-test/feature-foo',
    repoRoot: '/tmp/foreman-test/repo',
    debugPort: 9004,
    dockerProjectName: 'feature-foo',
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
    expect(store.getPortRegistry()).toEqual({});
  });

  it('reads/writes the exact key "foreman.store" as { worktrees, portRegistry }', async () => {
    // Write path: add() persists under the exact key with the exact shape.
    const wt = makeWorktree();
    await store.add(wt);
    expect(memento.keys()).toEqual([STORE_KEY]);
    expect(memento.get(STORE_KEY)).toEqual({
      worktrees: [wt],
      portRegistry: { [wt.path]: wt.debugPort },
    });

    // Read path: data pre-seeded under the key is what getAll() returns.
    const other = makeWorktree({ id: 'seeded', path: '/tmp/seeded', debugPort: 9010 });
    await memento.update(STORE_KEY, {
      worktrees: [other],
      portRegistry: { '/tmp/seeded': 9010 },
    });
    expect(store.getAll()).toEqual([other]);
  });

  it('add persists a worktree AND registers its port in portRegistry (by path)', async () => {
    const wt = makeWorktree({ path: '/tmp/wt-a', debugPort: 9005 });
    await store.add(wt);
    expect(store.getAll()).toEqual([wt]);
    expect(store.getPortRegistry()).toEqual({ '/tmp/wt-a': 9005 });
  });

  it('get returns the worktree by id, undefined for unknown id', async () => {
    const wt = makeWorktree({ id: 'abc' });
    await store.add(wt);
    expect(store.get('abc')).toEqual(wt);
    expect(store.get('nope')).toBeUndefined();
  });

  it('remove deletes by id AND removes its portRegistry entry', async () => {
    const a = makeWorktree({ id: 'a', path: '/tmp/a', debugPort: 9001 });
    const b = makeWorktree({ id: 'b', path: '/tmp/b', debugPort: 9002 });
    await store.add(a);
    await store.add(b);

    await store.remove('a');
    expect(store.getAll()).toEqual([b]);
    expect(store.getPortRegistry()).toEqual({ '/tmp/b': 9002 });
  });

  it('remove is a no-op for unknown id (keeps worktrees and registry intact)', async () => {
    const a = makeWorktree({ id: 'a', path: '/tmp/a', debugPort: 9001 });
    await store.add(a);
    await store.remove('unknown');
    expect(store.getAll()).toEqual([a]);
    expect(store.getPortRegistry()).toEqual({ '/tmp/a': 9001 });
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
    expect(memento.get(STORE_KEY)).toEqual({
      worktrees: [a],
      portRegistry: { [a.path]: a.debugPort },
    });
  });

  it('getPortRegistry returns the registry', async () => {
    await store.add(makeWorktree({ id: 'a', path: '/tmp/a', debugPort: 9001 }));
    await store.add(makeWorktree({ id: 'b', path: '/tmp/b', debugPort: 9002 }));
    expect(store.getPortRegistry()).toEqual({ '/tmp/a': 9001, '/tmp/b': 9002 });
  });

  describe('pruneNonExistent', () => {
    let aliveDir: string;

    beforeEach(() => {
      aliveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-store-test-'));
    });

    afterEach(() => {
      fs.rmSync(aliveDir, { recursive: true, force: true });
    });

    it('drops entries whose path is gone (currently unused — keep behavior)', async () => {
      const alive = makeWorktree({ id: 'alive', path: aliveDir, debugPort: 9001 });
      const gone = makeWorktree({
        id: 'gone',
        path: path.join(os.tmpdir(), 'foreman-definitely-missing-xyz'),
        debugPort: 9002,
      });
      await store.add(alive);
      await store.add(gone);

      const result = await store.pruneNonExistent();

      expect(result).toEqual([alive]);
      expect(store.getAll()).toEqual([alive]);
      // The pruned worktree's portRegistry entry is dropped too.
      expect(store.getPortRegistry()).toEqual({ [aliveDir]: 9001 });
    });

    it('does not write when all paths exist', async () => {
      const alive = makeWorktree({ id: 'alive', path: aliveDir, debugPort: 9001 });
      await store.add(alive);
      const before = memento.get(STORE_KEY);

      const result = await store.pruneNonExistent();

      expect(result).toEqual([alive]);
      // Real behavior: save() is skipped when nothing was removed.
      expect(memento.get(STORE_KEY)).toBe(before);
      expect(store.getPortRegistry()).toEqual({ [aliveDir]: 9001 });
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
    expect(repo.getPortRegistry()).toEqual({});
  });

  it('add registers the port by path', async () => {
    const wt = makeWorktree({ id: 'a', path: '/tmp/a', debugPort: 9001 });
    await repo.add(wt);
    expect(repo.getAll()).toEqual([wt]);
    expect(repo.get('a')).toEqual(wt);
    expect(repo.getPortRegistry()).toEqual({ '/tmp/a': 9001 });
  });

  it('remove drops the worktree and its registry entry', async () => {
    const a = makeWorktree({ id: 'a', path: '/tmp/a', debugPort: 9001 });
    const b = makeWorktree({ id: 'b', path: '/tmp/b', debugPort: 9002 });
    await repo.add(a);
    await repo.add(b);

    await repo.remove('a');
    expect(repo.getAll()).toEqual([b]);
    expect(repo.getPortRegistry()).toEqual({ '/tmp/b': 9002 });

    // Unknown id: no-op.
    await repo.remove('unknown');
    expect(repo.getAll()).toEqual([b]);
    expect(repo.getPortRegistry()).toEqual({ '/tmp/b': 9002 });
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

describe('port registry stays in step with the worktrees', () => {
  const makeStore = () => new WorktreeStore({ globalState: new FakeMemento() });

  it('reports the NEW port after a patch reassigns it', async () => {
    // ensureFreePorts moves a worktree off a port something else grabbed, via
    // patch(). The stored registry was only ever written by add(), so it kept
    // reporting the old port: the new one was never reserved and the old one
    // was reserved forever — the exact collision the port work removed.
    const store = makeStore();
    const wt = makeWorktree({ id: 'a', debugPort: 9899 });
    await store.add(wt);

    await store.patch('a', { debugPort: 9903 });

    expect(Object.values(store.getPortRegistry())).toEqual([9903]);
  });

  it('never reports a port no worktree holds', async () => {
    const store = makeStore();
    await store.add(makeWorktree({ id: 'a', debugPort: 9899 }));
    await store.patch('a', { debugPort: 9903 });

    expect(Object.values(store.getPortRegistry())).not.toContain(9899);
  });
});
