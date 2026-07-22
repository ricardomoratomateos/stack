import { describe, it, expect } from 'vitest';
import { PortAllocator } from '../../src/worktree/portAllocator';

function stubStore(registry: Record<string, number>) {
  return { getPortRegistry: () => registry };
}

describe('PortAllocator', () => {
  describe('allocate', () => {
    it('allocates the first free port >= basePort+1 (NOT base+index)', () => {
      const allocator = new PortAllocator(stubStore({}), 9898);
      expect(allocator.allocate()).toBe(9899);
    });

    it('skips ports already taken in the portRegistry (keyed by path)', () => {
      const allocator = new PortAllocator(
        stubStore({ '/repo/zer/wt-a': 9899, '/repo/zer/wt-b': 9900 }),
        9898,
      );
      expect(allocator.allocate()).toBe(9901);
    });

    it('fills gaps: returns the lowest free port when taken ports are non-contiguous', () => {
      const allocator = new PortAllocator(
        stubStore({ '/repo/zer/wt-a': 9899, '/repo/zer/wt-c': 9901 }),
        9898,
      );
      expect(allocator.allocate()).toBe(9900);
    });

    it('ignores registry values at or below basePort (main worktree port 0 does not block)', () => {
      const allocator = new PortAllocator(
        stubStore({ '/repo/main': 0, '/repo/zer/wt-a': 9899 }),
        9898,
      );
      expect(allocator.allocate()).toBe(9900);
    });

    it('re-reads the registry on every call (same result until the registry changes)', () => {
      const registry: Record<string, number> = {};
      const allocator = new PortAllocator(stubStore(registry), 9898);
      expect(allocator.allocate()).toBe(9899);
      // allocate() does not record the port itself — the store does, on add()
      expect(allocator.allocate()).toBe(9899);
      registry['/repo/zer/wt-a'] = 9899;
      expect(allocator.allocate()).toBe(9900);
    });
  });

  describe('release', () => {
    it('is a no-op (registry entry is removed with the worktree)', () => {
      const registry = { '/repo/zer/wt-a': 9899 };
      const allocator = new PortAllocator(stubStore(registry), 9898);
      expect(allocator.release(9899)).toBeUndefined();
      // registry untouched, and the port is still considered taken
      expect(registry).toEqual({ '/repo/zer/wt-a': 9899 });
      expect(allocator.allocate()).toBe(9900);
    });
  });
});
