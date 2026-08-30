/** Registered coding-agent providers. Extend this list to add a new provider. */
export const PROVIDER_IDS = ['claude', 'codex', 'grok', 'opencode'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * How to get each agent, shown when its configured command is not on PATH.
 * Package names verified against the npm registry; Grok also ships a shell
 * installer (`curl -fsSL https://x.ai/cli/install.sh | bash`), but npm is used
 * here so all four instructions are one copyable line of the same shape.
 */
export const PROVIDER_INSTALL: Record<ProviderId, { label: string; install: string }> = {
  claude:   { label: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code' },
  codex:    { label: 'Codex CLI',   install: 'npm i -g @openai/codex' },
  grok:     { label: 'Grok Build',  install: 'npm i -g @xai-official/grok' },
  opencode: { label: 'opencode',    install: 'npm i -g opencode-ai' },
};

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
  /**
   * Full shell command to launch the agent in a worktree's tmux window.
   *
   * Deliberately takes no prompt. tmux runs this string through `sh -c`, so a
   * prompt embedded here is expanded before the agent ever sees it: `${...}`
   * aborts the whole command and the agent never starts, and backticks silently
   * substitute away the text they wrap — which is every code line the review
   * panel attaches. Prompts are pasted into the running agent instead.
   */
  buildCommand(worktreeId: string): string;
  /** Wire the provider's hook/plugin system to POST state events to hookUrl. */
  installHooks(hookUrl: string): void;
  uninstallHooks(): void;
}
