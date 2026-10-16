import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PortReservationFile } from '../../src/worktree/portReservations';
import { PortAllocator } from '../../src/worktree/portAllocator';

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
});
