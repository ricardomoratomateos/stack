import type { StackConfig } from '../types';
import type { ProviderId } from '../ports/IAgentProvider';

/**
 * Where the worktree layer reads its settings from. `stackd`'s NodeConfig is
 * the implementation; tests pass plain objects.
 */
export interface ConfigSource {
  get(): StackConfig;
  /** Persist the primary agent. Optional: a source that cannot write settings leaves it out. */
  setDefaultProvider?(provider: ProviderId): Promise<void>;
}
