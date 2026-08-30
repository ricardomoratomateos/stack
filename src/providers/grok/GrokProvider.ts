import type { IAgentProvider } from '../../ports/IAgentProvider';
import type { ConfigSource } from '../claude/ClaudeProvider';
import type { GrokHookInstaller } from './GrokHookInstaller';

export class GrokProvider implements IAgentProvider {
  readonly id = 'grok' as const;
  readonly label = 'Grok Build';

  constructor(
    private config: ConfigSource,
    private hooks: GrokHookInstaller,
  ) {}

  buildCommand(worktreeId: string, initialPrompt?: string): string {
    const command = this.config.get().grokCommand;
    // `-p` seeds the first prompt while staying in the interactive TUI, which is
    // what the viewer terminal shows. (Headless mode is a different flag set.)
    const cmd = initialPrompt ? `${command} -p "${initialPrompt.replace(/"/g, '\\"')}"` : command;
    return `FOREMAN_WORKSPACE_ID="${worktreeId}" ${cmd}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
