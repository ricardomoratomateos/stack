/** Registered coding-agent providers. Extend this list to add a new provider. */
export const PROVIDER_IDS = ['claude', 'opencode'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Whether `v` names a provider this build knows. Persisted state and settings
 * can carry an id from an older version (a removed provider such as
 * "codex"); readers check with this and treat anything else as no provider.
 */
export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);
}

/**
 * How to get each agent, shown when its configured command is not on PATH.
 * Package names verified against the npm registry, so every instruction is
 * one copyable line of the same shape.
 */
export const PROVIDER_INSTALL: Record<ProviderId, { label: string; install: string }> = {
  claude:   { label: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code' },
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
   *
   * Carries STACK_WORKSPACE_ID and, once installHooks() has run,
   * STACK_HOOK_URL — and claims the worktree's hook route for this window
   * (see HookRoutes), because the launch waits on the agent's first hook.
   */
  buildCommand(worktreeId: string): string;
  /**
   * What to append to buildCommand() to continue the conversation `sessionId`
   * (the `session_id` its hooks report) instead of starting a new one. Absent
   * for an agent that cannot resume one, which is then not offered a resume.
   * `sessionId` is validated by the caller (letters, digits, `._-`).
   */
  resumeArgs?(sessionId: string): string;
  /** Wire the provider's hook/plugin system to POST state events to hookUrl. */
  installHooks(hookUrl: string): void;
  uninstallHooks(): void;
  /** Whether the hooks are in place, read from the agent's config without touching it (stackd doctor). */
  hookStatus?(): HookStatus;
}

/** What `hookStatus()` found in an agent's hook config. */
export interface HookStatus {
  /** The agent's config file (or plugin) Stack writes into. */
  file: string;
  /** What is not there: events without Stack's command, `notify.sh`, `plugin`. */
  missing: string[];
  /** Stack hook commands pointing at another notify.sh (the VS Code extension's). */
  stale: string[];
  /** The file could not be read (a syntax error): nothing else is known. */
  error?: string;
}
