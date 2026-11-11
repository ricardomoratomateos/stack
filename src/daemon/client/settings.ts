/** The settings `stackd` reads (NodeConfig), by their `stack.*` names in VS Code. */
export const DAEMON_SETTING_KEYS = [
  'worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'setupInTerminal', 'teardownScript',
  'defaultProvider', 'promptPrefix', 'claudeCommand', 'codexCommand', 'opencodeCommand',
  'notifyOnAttention', 'scopeSearchToActiveWorktree', 'focusMode', 'sessionTabs', 'sidebarStyle',
  'docker', 'debugBasePort', 'debugTemplate',
] as const;

interface Inspected { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }

/**
 * What the user set explicitly in VS Code (never the shipped defaults, which
 * would shadow `.stack/config.json`), narrowest scope first, ready for the
 * daemon's `setSettings`.
 */
export function explicitUserSettings(inspect: (key: string) => Inspected | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DAEMON_SETTING_KEYS) {
    const seen = inspect(key);
    const value = seen?.workspaceFolderValue ?? seen?.workspaceValue ?? seen?.globalValue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Only the extension's own keys of a Memento, for the daemon's one-time `importState`. */
export function stackKeys(memento: { keys(): readonly string[]; get<T>(key: string): T | undefined }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of memento.keys()) {
    if (!key.startsWith('stack.')) continue;
    const value = memento.get<unknown>(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}
