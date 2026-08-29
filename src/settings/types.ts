import type { RepoScopedKey } from '../config/RepoConfig';
import type { ProviderId } from '../ports/IAgentProvider';
import type { UnmessConfig } from '../types';

export type Stack = 'node' | 'php' | 'python' | 'go';

/** What a look at the repository suggests, so the panel can prefill rather than ask. */
export interface Detection {
  /** Compose files at the repo root, base files before overrides. */
  composeFiles: string[];
  /** `${HTTP_PORT}`-style variables named like ports, across those files. */
  portVars: string[];
  stack?: Stack;
  setupScript?: string;
  teardownScript?: string;
}

/** The repository's own settings — what `.unmess/config.json` carries. */
export type ProjectValues = Pick<UnmessConfig, RepoScopedKey>;

/** The settings that belong to the person, not the repository. */
export type UserValues = Pick<
  UnmessConfig,
  | 'defaultProvider'
  | 'claudeCommand'
  | 'codexCommand'
  | 'grokCommand'
  | 'opencodeCommand'
  | 'notifyOnAttention'
  | 'focusMode'
  | 'scopeSearchToActiveWorktree'
>;

export interface SettingsSnapshot {
  repoRoot?: string;
  project: ProjectValues;
  projectFile: { path?: string; present: boolean; problems: string[] };
  /**
   * Repo-scoped keys the user has set in their own settings.json. Those win
   * over the file, so a value saved here would not take effect for them until
   * the override goes — the panel says so instead of looking broken.
   */
  personalOverrides: RepoScopedKey[];
  user: UserValues;
  installedProviders: ProviderId[];
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
  | { type: 'openProjectFile' };

/** Extension → panel. */
export type SettingsExtMessage =
  | { type: 'snapshot'; snapshot: SettingsSnapshot }
  | { type: 'picked'; field: FileField; path: string }
  | { type: 'saved'; scope: 'project' | 'user'; problems: string[] };
