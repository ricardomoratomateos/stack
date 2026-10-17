import type { RepoScopedKey } from '../config/RepoConfig';
import type { ProviderId } from '../ports/IAgentProvider';
import type { StackConfig } from '../types';

export type Stack = 'node' | 'php' | 'python' | 'go';

/** What a look at the repository suggests, so the panel can prefill rather than ask. */
export interface Detection {
  /**
   * Compose files at the repo root and in the usual folders (docker/, deploy/,
   * .docker/…), repo-relative, shallowest and base files first.
   */
  composeFiles: string[];
  /** The one to use as the compose file. */
  composeBase?: string;
  /** A sibling named as a worktree/override file, if there is one. */
  composeOverride?: string;
  /** `${HTTP_PORT}`-style variables named like ports, across those files. */
  portVars: string[];
  stack?: Stack;
  setupScript?: string;
  teardownScript?: string;
}

/** The repository's own settings — what `.stack/config.json` carries. */
export type ProjectValues = Pick<StackConfig, RepoScopedKey>;

/** The settings that belong to the person, not the repository. */
export type UserValues = Pick<
  StackConfig,
  | 'defaultProvider'
  | 'claudeCommand'
  | 'codexCommand'
  | 'opencodeCommand'
  | 'notifyOnAttention'
  | 'focusMode'
  | 'sidebarStyle'
  | 'sessionTabs'
  | 'scopeSearchToActiveWorktree'
>;

export interface SettingsSnapshot {
  repoRoot?: string;
  project: ProjectValues;
  projectFile: {
    path?: string;
    /** The file in use relative to the repo: `.stack/config.json`, or a legacy `.foreman/config.json`. */
    relative: string;
    /** True while it is the legacy `.foreman/config.json` that is read (and saved to). */
    legacy: boolean;
    present: boolean;
    problems: string[];
  };
  /**
   * Repo-scoped keys the user has set in their own settings.json. Those win
   * over the file, so a value saved here would not take effect for them until
   * the override goes — the panel says so instead of looking broken.
   */
  personalOverrides: RepoScopedKey[];
  user: UserValues;
  installedProviders: ProviderId[];
  /** Whether the Stack MCP server is registered with Claude Code (user scope) — the manager switch. */
  managerEnabled: boolean;
  branches: string[];
  detected: Detection;
}

export type FileField = 'setupScript' | 'teardownScript' | 'composeFile' | 'overrideFile';

/** Panel → extension. */
export type SettingsMessage =
  | { type: 'ready' }
  | { type: 'pickFile'; field: FileField }
  | { type: 'createScript'; kind: 'setup' | 'teardown' }
  | { type: 'saveProject'; values: ProjectValues }
  | { type: 'saveUser'; values: UserValues }
  | { type: 'clearPersonalOverrides' }
  | { type: 'openProjectFile' }
  /** Register or remove the Stack MCP server with Claude Code. Takes effect at once; not part of a save. */
  | { type: 'setManager'; enabled: boolean };

/** Extension → panel. */
export type SettingsExtMessage =
  | { type: 'snapshot'; snapshot: SettingsSnapshot }
  | { type: 'picked'; field: FileField; path: string }
  | { type: 'saved'; scope: 'project' | 'user'; problems: string[] };
