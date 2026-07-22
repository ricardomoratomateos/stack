/** Registered coding-agent providers. Extend this list to add a new provider. */
export const PROVIDER_IDS = ['claude', 'opencode'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** True when a tmux window name belongs to an agent window (windows are named after the provider id). */
export function isAgentWindowName(name: string): boolean {
  return PROVIDER_IDS.some((id) => name.startsWith(id));
}

/** Resolve the provider that owns a tmux window name, if any. */
export function providerForWindowName(name: string): ProviderId | undefined {
  return PROVIDER_IDS.find((id) => name.startsWith(id));
}

/**
 * Strategy for one coding agent (Claude Code, opencode, ...). Encapsulates
 * everything provider-specific: how to launch it inside a tmux window and how
 * to wire its hook/plugin system so it reports state changes to the HookServer.
 */
export interface IAgentProvider {
  readonly id: ProviderId;
  /** Human-readable name, e.g. "Claude Code". */
  readonly label: string;
  /** Full shell command to launch the agent in a worktree's tmux window. */
  buildCommand(worktreeId: string, initialPrompt?: string): string;
  /** Wire the provider's hook/plugin system to POST state events to hookUrl. */
  installHooks(hookUrl: string): void;
  uninstallHooks(): void;
}
