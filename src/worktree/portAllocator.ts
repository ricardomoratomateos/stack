import { IWorktreeRepository } from '../ports/IWorktreeRepository';

/** The only slice of the repository the allocator needs. */
type PortRegistryReader = Pick<IWorktreeRepository, 'getPortRegistry'>;

export class PortAllocator {
  private store: PortRegistryReader;
  private basePort: number;

  constructor(store: PortRegistryReader, basePort: number) {
    this.store = store;
    this.basePort = basePort;
  }

  allocate(): number {
    const used = new Set(Object.values(this.store.getPortRegistry()));
    let port = this.basePort + 1;
    while (used.has(port)) {
      port++;
    }
    return port;
  }

  release(_port: number): void {
    // ports are released automatically when the worktree is removed from the store
  }
}
