import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { ProviderFactory } from '../../src/providers/ProviderFactory';
import { HookRoutes } from '../../src/providers/shared/HookRoutes';
import { ClaudeProvider, ConfigSource } from '../../src/providers/claude/ClaudeProvider';
import { CodexProvider } from '../../src/providers/codex/CodexProvider';
import { CodexHookInstaller } from '../../src/providers/codex/CodexHookInstaller';
import { OpenCodeProvider } from '../../src/providers/opencode/OpenCodeProvider';
import { ConfigFileError } from '../../src/providers/shared/configFile';
import { PROVIDER_IDS, isAgentWindowName, providerForWindowName } from '../../src/ports/IAgentProvider';

describe('ProviderFactory', () => {
  let tmpDir: string;
  let storageDir: string;
  let homeDir: string;

  const makeConfig = (overrides: Record<string, unknown> = {}): ConfigSource =>
    ({ get: () => ({
      claudeCommand: 'claude', codexCommand: 'codex',
      opencodeCommand: 'opencode', defaultProvider: 'claude', ...overrides,
    }) }) as unknown as ConfigSource;

  const makeFactory = (config: ConfigSource = makeConfig()) => new ProviderFactory(config, storageDir, homeDir);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-providers-'));
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

  describe('with the Stack MCP bridge installed', () => {
    const bridge = { command: '/usr/bin/node', args: ['/store/stack-mcp.js'] };
    const factory = () => new ProviderFactory(makeConfig(), storageDir, homeDir, () => bridge);

    it("Claude workers get the bridge for their own task through --mcp-config, keeping the user's servers", () => {
      const command = factory().create('claude').buildCommand('wt-1');
      const json = JSON.stringify({ mcpServers: { stack: { type: 'stdio', command: '/usr/bin/node', args: ['/store/stack-mcp.js'], env: { STACK_TASK_ID: 'wt-1' } } } });
      expect(command).toBe(`STACK_WORKSPACE_ID="wt-1" claude --mcp-config '${json}'`);
      expect(command).not.toContain('--strict-mcp-config');
    });

    it('Codex workers get it as -c mcp_servers.stack.* overrides', () => {
      expect(factory().create('codex').buildCommand('wt-1')).toBe(
        'STACK_WORKSPACE_ID="wt-1" codex '
        + `-c 'mcp_servers.stack.command="/usr/bin/node"' -c 'mcp_servers.stack.args=["/store/stack-mcp.js"]' -c 'mcp_servers.stack.env={STACK_TASK_ID="wt-1"}'`,
      );
    });

    it('opencode is started without it', () => {
      expect(factory().create('opencode').buildCommand('wt-1')).toBe('STACK_WORKSPACE_ID="wt-1" opencode');
    });
  });

  describe('ClaudeProvider', () => {
    it('buildCommand prefixes STACK_WORKSPACE_ID and uses the configured command', () => {
      const provider = makeFactory(makeConfig({ claudeCommand: 'my-claude' })).create('claude');
      expect(provider.buildCommand('wt-1')).toBe('STACK_WORKSPACE_ID="wt-1" my-claude');
    });


    it('installHooks writes notify.sh and injects into the claude settings under homeDir', () => {
      const provider = makeFactory().create('claude');
      provider.installHooks('http://127.0.0.1:43110');

      const script = fs.readFileSync(path.join(storageDir, 'notify.sh'), 'utf8');
      expect(script).toContain('-X POST "$URL/hook"');
      expect(fs.readFileSync(path.join(storageDir, 'hook-url'), 'utf8')).toBe('http://127.0.0.1:43110');

      const settingsPath = path.join(homeDir, '.claude/settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(Object.keys(settings.hooks)).toContain('Stop');
    });

    it("once hooks are installed, launches carry this window's URL and claim the worktree's route", () => {
      // The launch waits on the agent's first hook, so the route has to point
      // here before the agent starts — even if another window showing the same
      // repository claimed it first.
      new HookRoutes(storageDir).claim(['wt-1'], 'http://127.0.0.1:1111');
      const provider = makeFactory().create('claude');
      provider.installHooks('http://127.0.0.1:43110');

      expect(provider.buildCommand('wt-1')).toBe(
        'STACK_HOOK_URL="http://127.0.0.1:43110" STACK_WORKSPACE_ID="wt-1" claude',
      );
      expect(new HookRoutes(storageDir).lookup('wt-1')).toBe('http://127.0.0.1:43110');
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
    const pluginPath = () => path.join(homeDir, '.config/opencode/plugin/stack-notify.js');

    it('is created for "opencode"', () => {
      const provider = makeFactory().create('opencode');
      expect(provider).toBeInstanceOf(OpenCodeProvider);
      expect(provider.id).toBe('opencode');
      expect(provider.label).toBe('opencode');
    });

    it('buildCommand prefixes STACK_WORKSPACE_ID and uses the configured command', () => {
      const provider = makeFactory(makeConfig({ opencodeCommand: '/opt/opencode' })).create('opencode');
      expect(provider.buildCommand('wt-1')).toBe('STACK_WORKSPACE_ID="wt-1" /opt/opencode');
    });


    it('installHooks writes the plugin into ~/.config/opencode/plugin, URL-free', () => {
      makeFactory().create('opencode').installHooks('http://127.0.0.1:43110');
      const plugin = fs.readFileSync(pluginPath(), 'utf8');
      // Looked up at send time — a literal URL is what froze opencode after a reload.
      expect(plugin).not.toContain('43110');
      expect(plugin).toContain(`const STORAGE = ${JSON.stringify(storageDir)};`);
      expect(plugin).toContain('if (!workspaceId) return {};'); // inert outside stack
      expect(plugin).toContain('"session.idle": "Stop"');
      expect(plugin).toContain('"tool.execute.before"');
      expect(plugin).toContain('windowIndex');
    });

    it('leaves the plugin untouched when only the port changes', () => {
      const provider = makeFactory().create('opencode');
      provider.installHooks('http://127.0.0.1:43110');
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(pluginPath(), past, past);
      const before = fs.statSync(pluginPath()).mtimeMs;

      provider.installHooks('http://127.0.0.1:55555');

      expect(fs.statSync(pluginPath()).mtimeMs).toBe(before);
      expect(fs.readFileSync(path.join(storageDir, 'hook-url'), 'utf8')).toBe('http://127.0.0.1:55555');
    });

    it('buildCommand carries the URL and claims the route once hooks are installed', () => {
      const provider = makeFactory().create('opencode');
      provider.installHooks('http://127.0.0.1:43110');
      expect(provider.buildCommand('wt-1')).toBe(
        'STACK_HOOK_URL="http://127.0.0.1:43110" STACK_WORKSPACE_ID="wt-1" opencode',
      );
      expect(new HookRoutes(storageDir).lookup('wt-1')).toBe('http://127.0.0.1:43110');
    });

    describe('the generated plugin, running', () => {
      const posts: { server: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
      const servers: http.Server[] = [];
      const startServer = async (name: string, status: number): Promise<string> => {
        const s = http.createServer((req, res) => {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => { posts.push({ server: name, headers: req.headers, body }); res.writeHead(status).end(); });
        });
        await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
        servers.push(s);
        return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      };
      const saved = { ...process.env };

      afterEach(async () => {
        posts.length = 0;
        for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
        for (const k of [
          'STACK_WORKSPACE_ID', 'STACK_WINDOW_INDEX', 'STACK_HOOK_URL', 'TMUX_PANE',
        ]) {
          if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
      });

      const waitFor = async (n: number) => {
        const deadline = Date.now() + 2000;
        while (posts.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      };

      it("reaches a reloaded window through the route, though its env holds the old port", async () => {
        // opencode loads the plugin once and keeps running across a window
        // reload; only a lookup at send time can follow the window's new port.
        const reloaded = await startServer('reloaded', 200);
        makeFactory().create('opencode').installHooks('http://127.0.0.1:1');
        new HookRoutes(storageDir).claim(['wt-1'], reloaded);
        process.env.STACK_WORKSPACE_ID = 'wt-1';
        process.env.STACK_WINDOW_INDEX = '2';
        process.env.STACK_HOOK_URL = 'http://127.0.0.1:1';

        const mod = await import(/* @vite-ignore */ pluginPath());
        const hooks = await mod.StackNotify();
        await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
        await waitFor(1);

        expect(posts).toHaveLength(1);
        expect(posts[0]?.server).toBe('reloaded');
        expect(posts[0]?.headers['x-stack-hook']).toBe('2');
        expect(posts[0]?.headers['x-stack-event']).toBe('Stop');
        expect(posts[0]?.headers['x-stack-agent']).toBe('opencode');
        expect(posts[0]?.headers['x-stack-workspace']).toBe('wt-1');
        expect(posts[0]?.headers['x-stack-window']).toBe('2');
        expect(JSON.parse(posts[0]?.body ?? '{}')).toMatchObject({ hook_event_name: 'Stop', session_id: 'ses_1' });
      });

      it('moves on from a window that answers 404 to the launch env', async () => {
        const other = await startServer('other', 404);
        const mine = await startServer('mine', 200);
        makeFactory().create('opencode').installHooks(other);
        new HookRoutes(storageDir).claim(['wt-1'], other);
        process.env.STACK_WORKSPACE_ID = 'wt-1';
        process.env.STACK_HOOK_URL = mine;

        const mod = await import(/* @vite-ignore */ pluginPath());
        const hooks = await mod.StackNotify();
        await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_2' });
        await waitFor(2);

        expect(posts.map((p) => p.server)).toEqual(['other', 'mine']);
        expect(JSON.parse(posts[1]?.body ?? '{}')).toMatchObject({ tool_name: 'bash', session_id: 'ses_2' });
      });
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
      const installer = new OpenCodeHookInstaller(storageDir);
      const resolved = (installer as unknown as { pluginPath: string }).pluginPath;
      expect(resolved).toBe(path.join(os.homedir(), '.config/opencode/plugin/stack-notify.js'));
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
      expect(typeof mod.StackNotify).toBe('function');
      // Without STACK_WORKSPACE_ID the plugin must return no hooks at all.
      delete process.env.STACK_WORKSPACE_ID;
      await expect(mod.StackNotify()).resolves.toEqual({});
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
    get: () => ({ codexCommand: 'codex', claudeCommand: 'claude', opencodeCommand: 'opencode', defaultProvider: 'claude' }),
  } as unknown as ConfigSource;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-codex-'));
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

  it('buildCommand prefixes STACK_WORKSPACE_ID', () => {
    expect(make().buildCommand('wt-1')).toBe('STACK_WORKSPACE_ID="wt-1" codex');
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
    expect(commands.some((c: string) => c.includes(storageDir) && c.endsWith(' Stop codex'))).toBe(true);
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

  it('leaves a read-only config alone, saying why', () => {
    const provider = make();
    provider.installHooks('http://127.0.0.1:43110');
    const before = fs.readFileSync(hooksPath(), 'utf8');
    // The atomic write renames over the file, which only needs the directory
    // to be writable — it must still honour a file made read-only on purpose.
    fs.chmodSync(hooksPath(), 0o444);
    try {
      expect(() => provider.uninstallHooks()).toThrow(ConfigFileError);
      expect(fs.readFileSync(hooksPath(), 'utf8')).toBe(before);
      expect(fs.statSync(hooksPath()).mode & 0o777).toBe(0o444);
    } finally {
      fs.chmodSync(hooksPath(), 0o644);
    }
  });

  it('refuses to overwrite a hand-corrupted hooks.json', () => {
    // Codex users commonly keep another harness's hooks in this file; "starting
    // fresh" on a syntax error used to delete them along with everything else.
    fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
    fs.writeFileSync(hooksPath(), '{ not json');
    expect(() => make().installHooks('http://127.0.0.1:43110')).toThrow(/hooks\.json has a syntax error/);
    expect(fs.readFileSync(hooksPath(), 'utf8')).toBe('{ not json');
  });
});
