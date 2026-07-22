import type { IAgentProvider } from '../../ports/IAgentProvider';
import type { ConfigSource } from '../claude/ClaudeProvider';
import type { OpenCodeHookInstaller } from './OpenCodeHookInstaller';

export class OpenCodeProvider implements IAgentProvider {
  readonly id = 'opencode' as const;
  readonly label = 'opencode';

  constructor(
    private config: ConfigSource,
    private hooks: OpenCodeHookInstaller,
  ) {}

  buildCommand(worktreeId: string, initialPrompt?: string): string {
    const command = this.config.get().opencodeCommand;
    // The root command starts the TUI; --prompt seeds it with an initial message.
    const cmd = initialPrompt ? `${command} --prompt "${initialPrompt.replace(/"/g, '\\"')}"` : command;
    return `UNMESS_WORKSPACE_ID="${worktreeId}" ${cmd}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
