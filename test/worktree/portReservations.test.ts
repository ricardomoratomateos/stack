import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PortReservationFile } from '../../src/worktree/portReservations';
import { PortAllocator } from '../../src/worktree/portAllocator';

// Auto-spy on node:fs (real implementations kept) so a test can make one call
// fail the way a wedged or racing filesystem would.
vi.mock('node:fs', { spy: true });

const fsError = (code: string) => Object.assign(new Error(code), { code });

describe('PortReservationFile', () => {
  let storage: string;
  const alive = new Set<number>();
  const windowWith = (pid: number, now: () => number = Date.now) =>
    new PortReservationFile(storage, { pid, isAlive: (p) => alive.has(p), now });

  beforeEach(() => {
    storage = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ports-'));
    alive.clear();
    alive.add(1).add(2);
  });
  afterEach(() => { fs.rmSync(storage, { recursive: true, force: true }); });

  it('a slot one window claimed is refused to another', async () => {
    expect(await windowWith(1).tryReserve(9899)).toBe(true);
    expect(await windowWith(2).tryReserve(9899)).toBe(false);
    expect(await windowWith(2).tryReserve(9900)).toBe(true);
  });

  it('a window may re-claim its own slot', async () => {
    expect(await windowWith(1).tryReserve(9899)).toBe(true);
    expect(await windowWith(1).tryReserve(9899)).toBe(true);
  });

  it('release frees the slot, but only for its owner', async () => {
    await windowWith(1).tryReserve(9899);
    await windowWith(2).release(9899);
    expect(await windowWith(2).tryReserve(9899)).toBe(false);
    await windowWith(1).release(9899);
    expect(await windowWith(2).tryReserve(9899)).toBe(true);
  });

  it("drops the claims of a window that is gone (crashed, closed)", async () => {
    await windowWith(1).tryReserve(9899);
    alive.delete(1);
    expect(await windowWith(2).tryReserve(9899)).toBe(true);
  });

  it('drops claims past their TTL', async () => {
    let t = 1_000_000;
    await windowWith(1, () => t).tryReserve(9899);
    t += 11 * 60_000;
    expect(await windowWith(2, () => t).tryReserve(9899)).toBe(true);
  });

  it('breaks a lock left behind by a process that died holding it', async () => {
    const lock = path.join(storage, 'port-reservations.json.lock');
    fs.writeFileSync(lock, '');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, past, past);
    expect(await windowWith(1).tryReserve(9899)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('survives a corrupt reservations file', async () => {
    fs.writeFileSync(path.join(storage, 'port-reservations.json'), '{ nope');
    expect(await windowWith(1).tryReserve(9899)).toBe(true);
  });

  it('two windows allocating at the same moment get different slots', async () => {
    // The bug: each window's reservations were its own, and the store (shared
    // globalState) only learns of a worktree after allocate() returns — both
    // windows read the same registry, probed the same free ports, and got the
    // same slot.
    const store = { getPortRegistry: () => ({}) };
    // A probe slow enough that both allocations are in flight together.
    const isPortFree = async () => { await new Promise((r) => setTimeout(r, 20)); return true; };
    const a = new PortAllocator(store, 9898, { isPortFree, shared: windowWith(1) });
    const b = new PortAllocator(store, 9898, { isPortFree, shared: windowWith(2) });

    const [pa, pb] = await Promise.all([a.allocate(), b.allocate()]);

    expect(pa).not.toBe(pb);
    expect([pa, pb].sort()).toEqual([9899, 9900]);
  });

  it('a slot whose ports turned out busy is given back to the other windows', async () => {
    const store = { getPortRegistry: () => ({}) };
    const a = new PortAllocator(store, 9898, { isPortFree: async (p) => p !== 9899, shared: windowWith(1) });
    expect(await a.allocate()).toBe(9900);
    expect(await windowWith(2).tryReserve(9899)).toBe(true);
  });

  it("releasing a failed creation's slot frees it for the other windows", async () => {
    const store = { getPortRegistry: () => ({}) };
    const a = new PortAllocator(store, 9898, { isPortFree: async () => true, shared: windowWith(1) });
    const port = await a.allocate();
    a.release(port);
    // release() is fire-and-forget; give the file write its turn.
    await new Promise((r) => setTimeout(r, 50));
    expect(await windowWith(2).tryReserve(port)).toBe(true);
  });

  describe('the shared file', () => {
    const file = () => path.join(storage, 'port-reservations.json');
    const lock = () => `${file()}.lock`;

    it('by default claims as this process, and tells live windows from gone ones', async () => {
      // A pid that just exited is gone; pid 1 is alive (EPERM when not ours to signal).
      const gone = spawnSync(process.execPath, ['-e', '']).pid!;
      fs.writeFileSync(file(), JSON.stringify({
        9899: { pid: gone, at: Date.now() },
        9900: { pid: 1, at: Date.now() },
      }));
      const w = new PortReservationFile(storage);
      expect(await w.tryReserve(9899)).toBe(true);
      expect(await w.tryReserve(9900)).toBe(false);
      expect(JSON.parse(fs.readFileSync(file(), 'utf8'))[9899].pid).toBe(process.pid);
    });

    it('reads anything that is not a map of claims as no claims', async () => {
      for (const text of ['null', '[]', '5', '{ "9899": { "pid": "1" }, "9900": 7 }']) {
        fs.writeFileSync(file(), text);
        expect(await windowWith(2).tryReserve(9899)).toBe(true);
        expect(await windowWith(1).tryReserve(9900)).toBe(true);
        await windowWith(2).release(9899);
        await windowWith(1).release(9900);
      }
    });

    it('a write that fails degrades to "reserved" and still releases the lock', async () => {
      // A directory where the file should be: the rename over it fails.
      fs.mkdirSync(file());
      expect(await windowWith(1).tryReserve(9899)).toBe(true);
      expect(fs.existsSync(lock())).toBe(false);
    });

    it('a lock that cannot be removed afterwards does not fail the claim', async () => {
      vi.mocked(fs.rmSync).mockImplementationOnce(() => { throw fsError('EACCES'); });
      expect(await windowWith(1).tryReserve(9899)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file(), 'utf8'))[9899].pid).toBe(1);
      // Left behind: the next window breaks it once it is stale.
      expect(fs.existsSync(lock())).toBe(true);
    });
  });

  describe('when the lock cannot be had, falls back to this window alone', () => {
    const lock = () => path.join(storage, 'port-reservations.json.lock');

    it('storage that cannot be created', async () => {
      fs.writeFileSync(path.join(storage, 'a-file'), '');
      const w = new PortReservationFile(path.join(storage, 'a-file', 'storage'), { pid: 1, isAlive: () => true });
      expect(await w.tryReserve(9899)).toBe(true);
      await expect(w.release(9899)).resolves.toBeUndefined();
    });

    it('a lock that cannot be created for any reason but "taken"', async () => {
      vi.mocked(fs.openSync).mockImplementationOnce(() => { throw fsError('EACCES'); });
      expect(await windowWith(1).tryReserve(9899)).toBe(true);
      expect(fs.existsSync(path.join(storage, 'port-reservations.json'))).toBe(false);
    });

    it('a live lock held past the wait', async () => {
      fs.writeFileSync(lock(), '');
      const w = windowWith(1);
      const start = Date.now();
      let calls = 0;
      // The first reading sets the deadline; every later one is past it, but
      // not so far that the (fresh) lock would count as abandoned.
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? start : start + 3_000));
      try {
        expect(await w.tryReserve(9899)).toBe(true);
      } finally {
        clock.mockRestore();
      }
      expect(fs.existsSync(lock())).toBe(true);
      expect(fs.existsSync(path.join(storage, 'port-reservations.json'))).toBe(false);
    });

    it('retries at once when the lock is released between seeing it and looking at it', async () => {
      fs.writeFileSync(lock(), '');
      vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
        fs.unlinkSync(lock());
        throw fsError('ENOENT');
      });
      expect(await windowWith(1).tryReserve(9899)).toBe(true);
      expect(await windowWith(2).tryReserve(9899)).toBe(false);
    });

    it('ages out a stale dangling symlink at the lock path instead of spinning on it', async () => {
      fs.symlinkSync(path.join(storage, 'nowhere'), lock());
      const old = new Date(Date.now() - 60_000);
      fs.lutimesSync(lock(), old, old);
      expect(await windowWith(1).tryReserve(9899)).toBe(true);
      expect(await windowWith(2).tryReserve(9899)).toBe(false);
    });

    it('gives up at the deadline when the lock can never be inspected', async () => {
      fs.writeFileSync(lock(), '');
      vi.mocked(fs.lstatSync).mockImplementation(() => { throw fsError('ENOENT'); });
      let t = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => (t += 1_000));
      try {
        // Falls back to this window's own reservations rather than hanging.
        expect(await windowWith(1).tryReserve(9899)).toBe(true);
      } finally {
        clock.mockRestore();
        vi.mocked(fs.lstatSync).mockRestore();
      }
    });
  });
});
