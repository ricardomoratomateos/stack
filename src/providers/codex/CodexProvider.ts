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

  buildCommand(worktreeId: string): string {
    return `FOREMAN_WORKSPACE_ID="${worktreeId}" ${this.config.get().codexCommand}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
