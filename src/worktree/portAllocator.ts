import { IWorktreeRepository } from '../ports/IWorktreeRepository';
import { portBlockFor } from '../docker/dockerCompose';
import { isPortFree as probePort } from './portProbe';
import type { UnmessConfig } from '../types';

/** The only slice of the repository the allocator needs. */
type PortRegistryReader = Pick<IWorktreeRepository, 'getPortRegistry'>;

/** Slots to try before giving up, so a wedged machine fails loudly, not forever. */
const MAX_SLOTS = 500;

export interface PortAllocatorOptions {
  /**
   * Current config, re-read on every allocation so the derived docker block is
   * validated too. Omit and only the Xdebug port itself is checked.
   */
  config?: () => UnmessConfig;
  /** OS-level availability probe. Injected in tests to keep them off real sockets. */
  isPortFree?: (port: number) => Promise<boolean>;
}

export class PortAllocator {
  private store: PortRegistryReader;
  private basePort: number;
  private options: PortAllocatorOptions;

  constructor(store: PortRegistryReader, basePort: number, options: PortAllocatorOptions = {}) {
    this.store = store;
    this.basePort = basePort;
    this.options = options;
  }

  /**
   * The lowest slot that is free both in the registry *and* on the machine.
   *
   * The registry alone is not enough: it only knows worktrees Unmess created,
   * so it cannot see another project's containers, a leftover stack from a
   * deleted worktree, or any other local listener. Every port the slot will
   * bind is probed, not just the Xdebug one — a slot is only usable if its
   * whole block is.
   */
  async allocate(): Promise<number> {
    const taken = new Set(Object.values(this.store.getPortRegistry()));
    let port = this.basePort + 1;
    for (let tried = 0; tried < MAX_SLOTS; tried++, port++) {
      if (taken.has(port)) continue;
      if ((await this.firstBusyPort(port)) === undefined) return port;
    }
    throw new Error(
      `No free port slot found in ${this.basePort + 1}..${this.basePort + MAX_SLOTS} — ` +
        'every candidate is already in use on this machine.',
    );
  }

  /** Every port a worktree on this slot will bind (Xdebug + its docker block). */
  blockFor(xdebugPort: number): number[] {
    const config = this.options.config?.();
    return config ? portBlockFor(xdebugPort, config) : [xdebugPort];
  }

  /**
   * The first port of the slot's block that cannot be bound, or undefined when
   * the whole block is free. Used both to pick a slot and to re-check one long
   * after it was picked — a setup script can run for minutes before docker
   * finally reaches for the port.
   */
  async firstBusyPort(xdebugPort: number): Promise<number | undefined> {
    const probe = this.options.isPortFree ?? probePort;
    for (const port of this.blockFor(xdebugPort)) {
      if (!(await probe(port))) return port;
    }
    return undefined;
  }

  release(_port: number): void {
    // ports are released automatically when the worktree is removed from the store
  }
}
