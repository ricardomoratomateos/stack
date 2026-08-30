import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProviderFactory } from '../../src/providers/ProviderFactory';
import { ClaudeProvider, ConfigSource } from '../../src/providers/claude/ClaudeProvider';
import { CodexProvider } from '../../src/providers/codex/CodexProvider';
import { GrokProvider } from '../../src/providers/grok/GrokProvider';
import { CodexHookInstaller } from '../../src/providers/codex/CodexHookInstaller';
import { GrokHookInstaller } from '../../src/providers/grok/GrokHookInstaller';
import { OpenCodeProvider } from '../../src/providers/opencode/OpenCodeProvider';
import { PROVIDER_IDS, isAgentWindowName, providerForWindowName } from '../../src/ports/IAgentProvider';

describe('ProviderFactory', () => {
  let tmpDir: string;
  let storageDir: string;
  let homeDir: string;

  const makeConfig = (overrides: Record<string, unknown> = {}): ConfigSource =>
    ({ get: () => ({
      claudeCommand: 'claude', codexCommand: 'codex', grokCommand: 'grok',
      opencodeCommand: 'opencode', defaultProvider: 'claude', ...overrides,
    }) }) as unknown as ConfigSource;

  const makeFactory = (config: ConfigSource = makeConfig()) => new ProviderFactory(config, storageDir, homeDir);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-providers-'));
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
    it('buildCommand prefixes FOREMAN_WORKSPACE_ID and uses the configured command', () => {
      const provider = makeFactory(makeConfig({ claudeCommand: 'my-claude' })).create('claude');
      expect(provider.buildCommand('wt-1')).toBe('FOREMAN_WORKSPACE_ID="wt-1" my-claude');
    });

    it('buildCommand appends the initial prompt with escaped double quotes', () => {
      const provider = makeFactory().create('claude');
      expect(provider.buildCommand('wt-1', 'fix "this" bug')).toBe(
        'FOREMAN_WORKSPACE_ID="wt-1" claude "fix \\"this\\" bug"',
      );
    });

    it('installHooks writes notify.sh and injects into the claude settings under homeDir', () => {
      const provider = makeFactory().create('claude');
      provider.installHooks('http://127.0.0.1:43110');

      const script = fs.readFileSync(path.join(storageDir, 'notify.sh'), 'utf8');
      expect(script).toContain('curl -s -X POST "$URL/hook"');
      expect(fs.readFileSync(path.join(storageDir, 'hook-url'), 'utf8')).toBe('http://127.0.0.1:43110');

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
    const pluginPath = () => path.join(homeDir, '.config/opencode/plugin/foreman-notify.js');

    it('is created for "opencode"', () => {
      const provider = makeFactory().create('opencode');
      expect(provider).toBeInstanceOf(OpenCodeProvider);
      expect(provider.id).toBe('opencode');
      expect(provider.label).toBe('opencode');
    });

    it('buildCommand prefixes FOREMAN_WORKSPACE_ID and uses the configured command', () => {
      const provider = makeFactory(makeConfig({ opencodeCommand: '/opt/opencode' })).create('opencode');
      expect(provider.buildCommand('wt-1')).toBe('FOREMAN_WORKSPACE_ID="wt-1" /opt/opencode');
    });

    it('buildCommand passes the initial prompt via --prompt with escaped double quotes', () => {
      const provider = makeFactory().create('opencode');
      expect(provider.buildCommand('wt-1', 'fix "this" bug')).toBe(
        'FOREMAN_WORKSPACE_ID="wt-1" opencode --prompt "fix \\"this\\" bug"',
      );
    });

    it('installHooks writes the plugin into ~/.config/opencode/plugin with the hook URL', () => {
      makeFactory().create('opencode').installHooks('http://127.0.0.1:43110');
      const plugin = fs.readFileSync(pluginPath(), 'utf8');
      expect(plugin).toContain('fetch("http://127.0.0.1:43110/hook"');
      expect(plugin).toContain('if (!workspaceId) return {};'); // inert outside foreman
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
      expect(resolved).toBe(path.join(os.homedir(), '.config/opencode/plugin/foreman-notify.js'));
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
      expect(typeof mod.ForemanNotify).toBe('function');
      // Without FOREMAN_WORKSPACE_ID the plugin must return no hooks at all.
      delete process.env.FOREMAN_WORKSPACE_ID;
      await expect(mod.ForemanNotify()).resolves.toEqual({});
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

// ── Codex ────────────────────────────────────────────────────────────────────

describe('CodexProvider', () => {
  let tmpDir: string;
  let storageDir: string;
  let homeDir: string;

  const config = {
    get: () => ({ codexCommand: 'codex', grokCommand: 'grok', claudeCommand: 'claude', opencodeCommand: 'opencode', defaultProvider: 'claude' }),
  } as unknown as ConfigSource;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-codex-'));
    storageDir = path.join(tmpDir, 'storage');
    homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const make = () => new ProviderFactory(config, storageDir, homeDir).create('codex');
  const hooksPath = () => path.join(homeDir, '.codex/hooks.json');
  const readHooks = () => JSON.parse(fs.readFileSync(hooksPath(), 'utf8'));

  it('is built for the "codex" id', () => {
    const provider = make();
    expect(provider).toBeInstanceOf(CodexProvider);
    expect(provider.label).toBe('Codex');
  });

  it('buildCommand prefixes FOREMAN_WORKSPACE_ID', () => {
    expect(make().buildCommand('wt-1')).toBe('FOREMAN_WORKSPACE_ID="wt-1" codex');
  });

  it('passes the initial prompt as a positional argument, escaping quotes', () => {
    expect(make().buildCommand('wt-1', 'fix "this" bug')).toBe(
      'FOREMAN_WORKSPACE_ID="wt-1" codex "fix \\"this\\" bug"',
    );
  });

  it('registers into ~/.codex/hooks.json', () => {
    make().installHooks('http://127.0.0.1:43110');
    expect(fs.existsSync(hooksPath())).toBe(true);
  });

  it('does NOT register SessionEnd — Codex has no end-of-session hook', () => {
    make().installHooks('http://127.0.0.1:43110');
    const events = Object.keys(readHooks().hooks);
    expect(events).toContain('Stop');
    expect(events).not.toContain('SessionEnd');
  });

  it('keeps another tool\'s hooks in the same file', () => {
    // Codex users commonly have a second harness registered here; superset
    // writes exactly this shape.
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    fs.writeFileSync(hooksPath(), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/other/notify.sh' }] }] },
    }));

    make().installHooks('http://127.0.0.1:43110');

    const commands = readHooks().hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(commands).toContain('/other/notify.sh');
    // Ours is the quoted script path plus the event name.
    expect(commands.some((c: string) => c.includes(storageDir) && c.endsWith(' Stop'))).toBe(true);
  });

  it('uninstall removes only our entries, leaving the other tool alone', () => {
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    fs.writeFileSync(hooksPath(), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/other/notify.sh' }] }] },
    }));
    const provider = make();
    provider.installHooks('http://127.0.0.1:43110');

    provider.uninstallHooks();

    const commands = readHooks().hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(commands).toEqual(['/other/notify.sh']);
  });

  it('re-installing does not accumulate duplicates', () => {
    const provider = make();
    provider.installHooks('http://127.0.0.1:43110');
    provider.installHooks('http://127.0.0.1:55555');
    const entries = readHooks().hooks.Stop.flatMap((g: { hooks: unknown[] }) => g.hooks);
    expect(entries).toHaveLength(1);
  });

  it('defaults to ~/.codex/hooks.json when no path is injected', () => {
    const installer = new CodexHookInstaller(storageDir);
    expect((installer as unknown as { settingsPath: string }).settingsPath)
      .toBe(path.join(os.homedir(), '.codex/hooks.json'));
  });

  it('uninstall gives up quietly when the config cannot be written', () => {
    const provider = make();
    provider.installHooks('http://127.0.0.1:43110');
    // Read-only config: dispose must not throw on the way out of the window.
    fs.chmodSync(hooksPath(), 0o444);
    try {
      expect(() => provider.uninstallHooks()).not.toThrow();
    } finally {
      fs.chmodSync(hooksPath(), 0o644);
    }
  });

  it('survives a hand-corrupted hooks.json instead of throwing', () => {
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    fs.writeFileSync(hooksPath(), '{ not json');
    expect(() => make().installHooks('http://127.0.0.1:43110')).not.toThrow();
    expect(Object.keys(readHooks().hooks)).toContain('Stop');
  });
});

// ── Grok ─────────────────────────────────────────────────────────────────────

describe('GrokProvider', () => {
  let tmpDir: string;
  let storageDir: string;
  let homeDir: string;

  const config = {
    get: () => ({ grokCommand: 'grok', codexCommand: 'codex', claudeCommand: 'claude', opencodeCommand: 'opencode', defaultProvider: 'claude' }),
  } as unknown as ConfigSource;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-grok-'));
    storageDir = path.join(tmpDir, 'storage');
    homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const make = () => new ProviderFactory(config, storageDir, homeDir).create('grok');
  const readHooks = () => JSON.parse(fs.readFileSync(path.join(homeDir, '.grok/hooks.json'), 'utf8'));

  it('is built for the "grok" id', () => {
    const provider = make();
    expect(provider).toBeInstanceOf(GrokProvider);
    expect(provider.label).toBe('Grok Build');
  });

  it('seeds the first prompt with -p, which keeps the interactive TUI', () => {
    expect(make().buildCommand('wt-1', 'fix "this" bug')).toBe(
      'FOREMAN_WORKSPACE_ID="wt-1" grok -p "fix \\"this\\" bug"',
    );
  });

  it('buildCommand without a prompt is the bare command', () => {
    expect(make().buildCommand('wt-1')).toBe('FOREMAN_WORKSPACE_ID="wt-1" grok');
  });

  it('registers Notification instead of PermissionRequest, which Grok does not emit', () => {
    make().installHooks('http://127.0.0.1:43110');
    const events = Object.keys(readHooks().hooks);
    expect(events).toContain('Notification');
    expect(events).not.toContain('PermissionRequest');
  });

  it('registers SessionEnd, which Grok does emit', () => {
    make().installHooks('http://127.0.0.1:43110');
    expect(Object.keys(readHooks().hooks)).toContain('SessionEnd');
  });

  it('uninstall is a no-op when the file was never written', () => {
    expect(() => make().uninstallHooks()).not.toThrow();
  });

  it('defaults to ~/.grok/hooks.json when no path is injected', () => {
    const installer = new GrokHookInstaller(storageDir);
    expect((installer as unknown as { settingsPath: string }).settingsPath)
      .toBe(path.join(os.homedir(), '.grok/hooks.json'));
  });
});
