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

  buildCommand(worktreeId: string): string {
    return `FOREMAN_WORKSPACE_ID="${worktreeId}" ${this.config.get().grokCommand}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
