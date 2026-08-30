import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ForemanConfig, DebugTemplate, DockerConfig } from '../types';
import type { ProviderId } from '../ports/IAgentProvider';
import {
  REPO_CONFIG_RELATIVE,
  RepoConfigResult,
  RepoConfigValues,
  readRepoConfig,
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
  name: 'Foreman: Debug',
  port: '{{PORT}}',
};

const NO_REPO_CONFIG: RepoConfigResult = { values: {}, present: false, problems: [] };

export type ConfigManagerOptions = {
  /** Repository root to look for `.foreman/config.json` in, resolved per read. */
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
      .getConfiguration('foreman')
      .update('defaultProvider', provider, vscode.ConfigurationTarget.Global);
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

  get(): ForemanConfig {
    const cfg = vscode.workspace.getConfiguration('foreman');
    const repo = this.repoConfig().values;

    return {
      worktreesDirectory: this.pick(cfg, repo, 'worktreesDirectory', '.worktrees'),
      defaultBaseBranch: this.pick(cfg, repo, 'defaultBaseBranch', 'develop'),
      setupScript: this.pick(cfg, repo, 'setupScript', ''),
      teardownScript: this.pick(cfg, repo, 'teardownScript', ''),
      defaultProvider: cfg.get<ProviderId>('defaultProvider', 'claude'),
      claudeCommand: cfg.get<string>('claudeCommand', 'claude'),
      codexCommand: cfg.get<string>('codexCommand', 'codex'),
      grokCommand: cfg.get<string>('grokCommand', 'grok'),
      opencodeCommand: cfg.get<string>('opencodeCommand', 'opencode'),
      notifyOnAttention: cfg.get<boolean>('notifyOnAttention', true),
      scopeSearchToActiveWorktree: cfg.get<boolean>('scopeSearchToActiveWorktree', true),
      focusMode: cfg.get<boolean>('focusMode', false),
      // Object settings get no deep merge from VSCode and none from the repo
      // file either, so all three layers are folded key by key. A repo naming
      // only its compose file must not reset basePort to the default.
      docker: this.pickDocker(cfg, repo),
      debugBasePort: this.pick(cfg, repo, 'debugBasePort', 9898),
      debugTemplate: this.pick(cfg, repo, 'debugTemplate', DEBUG_TEMPLATE_DEFAULT),
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

/** Drops undefined values so a partial object does not blank out lower layers. */
function strip<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
