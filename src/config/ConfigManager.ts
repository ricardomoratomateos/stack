import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StackConfig, DebugTemplate, DockerConfig } from '../types';
import type { ProviderId } from '../ports/IAgentProvider';
import { normalizeSidebarStyle } from '../sidebarStyle';
import {
  RepoConfigResult,
  RepoConfigValues,
  RepoScopedKey,
  readRepoConfig,
  REPO_CONFIG_RELATIVE,
} from './RepoConfig';

const DOCKER_DEFAULTS: DockerConfig = {
  composeFile: 'docker-compose.yml',
  overrideFile: 'docker-compose.worktree.yml',
  ports: [],
  basePort: 20000,
  portStride: 100,
};

/**
 * The launch configuration written into each worktree, with its own port in it.
 *
 * Node because the default has to be something and node is the likeliest, not
 * because any of this knows what node is: the template is passed through whole,
 * so a repo that debugs PHP, Python or Go replaces it with its own and every
 * part downstream — the port slot, the collision probe, the regenerated
 * launch.json — behaves identically. The README carries an Xdebug example.
 */
const DEBUG_TEMPLATE_DEFAULT: DebugTemplate = {
  type: 'node',
  request: 'attach',
  name: 'Stack: Debug',
  port: '{{PORT}}',
};

/**
 * What a repository gets when neither its file nor the user says otherwise.
 * One table, read by get() and projectValues() alike, so the two can never
 * disagree about what "unset" means.
 */
const PROJECT_DEFAULTS: Pick<StackConfig, RepoScopedKey> = {
  worktreesDirectory: '.worktrees',
  defaultBaseBranch: 'develop',
  setupScript: '',
  setupInTerminal: false,
  teardownScript: '',
  docker: DOCKER_DEFAULTS,
  debugBasePort: 9898,
  debugTemplate: DEBUG_TEMPLATE_DEFAULT,
};

const NO_REPO_CONFIG: RepoConfigResult = { values: {}, present: false, problems: [] };

export type ConfigManagerOptions = {
  /** Repository root to look for `.stack/config.json` in, resolved per read. */
  repoRoot?: () => string | undefined;
  /** Called when the repo config's complaints change. Never on every read. */
  onProblems?: (problems: string[]) => void;
};

export class ConfigManager {
  private cache?: { key: string; result: RepoConfigResult };

  private reported = '';

  constructor(private options: ConfigManagerOptions = {}) {}

  /**
   * Persist the primary agent, so the card's "change primary…" does not send
   * the user to settings.json. Global scope: which agent you reach for is a
   * property of you, not of the repository you happen to have open.
   */
  async setDefaultProvider(provider: ProviderId): Promise<void> {
    await vscode.workspace
      .getConfiguration('stack')
      .update('defaultProvider', provider, vscode.ConfigurationTarget.Global);
  }

