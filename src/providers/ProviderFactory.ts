import * as path from 'node:path';
import * as os from 'node:os';
import { IAgentProvider, PROVIDER_IDS, ProviderId } from '../ports/IAgentProvider';
import { ClaudeProvider, ConfigSource, type WorkerMcpSource } from './claude/ClaudeProvider';
import { ClaudeHookInstaller } from './claude/ClaudeHookInstaller';
import { OpenCodeProvider } from './opencode/OpenCodeProvider';
import { OpenCodeHookInstaller } from './opencode/OpenCodeHookInstaller';
import { CLAUDE_SETTINGS_PATH, OPENCODE_PLUGIN_PATH } from '../constants';

/** Builds (and caches) one strategy instance per registered provider. */
export class ProviderFactory {
  private cache = new Map<ProviderId, IAgentProvider>();

  constructor(
    private config: ConfigSource,
    private storagePath: string,
    private homeDir: string = os.homedir(),
    /** The Stack MCP bridge for workers (Claude); opencode is started without it. */
    private workerMcp: WorkerMcpSource = () => undefined,
  ) {}

  create(id: ProviderId): IAgentProvider {
    let provider = this.cache.get(id);
    if (!provider) {
      provider = this.build(id);
      this.cache.set(id, provider);
    }
    return provider;
  }

  /** The provider selected by `stack.defaultProvider`. */
  defaultProvider(): IAgentProvider {
    return this.create(this.config.get().defaultProvider);
  }

  all(): IAgentProvider[] {
    return PROVIDER_IDS.map((id) => this.create(id));
  }

  private build(id: ProviderId): IAgentProvider {
    switch (id) {
      case 'claude':
        return new ClaudeProvider(
          this.config,
          new ClaudeHookInstaller(this.storagePath, path.join(this.homeDir, CLAUDE_SETTINGS_PATH)),
          this.workerMcp,
        );
      case 'opencode':
        return new OpenCodeProvider(
          this.config,
          new OpenCodeHookInstaller(this.storagePath, path.join(this.homeDir, OPENCODE_PLUGIN_PATH)),
        );
      default:
        // An id from older persisted state (a removed provider) that slipped
        // past validation: a clear error instead of an undefined provider.
        throw new Error(`Unknown provider "${String(id)}".`);
    }
  }
}
