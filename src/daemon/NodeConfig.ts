import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StackConfig } from '../types';
import type { ConfigSource } from '../config/ConfigSource';
import { PROVIDER_IDS, type ProviderId } from '../ports/IAgentProvider';
import { PROJECT_DEFAULTS } from '../config/defaults';
import { CODE_USER_DEFAULTS } from '../code/config';
import { legacyPorts, readRepoConfig } from '../config/RepoConfig';

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
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

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
      if (explicit !== undefined && typeof explicit === typeof PROJECT_DEFAULTS[key] && Array.isArray(explicit) === Array.isArray(PROJECT_DEFAULTS[key])) {
        return explicit as (typeof PROJECT_DEFAULTS)[K];
      }
      return (repo[key] as (typeof PROJECT_DEFAULTS)[K] | undefined) ?? PROJECT_DEFAULTS[key];
    };
    // Named ports from before they left the retired `docker` block; a top-level value wins.
    const userLegacy = legacyPorts(user('docker'));
    const portNames = user('ports');
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
      ports: Array.isArray(portNames) && portNames.every((n) => typeof n === 'string')
        ? (portNames as string[])
        : userLegacy.ports ?? repo.ports ?? PROJECT_DEFAULTS.ports,
      basePort: user('basePort') === undefined && userLegacy.basePort !== undefined ? userLegacy.basePort : pick('basePort'),
      portStride: user('portStride') === undefined && userLegacy.portStride !== undefined ? userLegacy.portStride : pick('portStride'),
      debugBasePort: pick('debugBasePort'),
      debugTemplate: pick('debugTemplate'),
      phpNavigation: pick('phpNavigation'),
      phpIndexDirs: pick('phpIndexDirs'),
      phpExcludeDirs: pick('phpExcludeDirs'),
      phpExtensions: pick('phpExtensions'),
      phpAutoloader: pick('phpAutoloader'),
      phpBaseBranch: pick('phpBaseBranch'),
      phpMaxChangedFiles: pick('phpMaxChangedFiles'),
      phpactorOptions: pick('phpactorOptions'),
      scriptExcludeDirs: pick('scriptExcludeDirs'),
      oxlintConfig: pick('oxlintConfig'),
      phpBaseOnStart: bool(user('phpBaseOnStart'), CODE_USER_DEFAULTS.phpBaseOnStart),
      codeIdleMinutes: num(user('codeIdleMinutes'), CODE_USER_DEFAULTS.codeIdleMinutes),
      phpactorPath: str(user('phpactorPath'), CODE_USER_DEFAULTS.phpactorPath),
      oxlintPath: str(user('oxlintPath'), CODE_USER_DEFAULTS.oxlintPath),
      phpPath: str(user('phpPath'), CODE_USER_DEFAULTS.phpPath),
    };
  }
}
