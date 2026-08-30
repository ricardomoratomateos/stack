import * as net from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { PortAllocator, PortAllocatorOptions } from '../../src/worktree/portAllocator';
import type { ForemanConfig } from '../../src/types';

function stubStore(registry: Record<string, number>) {
  return { getPortRegistry: () => registry };
}

/** Every port bindable unless listed in `busy` — no real sockets in unit tests. */
function stubProbe(...busy: number[]) {
  return vi.fn(async (port: number) => !busy.includes(port));
}

/** Config shaped like the aside one: WORKTREE_PORT 8081+slot, DEBUG_PORT 9898+1+slot. */
function stubConfig(over: Partial<ForemanConfig['docker']> = {}): () => ForemanConfig {
  return () =>
    ({
      debugBasePort: 9898,
      docker: {
        composeFile: '.foreman/docker-compose.worktree.yml',
        overrideFile: '',
        ports: ['WORKTREE_PORT', 'DEBUG_PORT'],
        basePort: 8081,
        portStride: 1,
        ...over,
      },
    }) as ForemanConfig;
}

/** Default options keep tests off real sockets while leaving the registry logic intact. */
const FREE: PortAllocatorOptions = { isPortFree: async () => true };

describe('PortAllocator', () => {
  describe('allocate', () => {
    it('allocates the first free port >= basePort+1 (NOT base+index)', async () => {
      const allocator = new PortAllocator(stubStore({}), 9898, FREE);
      await expect(allocator.allocate()).resolves.toBe(9899);
    });

    it('skips ports already taken in the portRegistry (keyed by path)', async () => {
      const allocator = new PortAllocator(
        stubStore({ '/repo/zer/wt-a': 9899, '/repo/zer/wt-b': 9900 }),
        9898,
        FREE,
      );
      await expect(allocator.allocate()).resolves.toBe(9901);
    });

    it('fills gaps: returns the lowest free port when taken ports are non-contiguous', async () => {
      const allocator = new PortAllocator(
        stubStore({ '/repo/zer/wt-a': 9899, '/repo/zer/wt-c': 9901 }),
        9898,
        FREE,
      );
      await expect(allocator.allocate()).resolves.toBe(9900);
    });

    it('ignores registry values at or below basePort (main worktree port 0 does not block)', async () => {
      const allocator = new PortAllocator(
        stubStore({ '/repo/main': 0, '/repo/zer/wt-a': 9899 }),
        9898,
        FREE,
      );
      await expect(allocator.allocate()).resolves.toBe(9900);
    });

    it('re-reads the registry on every call, and does not reissue a slot it just gave out', async () => {
      const registry: Record<string, number> = {};
      const allocator = new PortAllocator(stubStore(registry), 9898, FREE);
      await expect(allocator.allocate()).resolves.toBe(9899);
      // It used to hand 9899 out again here, because the store had not been
      // written yet — which is how two concurrent creations collided.
      await expect(allocator.allocate()).resolves.toBe(9900);
      // Once stored, the registry keeps it taken on its own.
      registry['/repo/zer/wt-a'] = 9899;
      await expect(allocator.allocate()).resolves.toBe(9901);
    });

    // ── OS-level availability ────────────────────────────────────────────────
    // The registry only knows worktrees Foreman created. Everything below is the
    // class of collision it is structurally blind to.

    it('skips a port the registry thinks is free but the machine has taken', async () => {
      const allocator = new PortAllocator(stubStore({}), 9898, { isPortFree: stubProbe(9899) });
      await expect(allocator.allocate()).resolves.toBe(9900);
    });

    it('skips a slot whose derived docker port is taken, even when its debug port is free', async () => {
      // Slot 0 → WORKTREE_PORT 8081 (busy), DEBUG_PORT 9899 (free). The whole block
      // has to be free or the slot is unusable — this is the exact shape of the
      // "port is already allocated" failure: debug fine, http port stolen.
      const allocator = new PortAllocator(stubStore({}), 9898, {
        config: stubConfig(),
        isPortFree: stubProbe(8081),
      });
      await expect(allocator.allocate()).resolves.toBe(9900);
    });

    it('skips a slot whose debug port is taken by a foreign process', async () => {
      const allocator = new PortAllocator(stubStore({}), 9898, {
        config: stubConfig(),
        isPortFree: stubProbe(9899),
      });
      await expect(allocator.allocate()).resolves.toBe(9900);
    });

    it('keeps walking until an entirely free block turns up', async () => {
      const allocator = new PortAllocator(stubStore({}), 9898, {
        config: stubConfig(),
        isPortFree: stubProbe(8081, 8082, 9901, 8084),
      });
      // slot 0 (8081) busy, slot 1 (8082) busy, slot 2 (debug 9901) busy,
      // slot 3 (8084) busy → slot 4: 8085 + 9903, both free.
      await expect(allocator.allocate()).resolves.toBe(9903);
    });

    it('probes the debug port even when no docker ports are configured', async () => {
      const probe = stubProbe(9899);
      const allocator = new PortAllocator(stubStore({}), 9898, {
        config: stubConfig({ ports: [] }),
        isPortFree: probe,
      });
      await expect(allocator.allocate()).resolves.toBe(9900);
      expect(probe).toHaveBeenCalledWith(9899);
    });

    it('does not probe ports already excluded by the registry', async () => {
      const probe = stubProbe();
      const allocator = new PortAllocator(stubStore({ '/repo/zer/wt-a': 9899 }), 9898, {
        isPortFree: probe,
      });
      await allocator.allocate();
      expect(probe).not.toHaveBeenCalledWith(9899);
    });

    it('throws with a diagnosable message when every slot in range is taken', async () => {
      const allocator = new PortAllocator(stubStore({}), 9898, { isPortFree: async () => false });
      await expect(allocator.allocate()).rejects.toThrow(/No free port slot found in 9899\.\.10398/);
    });
  });

  describe('blockFor', () => {
    it('returns the debug port plus its derived docker ports, deduplicated', () => {
      const allocator = new PortAllocator(stubStore({}), 9898, { config: stubConfig() });
      // DEBUG_PORT maps back onto the debug port itself — it must appear once.
      expect(allocator.blockFor(9901)).toEqual([9901, 8083]);
    });

    it('falls back to the debug port alone when no config is wired in', () => {
      const allocator = new PortAllocator(stubStore({}), 9898, FREE);
      expect(allocator.blockFor(9901)).toEqual([9901]);
    });
  });

  describe('firstBusyPort', () => {
    it('returns undefined when the whole block is bindable', async () => {
      const allocator = new PortAllocator(stubStore({}), 9898, {
        config: stubConfig(),
        isPortFree: stubProbe(),
      });
      await expect(allocator.firstBusyPort(9901)).resolves.toBeUndefined();
    });

    it('names the offending port so the user can go find what holds it', async () => {
      const allocator = new PortAllocator(stubStore({}), 9898, {
        config: stubConfig(),
        isPortFree: stubProbe(8083),
      });
      await expect(allocator.firstBusyPort(9901)).resolves.toBe(8083);
    });

    it('stops at the first busy port instead of probing the rest', async () => {
      const probe = stubProbe(9901);
      const allocator = new PortAllocator(stubStore({}), 9898, { config: stubConfig(), isPortFree: probe });
      await allocator.firstBusyPort(9901);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('defaults to the real socket probe when none is injected', async () => {
      const server = net.createServer();
      await new Promise<void>((done) => server.listen(0, '0.0.0.0', done));
      const port = (server.address() as net.AddressInfo).port;
      try {
        const allocator = new PortAllocator(stubStore({}), 9898);
        await expect(allocator.firstBusyPort(port)).resolves.toBe(port);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    });
  });

  describe('release', () => {
    it('is a no-op (registry entry is removed with the worktree)', async () => {
      const registry = { '/repo/zer/wt-a': 9899 };
      const allocator = new PortAllocator(stubStore(registry), 9898, FREE);
      expect(allocator.release(9899)).toBeUndefined();
      // registry untouched, and the port is still considered taken
      expect(registry).toEqual({ '/repo/zer/wt-a': 9899 });
      await expect(allocator.allocate()).resolves.toBe(9900);
    });
  });
});

describe('concurrent allocation', () => {
  it('never hands the same slot to two callers started together', async () => {
    // allocate() reads the registry, probes, and returns — but the caller only
    // writes to the store afterwards. Two creations started together therefore
    // read the same registry, probed the same free ports, and were handed the
    // same slot: two worktrees sharing one block of docker ports, which fails
    // minutes later inside `compose up`.
    const allocator = new PortAllocator(stubStore({}), 9898, { config: stubConfig(), isPortFree: stubProbe() });

    const [a, b, c] = await Promise.all([
      allocator.allocate(),
      allocator.allocate(),
      allocator.allocate(),
    ]);

    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('keeps holding a slot until it reaches the store', async () => {
    const registry: Record<string, number> = {};
    const allocator = new PortAllocator(stubStore(registry), 9898, { isPortFree: stubProbe() });

    const first = await allocator.allocate();
    const second = await allocator.allocate();

    // Neither has been stored yet; the second must not reuse the first.
    expect(second).not.toBe(first);
  });

  it('stops holding a slot once the store knows about it', async () => {
    const registry: Record<string, number> = {};
    const allocator = new PortAllocator(stubStore(registry), 9898, { isPortFree: stubProbe() });

    const first = await allocator.allocate();
    registry['/repo/zer/a'] = first; // the caller stored it

    // The reservation is now redundant; the registry alone keeps it taken.
    expect(await allocator.allocate()).not.toBe(first);
  });

  it('release hands a slot back when the creation that took it failed', async () => {
    const allocator = new PortAllocator(stubStore({}), 9898, { isPortFree: stubProbe() });

    const first = await allocator.allocate();
    allocator.release(first);

    expect(await allocator.allocate()).toBe(first);
  });

  it('does not hold a slot whose probe said busy', async () => {
    // 9899's block is busy, so it is never handed out — and must not stay
    // reserved either, or a transient conflict would burn the slot for good.
    const busy = { current: true };
    const allocator = new PortAllocator(stubStore({}), 9898, {
      isPortFree: async (port: number) => !(port === 9899 && busy.current),
    });

    expect(await allocator.allocate()).toBe(9900);
    busy.current = false;
    expect(await allocator.allocate()).toBe(9899);
  });
});
