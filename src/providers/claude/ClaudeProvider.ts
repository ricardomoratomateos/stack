import type { IAgentProvider } from '../../ports/IAgentProvider';
import type { StackConfig } from '../../types';
import type { ClaudeHookInstaller } from './ClaudeHookInstaller';
import { claudeMcpArgs, type BridgeCommand } from '../../mcp/workerMcp';

/** The Stack MCP bridge to hand each worker, once it is installed; undefined until then. */
export type WorkerMcpSource = () => BridgeCommand | undefined;

/** Anything exposing the extension configuration (structural ConfigManager). */
export interface ConfigSource {
  get(): StackConfig;
}

export class ClaudeProvider implements IAgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';

  constructor(
    private config: ConfigSource,
    private hooks: ClaudeHookInstaller,
    private mcp: WorkerMcpSource,
  ) {}

  /** With the bridge installed, the worker gets the Stack MCP server for its own task (stack_env, stack_request_review). */
  buildCommand(worktreeId: string): string {
    const bridge = this.mcp();
    const command = `${this.hooks.launchEnv(worktreeId)} ${this.config.get().claudeCommand}`;
    return bridge ? `${command} ${claudeMcpArgs(bridge, worktreeId)}` : command;
  }

  installHooks(hookUrl: string): void {
    this.hooks.install(hookUrl);
  }

  uninstallHooks(): void {
    this.hooks.uninstall();
  }
}
