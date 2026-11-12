import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StackConfig } from '../types';
import type { ConfigSource } from '../config/ConfigSource';
import { PROVIDER_IDS, type ProviderId } from '../ports/IAgentProvider';
import { normalizeSidebarStyle } from '../sidebarStyle';
import { PROJECT_DEFAULTS, DOCKER_DEFAULTS } from '../config/defaults';
import { readRepoConfig } from '../config/RepoConfig';

/** `~/.config/stack/settings.json`: the user's own settings for `stackd`. */
export const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.config', 'stack', 'settings.json');

/** Reads a JSON object from disk; anything missing or malformed is `{}`. */
function readObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/**
 * The configuration `stackd` runs on (a ConfigSource). An explicit user value (settings.json, keys without the `stack.`
 * prefix, which is accepted too) beats `.stack/config.json`, which beats the
 * shipped defaults. Re-read on every `get()`; the files are tiny.
 */
export class NodeConfig implements ConfigSource {
  constructor(
    private readonly repoRoot: () => string | undefined,
    private readonly settingsPath: string = DEFAULT_SETTINGS_PATH,
    /** Settings a client pushed (the VS Code extension's own): below settings.json, above the repo file. */
    private readonly pushed: () => Record<string, unknown> = () => ({}),
  ) {}

  get(): StackConfig {
    const raw = readObject(this.settingsPath);
    const pushed = this.pushed();
    const user = (key: string): unknown => raw[key] ?? raw[`stack.${key}`] ?? pushed[key];
    const root = this.repoRoot();
    const repo = root ? readRepoConfig(root).values : {};
    const pick = <K extends keyof typeof PROJECT_DEFAULTS>(key: K): (typeof PROJECT_DEFAULTS)[K] => {
      const explicit = user(key);
      if (explicit !== undefined && typeof explicit === typeof PROJECT_DEFAULTS[key]) return explicit as (typeof PROJECT_DEFAULTS)[K];
      return (repo[key] as (typeof PROJECT_DEFAULTS)[K] | undefined) ?? PROJECT_DEFAULTS[key];
    };
    const userDocker = user('docker');
    const provider = user('defaultProvider');
    return {
      worktreesDirectory: pick('worktreesDirectory'),
      defaultBaseBranch: pick('defaultBaseBranch'),
      setupScript: pick('setupScript'),
      setupInTerminal: pick('setupInTerminal'),
      teardownScript: pick('teardownScript'),
      defaultProvider: PROVIDER_IDS.includes(provider as ProviderId) ? (provider as ProviderId) : 'claude',
      promptPrefix: str(user('promptPrefix'), ''),
      claudeCommand: str(user('claudeCommand'), 'claude'),
      codexCommand: str(user('codexCommand'), 'codex'),
      opencodeCommand: str(user('opencodeCommand'), 'opencode'),
      notifyOnAttention: bool(user('notifyOnAttention'), true),
      scopeSearchToActiveWorktree: bool(user('scopeSearchToActiveWorktree'), true),
      focusMode: bool(user('focusMode'), false),
      sessionTabs: user('sessionTabs') === 'single' ? 'single' : 'perSession',
      sidebarStyle: normalizeSidebarStyle(typeof user('sidebarStyle') === 'string' ? (user('sidebarStyle') as string) : undefined),
      docker: {
        ...DOCKER_DEFAULTS,
        ...(repo.docker ?? {}),
        ...(userDocker && typeof userDocker === 'object' ? (userDocker as object) : {}),
      },
      debugBasePort: pick('debugBasePort'),
      debugTemplate: pick('debugTemplate'),
    };
  }
}
