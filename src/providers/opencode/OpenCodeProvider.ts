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

  buildCommand(worktreeId: string): string {
    return `${this.hooks.launchEnv(worktreeId)} ${this.config.get().opencodeCommand}`;
  }

  /** `opencode --session <id>` (`-s`): continue that session; the plugin reports its `ses_…` id. */
  resumeArgs(sessionId: string): string {
    return `--session ${sessionId}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
