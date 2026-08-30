import type { IAgentProvider } from '../../ports/IAgentProvider';
import type { ForemanConfig } from '../../types';
import type { ClaudeHookInstaller } from './ClaudeHookInstaller';

/** Anything exposing the extension configuration (structural ConfigManager). */
export interface ConfigSource {
  get(): ForemanConfig;
}

export class ClaudeProvider implements IAgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';

  constructor(
    private config: ConfigSource,
    private hooks: ClaudeHookInstaller,
  ) {}

  buildCommand(worktreeId: string): string {
    return `FOREMAN_WORKSPACE_ID="${worktreeId}" ${this.config.get().claudeCommand}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
