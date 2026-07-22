import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProviderFactory } from '../../src/providers/ProviderFactory';
import { ClaudeProvider, ConfigSource } from '../../src/providers/claude/ClaudeProvider';
import { OpenCodeProvider } from '../../src/providers/opencode/OpenCodeProvider';
import { PROVIDER_IDS, isAgentWindowName, providerForWindowName } from '../../src/ports/IAgentProvider';

describe('ProviderFactory', () => {
  let tmpDir: string;
  let storageDir: string;
  let homeDir: string;

  const makeConfig = (overrides: Record<string, unknown> = {}): ConfigSource =>
    ({ get: () => ({ claudeCommand: 'claude', opencodeCommand: 'opencode', defaultProvider: 'claude', ...overrides }) }) as unknown as ConfigSource;

  const makeFactory = (config: ConfigSource = makeConfig()) => new ProviderFactory(config, storageDir, homeDir);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmess-providers-'));
    storageDir = path.join(tmpDir, 'storage');
    homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a ClaudeProvider for "claude"', () => {
    const provider = makeFactory().create('claude');
    expect(provider).toBeInstanceOf(ClaudeProvider);
    expect(provider.id).toBe('claude');
    expect(provider.label).toBe('Claude Code');
  });

  it('caches instances (same object on repeated create)', () => {
    const factory = makeFactory();
    expect(factory.create('claude')).toBe(factory.create('claude'));
  });

  it('defaultProvider resolves from config.defaultProvider', () => {
    expect(makeFactory().defaultProvider().id).toBe('claude');
    expect(makeFactory(makeConfig({ defaultProvider: 'opencode' })).defaultProvider().id).toBe('opencode');
  });

  it('all() returns one instance per registered provider id', () => {
    const providers = makeFactory().all();
    expect(providers.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it('defaults homeDir to os.homedir() when not injected', () => {
    const factory = new ProviderFactory(makeConfig(), storageDir);
    expect(factory.create('claude')).toBeInstanceOf(ClaudeProvider);
  });

  describe('ClaudeProvider', () => {
    it('buildCommand prefixes UNMESS_WORKSPACE_ID and uses the configured command', () => {
      const provider = makeFactory(makeConfig({ claudeCommand: 'my-claude' })).create('claude');
      expect(provider.buildCommand('wt-1')).toBe('UNMESS_WORKSPACE_ID="wt-1" my-claude');
    });

    it('buildCommand appends the initial prompt with escaped double quotes', () => {
      const provider = makeFactory().create('claude');
      expect(provider.buildCommand('wt-1', 'fix "this" bug')).toBe(
        'UNMESS_WORKSPACE_ID="wt-1" claude "fix \\"this\\" bug"',
      );
    });

    it('installHooks writes notify.sh and injects into the claude settings under homeDir', () => {
      const provider = makeFactory().create('claude');
      provider.installHooks('http://127.0.0.1:43110');

      const script = fs.readFileSync(path.join(storageDir, 'notify.sh'), 'utf8');
      expect(script).toContain('curl -s -X POST "http://127.0.0.1:43110/hook"');

      const settingsPath = path.join(homeDir, '.claude/settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(Object.keys(settings.hooks)).toContain('Stop');
    });

    it('uninstallHooks removes the injected hooks again', () => {
      const provider = makeFactory().create('claude');
      provider.installHooks('http://127.0.0.1:43110');
      provider.uninstallHooks();

      const settingsPath = path.join(homeDir, '.claude/settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      for (const entries of Object.values(settings.hooks)) {
        expect(entries).toEqual([]);
      }
    });
  });

  describe('OpenCodeProvider', () => {
    const pluginPath = () => path.join(homeDir, '.config/opencode/plugin/unmess-notify.js');

    it('is created for "opencode"', () => {
      const provider = makeFactory().create('opencode');
      expect(provider).toBeInstanceOf(OpenCodeProvider);
      expect(provider.id).toBe('opencode');
      expect(provider.label).toBe('opencode');
    });

    it('buildCommand prefixes UNMESS_WORKSPACE_ID and uses the configured command', () => {
      const provider = makeFactory(makeConfig({ opencodeCommand: '/opt/opencode' })).create('opencode');
      expect(provider.buildCommand('wt-1')).toBe('UNMESS_WORKSPACE_ID="wt-1" /opt/opencode');
    });

    it('buildCommand passes the initial prompt via --prompt with escaped double quotes', () => {
      const provider = makeFactory().create('opencode');
      expect(provider.buildCommand('wt-1', 'fix "this" bug')).toBe(
        'UNMESS_WORKSPACE_ID="wt-1" opencode --prompt "fix \\"this\\" bug"',
      );
    });

    it('installHooks writes the plugin into ~/.config/opencode/plugin with the hook URL', () => {
      makeFactory().create('opencode').installHooks('http://127.0.0.1:43110');
      const plugin = fs.readFileSync(pluginPath(), 'utf8');
      expect(plugin).toContain('fetch("http://127.0.0.1:43110/hook"');
      expect(plugin).toContain('if (!workspaceId) return {};'); // inert outside unmess
      expect(plugin).toContain('"session.idle": "Stop"');
      expect(plugin).toContain('"tool.execute.before": async () => notify("PreToolUse")');
      expect(plugin).toContain('windowIndex');
    });

    it('does not rewrite the plugin when content is unchanged, rewrites on URL change', () => {
      const provider = makeFactory().create('opencode');
      provider.installHooks('http://127.0.0.1:43110');
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(pluginPath(), past, past);
      const before = fs.statSync(pluginPath()).mtimeMs;

      provider.installHooks('http://127.0.0.1:43110');
      expect(fs.statSync(pluginPath()).mtimeMs).toBe(before);

      provider.installHooks('http://127.0.0.1:55555');
      expect(fs.statSync(pluginPath()).mtimeMs).toBeGreaterThan(before);
      expect(fs.readFileSync(pluginPath(), 'utf8')).toContain('http://127.0.0.1:55555/hook');
    });

    it('uninstallHooks deletes the plugin; no-op when it does not exist', () => {
      const provider = makeFactory().create('opencode');
      provider.installHooks('http://127.0.0.1:43110');
      provider.uninstallHooks();
      expect(fs.existsSync(pluginPath())).toBe(false);
      expect(() => provider.uninstallHooks()).not.toThrow();
    });

    it('defaults the plugin path to ~/.config/opencode/plugin when not injected', async () => {
      const { OpenCodeHookInstaller } = await import('../../src/providers/opencode/OpenCodeHookInstaller');
      const installer = new OpenCodeHookInstaller();
      const resolved = (installer as unknown as { pluginPath: string }).pluginPath;
      expect(resolved).toBe(path.join(os.homedir(), '.config/opencode/plugin/unmess-notify.js'));
    });

    it('uninstallHooks swallows fs errors (best effort)', () => {
      // A non-empty DIRECTORY at the plugin path makes rmSync throw without recursive.
      fs.mkdirSync(pluginPath(), { recursive: true });
      fs.writeFileSync(path.join(pluginPath(), 'x'), '');
      const provider = makeFactory().create('opencode');
      expect(() => provider.uninstallHooks()).not.toThrow();
    });

    it('the generated plugin is syntactically valid ESM', async () => {
      makeFactory().create('opencode').installHooks('http://127.0.0.1:43110');
      const mod = await import(/* @vite-ignore */ pluginPath());
      expect(typeof mod.UnmessNotify).toBe('function');
      // Without UNMESS_WORKSPACE_ID the plugin must return no hooks at all.
      delete process.env.UNMESS_WORKSPACE_ID;
      await expect(mod.UnmessNotify()).resolves.toEqual({});
    });
  });

  describe('window name helpers', () => {
    it('isAgentWindowName matches provider-prefixed names only', () => {
      expect(isAgentWindowName('claude')).toBe(true);
      expect(isAgentWindowName('claude-resume')).toBe(true);
      expect(isAgentWindowName('opencode')).toBe(true);
      expect(isAgentWindowName('shell')).toBe(false);
      expect(isAgentWindowName('vim')).toBe(false);
    });

    it('providerForWindowName resolves the owning provider', () => {
      expect(providerForWindowName('claude')).toBe('claude');
      expect(providerForWindowName('opencode')).toBe('opencode');
      expect(providerForWindowName('zsh')).toBeUndefined();
    });
  });
});
