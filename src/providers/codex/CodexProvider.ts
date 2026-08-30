import type { IAgentProvider } from '../../ports/IAgentProvider';
import type { ConfigSource } from '../claude/ClaudeProvider';
import type { CodexHookInstaller } from './CodexHookInstaller';

export class CodexProvider implements IAgentProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';

  constructor(
    private config: ConfigSource,
    private hooks: CodexHookInstaller,
  ) {}

  buildCommand(worktreeId: string, initialPrompt?: string): string {
    const command = this.config.get().codexCommand;
    // Codex takes the first prompt as a bare positional argument, like Claude.
    const cmd = initialPrompt ? `${command} "${initialPrompt.replace(/"/g, '\\"')}"` : command;
    return `FOREMAN_WORKSPACE_ID="${worktreeId}" ${cmd}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
