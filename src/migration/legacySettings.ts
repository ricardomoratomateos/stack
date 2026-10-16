import * as vscode from 'vscode';

/**
 * Carrying the user's settings over from Foreman, the name this extension
 * had before it was Stack.
 *
 * Every setting moved from `foreman.*` to `stack.*`. VS Code does not rename
 * a configuration section for us: the old keys stay in settings.json, now
 * unregistered and read by nothing, and without this the first activation of
 * Stack would quietly drop a user back to every default — their worktree
 * folder, scripts, docker ports, preferred agent.
 *
 * So, once, each value the user set EXPLICITLY under `foreman.*` is copied to
 * the same key under `stack.*`, at the same level it was set at (user,
 * workspace, or a folder of a multi-root workspace) — unless `stack.*` already
 * has a value there, which is a choice made since and wins. Nothing is ever
 * deleted: the old keys are the user's to remove, and a rollback to Foreman
 * still finds them.
 */

export const LEGACY_SETTINGS_SECTION = 'foreman';
export const SETTINGS_SECTION = 'stack';

/** globalState: the user-level settings have been carried over. */
export const GLOBAL_SETTINGS_MIGRATED_KEY = 'stack.migration.globalSettings';
/** workspaceState: this workspace's (and its folders') settings have been carried over. */
export const WORKSPACE_SETTINGS_MIGRATED_KEY = 'stack.migration.workspaceSettings';

/**
 * Every setting the extension contributes, by its key under the section.
 * A test holds this to package.json's `contributes.configuration`, so a new
 * setting cannot be forgotten here.
 */
export const SETTING_KEYS = [
  'worktreesDirectory',
  'defaultBaseBranch',
  'setupScript',
  'teardownScript',
  'defaultProvider',
  'claudeCommand',
  'codexCommand',
  'opencodeCommand',
  'sidebarStyle',
  'notifyOnAttention',
  'focusMode',
  'sessionTabs',
  'scopeSearchToActiveWorktree',
  'docker',
  'debugBasePort',
  'debugTemplate',
] as const;

export type SettingsLevel = 'global' | 'workspace' | 'workspaceFolder';

/** What one key holds at each level, as `WorkspaceConfiguration.inspect` reports it. */
export interface InspectedSetting {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** The slice of the VS Code configuration API the migration needs. */
export interface SettingsHost {
  inspect(section: string, key: string, folder?: vscode.Uri): InspectedSetting | undefined;
  update(section: string, key: string, value: unknown, level: SettingsLevel, folder?: vscode.Uri): Thenable<void>;
  /** A workspace (or folder) is open, so workspace-level settings exist at all. */
  hasWorkspace(): boolean;
  /**
   * Folders whose settings are their own: those of a multi-root workspace.
   * In a single-folder window the folder's settings ARE the workspace's, and
   * migrating them twice would only write the same file twice.
   */
  separateFolders(): vscode.Uri[];
}

/** One value carried over, for the notice and the log. */
export interface MigratedSetting {
  key: string;
  level: SettingsLevel;
  folder?: string;
}

const VALUE_AT: Record<SettingsLevel, keyof InspectedSetting> = {
  global: 'globalValue',
  workspace: 'workspaceValue',
  workspaceFolder: 'workspaceFolderValue',
};

const TARGET: Record<SettingsLevel, vscode.ConfigurationTarget> = {
  global: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
};

/** The live VS Code configuration, as a SettingsHost. */
export function vscodeSettingsHost(): SettingsHost {
  return {
    inspect: (section, key, folder) => vscode.workspace.getConfiguration(section, folder).inspect(key),
    update: (section, key, value, level, folder) =>
      vscode.workspace.getConfiguration(section, folder).update(key, value, TARGET[level]),
    hasWorkspace: () => (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
    separateFolders: () =>
      vscode.workspace.workspaceFile ? (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri) : [],
  };
}

/**
 * Copies what is set under `foreman.*` to `stack.*`, once per level: the
 * user level once per machine (globalState), the workspace levels once per
 * workspace (workspaceState) — a workspace opened for the first time after
 * the upgrade still has its own `.vscode/settings.json` to carry over.
 *
 * A value that cannot be written (a read-only settings file, a setting that
 * does not accept that level) is skipped, never fatal: activation must not
 * fail over a migration.
 */
export async function migrateLegacySettings(
  host: SettingsHost,
  globalState: vscode.Memento,
  workspaceState: vscode.Memento,
): Promise<MigratedSetting[]> {
  const migrated: MigratedSetting[] = [];

  const copy = async (level: SettingsLevel, folder?: vscode.Uri): Promise<void> => {
    for (const key of SETTING_KEYS) {
      const old = host.inspect(LEGACY_SETTINGS_SECTION, key, folder)?.[VALUE_AT[level]];
      if (old === undefined) continue;
      // Read fresh for every key: a stack.* value set since — by hand, or by
      // an earlier level of this very run writing the same file — wins.
      if (host.inspect(SETTINGS_SECTION, key, folder)?.[VALUE_AT[level]] !== undefined) continue;
      try {
        await host.update(SETTINGS_SECTION, key, old, level, folder);
        migrated.push({ key: `${SETTINGS_SECTION}.${key}`, level, ...(folder ? { folder: folder.fsPath } : {}) });
      } catch (e) {
        console.warn(`[stack] could not carry ${LEGACY_SETTINGS_SECTION}.${key} over (${level}):`, e);
      }
    }
  };

  if (!globalState.get<boolean>(GLOBAL_SETTINGS_MIGRATED_KEY)) {
    await copy('global');
    await globalState.update(GLOBAL_SETTINGS_MIGRATED_KEY, true);
  }

  if (host.hasWorkspace() && !workspaceState.get<boolean>(WORKSPACE_SETTINGS_MIGRATED_KEY)) {
    await copy('workspace');
    for (const folder of host.separateFolders()) await copy('workspaceFolder', folder);
    await workspaceState.update(WORKSPACE_SETTINGS_MIGRATED_KEY, true);
  }

  return migrated;
}