  /**
   * Save the user's own settings from the settings panel: only what changed,
   * and to the layer where it will actually take effect.
   *
   * The panel sends every field, and this used to write every one of them to
   * the global settings.json — filling it with copies of the defaults, which
   * then pinned the user to today's defaults forever — and to write there even
   * when a workspace-level value for the same key outranks the global one, so
   * the save "succeeded" and nothing changed. Now:
   *
   * - a key whose value is what VS Code already resolves is not written at all;
   * - a key the workspace sets is written to the workspace, which is the value
   *   in force here (the user chose to put it there; moving it is not ours);
   * - a key set back to its default is removed from the global layer rather
   *   than written out as an explicit copy of the default.
   */
  async saveUserValues(values: Record<string, unknown>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('stack');
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || sameValue(cfg.get(key), value)) continue;
      const seen = cfg.inspect?.(key);
      if (seen?.workspaceValue !== undefined) {
        await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
        continue;
      }
      const backToDefault = seen?.defaultValue !== undefined && sameValue(seen.defaultValue, value);
      await cfg.update(key, backToDefault ? undefined : value, vscode.ConfigurationTarget.Global);
    }
  }

  /** Complaints from the repo config as of the last read; empty when happy. */
  repoConfigProblems(): string[] {
    return this.repoConfig().problems;
  }

  /** Absolute path of the repo config, whether or not it exists. */
  repoConfigPath(): string | undefined {
    const root = this.options.repoRoot?.();
    return root ? path.join(root, REPO_CONFIG_RELATIVE) : undefined;
  }

  get(): StackConfig {
    const cfg = vscode.workspace.getConfiguration('stack');
    const repo = this.repoConfig().values;

    return {
      worktreesDirectory: this.pick(cfg, repo, 'worktreesDirectory', PROJECT_DEFAULTS.worktreesDirectory),
      defaultBaseBranch: this.pick(cfg, repo, 'defaultBaseBranch', PROJECT_DEFAULTS.defaultBaseBranch),
      setupScript: this.pick(cfg, repo, 'setupScript', PROJECT_DEFAULTS.setupScript),
      setupInTerminal: this.pick(cfg, repo, 'setupInTerminal', PROJECT_DEFAULTS.setupInTerminal),
      teardownScript: this.pick(cfg, repo, 'teardownScript', PROJECT_DEFAULTS.teardownScript),
      defaultProvider: cfg.get<ProviderId>('defaultProvider', 'claude'),
      claudeCommand: cfg.get<string>('claudeCommand', 'claude'),
      codexCommand: cfg.get<string>('codexCommand', 'codex'),
      opencodeCommand: cfg.get<string>('opencodeCommand', 'opencode'),
      notifyOnAttention: cfg.get<boolean>('notifyOnAttention', true),
      scopeSearchToActiveWorktree: cfg.get<boolean>('scopeSearchToActiveWorktree', true),
      focusMode: cfg.get<boolean>('focusMode', false),
      // Anything but the legacy value is the default: a typo in settings.json
      // should not silently cost the user their tabs.
      sessionTabs: cfg.get<string>('sessionTabs', 'perSession') === 'single' ? 'single' : 'perSession',
      sidebarStyle: normalizeSidebarStyle(cfg.get<string>('sidebarStyle')),
      // Object settings get no deep merge from VSCode and none from the repo
      // file either, so all three layers are folded key by key. A repo naming
      // only its compose file must not reset basePort to the default.
      docker: this.pickDocker(cfg, repo),
      debugBasePort: this.pick(cfg, repo, 'debugBasePort', PROJECT_DEFAULTS.debugBasePort),
      debugTemplate: this.pick(cfg, repo, 'debugTemplate', PROJECT_DEFAULTS.debugTemplate),
    };
  }

  /**
   * The repository's settings as the repository alone defines them: the file
   * over the shipped defaults, with the user's own overrides left OUT.
   *
   * This is what the project form edits and therefore what it writes back. It
   * used to be seeded from get(), which already has the user's settings.json
   * folded in — so opening the panel and saving lifted one person's docker
   * ports, worktree directory or debug port into the committed file, to be
   * imposed on everyone who pulls. The overrides are listed separately
   * (personalOverrides) so the panel can say why what runs differs from this.
   */
  projectValues(): Pick<StackConfig, RepoScopedKey> {
    const repo = this.repoConfig().values;
    return {
      worktreesDirectory: repo.worktreesDirectory ?? PROJECT_DEFAULTS.worktreesDirectory,
      defaultBaseBranch: repo.defaultBaseBranch ?? PROJECT_DEFAULTS.defaultBaseBranch,
      setupScript: repo.setupScript ?? PROJECT_DEFAULTS.setupScript,
      setupInTerminal: repo.setupInTerminal ?? PROJECT_DEFAULTS.setupInTerminal,
      teardownScript: repo.teardownScript ?? PROJECT_DEFAULTS.teardownScript,
      // Key by key, as in get(): a file naming only its compose file keeps the
      // default ports and stride rather than losing them.
      docker: { ...DOCKER_DEFAULTS, ...repo.docker },
      debugBasePort: repo.debugBasePort ?? PROJECT_DEFAULTS.debugBasePort,
      debugTemplate: repo.debugTemplate ?? PROJECT_DEFAULTS.debugTemplate,
    };
  }

  /**
   * Explicit user setting > repo config > shipped default.
   *
   * The user's own settings.json wins because they are the one sitting there and
   * a cloned repository does not get to override a deliberate local choice. But
   * only an EXPLICIT setting counts: `cfg.get` cannot tell a user who typed
   * "develop" from a user who typed nothing and got the default, and treating
   * the default as a choice would make the repo file unreachable for every key
   * that has one — which is all of them. inspect() is what draws that line.
   */
  private pick<K extends keyof RepoConfigValues>(
    cfg: vscode.WorkspaceConfiguration,
    repo: RepoConfigValues,
    key: K,
    fallback: NonNullable<RepoConfigValues[K]>,
  ): NonNullable<RepoConfigValues[K]> {
    const explicit = this.explicit<NonNullable<RepoConfigValues[K]>>(cfg, key);
    if (explicit !== undefined) return explicit;
    return (repo[key] as NonNullable<RepoConfigValues[K]> | undefined) ?? fallback;
  }

  private explicit<T>(cfg: vscode.WorkspaceConfiguration, key: string): T | undefined {
    // inspect() is absent from some test doubles; a missing one just means
    // "nothing set explicitly", which is the correct reading for a bare stub.
    const seen = cfg.inspect?.<T>(key);
    return seen?.workspaceFolderValue ?? seen?.workspaceValue ?? seen?.globalValue;
  }

  private pickDocker(cfg: vscode.WorkspaceConfiguration, repo: RepoConfigValues): DockerConfig {
    const user = this.explicit<Partial<DockerConfig>>(cfg, 'docker') ?? {};
    const fromRepo = repo.docker ?? {};
    const merged = { ...DOCKER_DEFAULTS, ...fromRepo, ...strip(user) };
    return merged;
  }

  /**
   * Reads the repo config, reusing the last parse while the file is untouched.
   *
   * get() is called on every webview push, so this must not be a JSON parse per
   * call; a stat is. Keyed on mtime and size rather than a watcher because the
   * file is edited by hand and by `git checkout` alike, and a watcher would miss
   * the branch switch that is the interesting case.
   */
  private repoConfig(): RepoConfigResult {
    const root = this.options.repoRoot?.();
    if (!root) return NO_REPO_CONFIG;
    const file = path.join(root, REPO_CONFIG_RELATIVE);

    // Fields joined on a NUL, which no path can contain, so no combination of
    // path and numbers can spell another one's key. Written as an escape rather
    // than the raw byte: a literal NUL makes the whole file binary to grep and
    // to git diff, and this one silently hid itself from a repo-wide rename.
    let key: string;
    try {
      const stat = fs.statSync(file);
      key = `${file}\u0000${stat.mtimeMs}\u0000${stat.size}`;
    } catch {
      key = `${file}\u0000absent`;
    }
    if (this.cache?.key === key) return this.cache.result;

    const result = readRepoConfig(root);
    this.cache = { key, result };

    // Announced only when the complaints themselves change: this is reached
    // whenever the file is edited, and a repeated toast for a typo the user has
    // already seen is how people learn to ignore the toast.
    const signature = result.problems.join('\n');
    if (signature !== this.reported) {
      this.reported = signature;
      if (result.problems.length > 0) this.options.onProblems?.(result.problems);
    }
    return result;
  }
}

/** Structural equality for settings values (plain JSON: strings, numbers, objects). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Drops undefined values so a partial object does not blank out lower layers. */
function strip<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
