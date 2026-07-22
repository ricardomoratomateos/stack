import type { IAgentProvider } from '../../ports/IAgentProvider';
import type { UnmessConfig } from '../../types';
import type { ClaudeHookInstaller } from './ClaudeHookInstaller';

/** Anything exposing the extension configuration (structural ConfigManager). */
export interface ConfigSource {
  get(): UnmessConfig;
}

export class ClaudeProvider implements IAgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';

  constructor(
    private config: ConfigSource,
    private hooks: ClaudeHookInstaller,
  ) {}

  buildCommand(worktreeId: string, initialPrompt?: string): string {
    const command = this.config.get().claudeCommand;
    const cmd = initialPrompt ? `${command} "${initialPrompt.replace(/"/g, '\\"')}"` : command;
    return `UNMESS_WORKSPACE_ID="${worktreeId}" ${cmd}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
