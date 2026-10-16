import { IWorktreeRepository } from '../ports/IWorktreeRepository';
import { portBlockFor } from '../docker/dockerCompose';
import { isPortFree as probePort } from './portProbe';
import type { ForemanConfig } from '../types';
import type { SharedPortReservations } from './portReservations';

/** The only slice of the repository the allocator needs. */
type PortRegistryReader = Pick<IWorktreeRepository, 'getPortRegistry'>;

/** Slots to try before giving up, so a wedged machine fails loudly, not forever. */
const MAX_SLOTS = 500;

export interface PortAllocatorOptions {
  /**
   * Current config, re-read on every allocation so the derived docker block is
   * validated too. Omit and only the debug port itself is checked.
   */
  config?: () => ForemanConfig;
  /** OS-level availability probe. Injected in tests to keep them off real sockets. */
  isPortFree?: (port: number) => Promise<boolean>;
  /**
   * Reservations every window can see. Without it, reservations are this
   * window's alone and two windows creating at once can get the same slot.
   */
  shared?: SharedPortReservations;
}

export class PortAllocator {
  private store: PortRegistryReader;
  private basePort: () => number;
  private options: PortAllocatorOptions;
  /**
   * Slots handed out but not yet written to the store. Held here because the
   * registry only learns about a worktree once it is added, which happens after
   * allocate() returns — a window two concurrent creations both fit through.
   */
  private reserved = new Set<number>();

  /**
   * `basePort` may be a getter so `foreman.debugBasePort` is read per
   * allocation. It used to be captured once at activation while the docker
   * block derivation (dockerPortsFor) read the setting live, so changing it
   * mid-session made the two disagree about which block a slot owns.
   */
  constructor(store: PortRegistryReader, basePort: number | (() => number), options: PortAllocatorOptions = {}) {
    this.store = store;
    this.basePort = typeof basePort === 'function' ? basePort : () => basePort;
    this.options = options;
  }

  /**
   * The lowest slot that is free both in the registry *and* on the machine.
   *
   * The registry alone is not enough: it only knows worktrees Foreman created,
   * so it cannot see another project's containers, a leftover stack from a
   * deleted worktree, or any other local listener. Every port the slot will
   * bind is probed, not just the debug one — a slot is only usable if its
   * whole block is.
   */
  async allocate(): Promise<number> {
    const registry = new Set(Object.values(this.store.getPortRegistry()));
    // Anything that reached the store no longer needs holding here. The shared
    // claim is deliberately left to expire on its own: other windows see this
    // store write only once globalState has synced to them, and until then the
    // claim is all that tells them the slot is taken.
    for (const p of this.reserved) if (registry.has(p)) this.reserved.delete(p);

    const basePort = this.basePort();
    let port = basePort + 1;
    for (let tried = 0; tried < MAX_SLOTS; tried++, port++) {
      if (registry.has(port) || this.reserved.has(port)) continue;
      // Claim the candidate BEFORE probing it. The probe is async and the
      // caller only writes to the store afterwards, so two creations started
      // together used to read the same registry, probe the same free ports and
      // be handed the same slot — two worktrees with one block of docker ports,
      // failing minutes later inside `compose up`.
      this.reserved.add(port);
      // Then across windows: the registry is globalState, which a creation in
      // another window reaches only after its own allocate() returned.
      if (this.options.shared && !(await this.options.shared.tryReserve(port))) {
        this.reserved.delete(port);
        continue;
      }
      if ((await this.firstBusyPort(port)) === undefined) return port;
      this.reserved.delete(port);
      await this.options.shared?.release(port);
    }
    throw new Error(
      `No free port slot found in ${basePort + 1}..${basePort + MAX_SLOTS} — ` +
        'every candidate is already in use on this machine.',
    );
  }

  /** Every port a worktree on this slot will bind (debug + its docker block). */
  blockFor(debugPort: number): number[] {
    const config = this.options.config?.();
    return config ? portBlockFor(debugPort, config) : [debugPort];
  }

  /**
   * The first port of the slot's block that cannot be bound, or undefined when
   * the whole block is free. Used both to pick a slot and to re-check one long
   * after it was picked — a setup script can run for minutes before docker
   * finally reaches for the port.
   *
   * `ignore` lists ports known to be held by the worktree itself (its own
   * running containers, its debug listener): busy, but not a collision.
   */
  async firstBusyPort(debugPort: number, ignore: ReadonlySet<number> = new Set()): Promise<number | undefined> {
    const probe = this.options.isPortFree ?? probePort;
    for (const port of this.blockFor(debugPort)) {
      if (ignore.has(port)) continue;
      if (!(await probe(port))) return port;
    }
    return undefined;
  }

  /**
   * Drop a reservation for a slot that never made it into the store, so a
   * failed creation does not sterilise the port until the window is reloaded.
   * Ports of worktrees that DID get stored are released by removing them.
   */
  release(port: number): void {
    this.reserved.delete(port);
    void this.options.shared?.release(port);
  }
}
