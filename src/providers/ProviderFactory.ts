import * as path from 'node:path';
import * as os from 'node:os';
import { IAgentProvider, PROVIDER_IDS, ProviderId } from '../ports/IAgentProvider';
import { ClaudeProvider, ConfigSource } from './claude/ClaudeProvider';
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
  ) {}

  create(id: ProviderId): IAgentProvider {
    let provider = this.cache.get(id);
    if (!provider) {
      provider = this.build(id);
      this.cache.set(id, provider);
    }
    return provider;
  }

  /** The provider selected by `unmess.defaultProvider`. */
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
        );
      case 'opencode':
        return new OpenCodeProvider(
          this.config,
          new OpenCodeHookInstaller(path.join(this.homeDir, OPENCODE_PLUGIN_PATH)),
        );
    }
  }
}
