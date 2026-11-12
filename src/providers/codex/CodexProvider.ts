import type { HookStatus, IAgentProvider } from '../../ports/IAgentProvider';
import type { ConfigSource, WorkerMcpSource } from '../claude/ClaudeProvider';
import type { CodexHookInstaller } from './CodexHookInstaller';
import { codexMcpArgs } from '../../mcp/workerMcp';

export class CodexProvider implements IAgentProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';

  constructor(
    private config: ConfigSource,
    private hooks: CodexHookInstaller,
    private mcp: WorkerMcpSource,
  ) {}

  /** Same Stack MCP server as Claude's workers, as `-c mcp_servers.stack.*` overrides. */
  buildCommand(worktreeId: string): string {
    const bridge = this.mcp();
    const command = `${this.hooks.launchEnv(worktreeId)} ${this.config.get().codexCommand}`;
    return bridge ? `${command} ${codexMcpArgs(bridge, worktreeId)}` : command;
  }

  /**
   * `codex resume <SESSION_ID>`: a subcommand, so it goes last, after the
   * global `-c` overrides buildCommand ends with, which apply to it too.
   */
  resumeArgs(sessionId: string): string {
    return `resume ${sessionId}`;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }

  hookStatus(): HookStatus {
    return this.hooks.status();
  }
}
