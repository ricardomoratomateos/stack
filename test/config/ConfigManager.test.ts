import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { workspace, resetVscodeMock, ConfigurationTarget } from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/config/ConfigManager';

/**
 * A settings double shaped like the real API.
 *
 * `get` returns the effective value — an explicit one if there is one, else the
 * default the caller passed — and `inspect` is the only thing that can tell
 * those two apart. Faking a user override through `get` alone (which this file
 * used to do) makes every key look explicitly set, which is exactly the
 * ambiguity the repo config has to see through.
 */
function withSettings(explicit: Record<string, unknown>) {
  workspace.getConfiguration.mockImplementation((_section?: string) => ({
    get: (key: string, defaultValue?: unknown) => (key in explicit ? explicit[key] : defaultValue),
    inspect: (key: string) => ({ key, globalValue: explicit[key] }),
    update: vi.fn().mockResolvedValue(undefined),
  }));
}

describe('ConfigManager', () => {
  let tmpDir: string;

  const writeRepoConfig = (body: unknown): void => {
    const file = path.join(tmpDir, '.stack', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  };

  beforeEach(() => {
    resetVscodeMock();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads the "stack" configuration section', () => {
    new ConfigManager().get();
    expect(workspace.getConfiguration).toHaveBeenCalledWith('stack');
  });

  it('returns defaults: .worktrees, empty scripts, claude, 9898, node debugTemplate with {{PORT}}', () => {
    const config = new ConfigManager().get();

    expect(config).toEqual({
      worktreesDirectory: '.worktrees',
      defaultBaseBranch: 'develop',
      setupScript: '',
      setupInTerminal: false,
      teardownScript: '',
      defaultProvider: 'claude',
      claudeCommand: 'claude',
      codexCommand: 'codex',
      opencodeCommand: 'opencode',
      notifyOnAttention: true,
      scopeSearchToActiveWorktree: true,
      focusMode: false,
      sessionTabs: 'perSession',
      sidebarStyle: 'aside',
      docker: {
        composeFile: 'docker-compose.yml',
        overrideFile: 'docker-compose.worktree.yml',
        ports: [],
        basePort: 20000,
        portStride: 100,
      },
      debugBasePort: 9898,
      debugTemplate: {
        type: 'node',
        request: 'attach',
        name: 'Stack: Debug',
        port: '{{PORT}}',
      },
    });
  });

  it('falls back to the default sidebar style for a value it does not know', () => {
    withSettings({ sidebarStyle: 'neon' });
    expect(new ConfigManager().get().sidebarStyle).toBe('aside');
    withSettings({ sidebarStyle: 'claude' });
    expect(new ConfigManager().get().sidebarStyle).toBe('claude');
  });

  it('returns user overrides when set', () => {
    const overrides: Record<string, unknown> = {
      worktreesDirectory: '/abs/worktrees',
      defaultBaseBranch: 'main',
      setupScript: '/scripts/setup.sh',
      setupInTerminal: true,
      teardownScript: '/scripts/teardown.sh',
      defaultProvider: 'opencode',
      claudeCommand: 'claude --dangerously-skip-permissions',
      codexCommand: 'codex --full-auto',
      opencodeCommand: '/usr/local/bin/opencode',
      notifyOnAttention: false,
      scopeSearchToActiveWorktree: false,
      focusMode: true,
      sessionTabs: 'single',
      sidebarStyle: 'mission',
      docker: {
        composeFile: 'compose.yaml',
        overrideFile: 'compose.wt.yaml',
        ports: ['HTTP_PORT', 'DB_PORT'],
        basePort: 30000,
        portStride: 50,
      },
      debugBasePort: 9000,
      debugTemplate: {
        type: 'node',
        request: 'attach',
        name: 'Custom Debug',
        port: 1234,
      },
    };
    withSettings(overrides);

    expect(new ConfigManager().get()).toEqual(overrides);
  });

  it('reads anything but "single" as perSession — a typo must not cost the user their tabs', () => {
    withSettings({ sessionTabs: 'per-session' });
    expect(new ConfigManager().get().sessionTabs).toBe('perSession');
  });

  it('mixes user overrides with defaults for unset keys', () => {
    withSettings({ debugBasePort: 7777 });

    const config = new ConfigManager().get();

    expect(config.debugBasePort).toBe(7777);
    expect(config.worktreesDirectory).toBe('.worktrees');
    expect(config.setupScript).toBe('');
    expect(config.teardownScript).toBe('');
    expect(config.claudeCommand).toBe('claude');
    expect(config.debugTemplate.port).toBe('{{PORT}}');
  });

  it('folds a partial docker object over the docker defaults', () => {
    withSettings({ docker: { ports: ['HTTP_PORT'] } });

    expect(new ConfigManager().get().docker).toEqual({
      composeFile: 'docker-compose.yml',
      overrideFile: 'docker-compose.worktree.yml',
      ports: ['HTTP_PORT'],
      basePort: 20000,
      portStride: 100,
    });
  });

  // ── repo config ────────────────────────────────────────────────────────────

  describe('.stack/config.json', () => {
    const managerFor = (root: string | undefined, onProblems?: (p: string[]) => void) =>
      new ConfigManager({ repoRoot: () => root, onProblems });

    it('is ignored when there is no repository open', () => {
      writeRepoConfig({ worktreesDirectory: 'ignored' });
      expect(managerFor(undefined).get().worktreesDirectory).toBe('.worktrees');
    });

    it('supplies values the user has not set', () => {
      writeRepoConfig({ version: 1, defaultBaseBranch: 'trunk', worktreesDirectory: '../wt' });

      const config = managerFor(tmpDir).get();

      expect(config.defaultBaseBranch).toBe('trunk');
      expect(config.worktreesDirectory).toBe('../wt');
    });

    it('loses to a setting the user set explicitly', () => {
      // The person sitting here beats a repository they cloned.
      writeRepoConfig({ defaultBaseBranch: 'trunk' });
      withSettings({ defaultBaseBranch: 'my-branch' });

      expect(managerFor(tmpDir).get().defaultBaseBranch).toBe('my-branch');
    });

    it('beats the shipped default even though get() would return it', () => {
      // The regression this whole mechanism turns on: "develop" arrives from
      // cfg.get() whether or not anyone chose it, so a naive read makes the
      // repo file unreachable for every key that has a default — all of them.
      writeRepoConfig({ defaultBaseBranch: 'trunk' });

      expect(managerFor(tmpDir).get().defaultBaseBranch).toBe('trunk');
    });

    it('folds docker across defaults, the repo file and the user, in that order', () => {
      writeRepoConfig({ docker: { composeFile: 'compose.yaml', ports: ['HTTP_PORT'], basePort: 31000 } });
      withSettings({ docker: { basePort: 40000 } });

      expect(managerFor(tmpDir).get().docker).toEqual({
        composeFile: 'compose.yaml',              // repo
        overrideFile: 'docker-compose.worktree.yml', // default
        ports: ['HTTP_PORT'],                     // repo
        basePort: 40000,                          // user wins over the repo's 31000
        portStride: 100,                          // default
      });
    });

    it('ignores per-user keys and says so', () => {
      const problems: string[] = [];
      writeRepoConfig({ defaultProvider: 'codex', claudeCommand: '/opt/claude' });

      const config = managerFor(tmpDir, (p) => problems.push(...p)).get();

      expect(config.defaultProvider).toBe('claude');
      expect(config.claudeCommand).toBe('claude');
      expect(problems.join('\n')).toContain('per-user setting');
    });

    it('falls back to the user settings when the file is not valid JSON', () => {
      const problems: string[] = [];
      writeRepoConfig('{ "defaultBaseBranch": ');

      const config = managerFor(tmpDir, (p) => problems.push(...p)).get();

      expect(config.defaultBaseBranch).toBe('develop');
      expect(problems[0]).toContain('not valid JSON');
    });

    it('keeps the good keys when one is the wrong type', () => {
      const problems: string[] = [];
      writeRepoConfig({ defaultBaseBranch: 'trunk', debugBasePort: 'nine thousand' });

      const config = managerFor(tmpDir, (p) => problems.push(...p)).get();

      expect(config.defaultBaseBranch).toBe('trunk');
      expect(config.debugBasePort).toBe(9898);
      expect(problems[0]).toContain('"debugBasePort" must be a whole number');
    });

    it('reports each distinct problem once, not on every read', () => {
      const batches: string[][] = [];
      writeRepoConfig({ nonsense: 1 });
      const manager = managerFor(tmpDir, (p) => batches.push(p));

      manager.get();
      manager.get();
      manager.get();

      expect(batches).toHaveLength(1);
    });

    it('re-reads and re-reports once the file changes', () => {
      const batches: string[][] = [];
      writeRepoConfig({ defaultBaseBranch: 'trunk' });
      const manager = managerFor(tmpDir, (p) => batches.push(p));

      expect(manager.get().defaultBaseBranch).toBe('trunk');
      expect(batches).toHaveLength(0);

      // A branch switch rewrites this file as readily as an editor does, which
      // is why the cache is keyed on the file's own mtime and size.
      writeRepoConfig({ defaultBaseBranch: 'other', bogus: true });

      expect(manager.get().defaultBaseBranch).toBe('other');
      expect(batches).toHaveLength(1);
      expect(batches[0]?.[0]).toContain('unknown key "bogus"');
    });

    it('exposes the file path whether or not it exists', () => {
      const expected = path.join(tmpDir, '.stack', 'config.json');
      expect(managerFor(tmpDir).repoConfigPath()).toBe(expected);
      expect(managerFor(undefined).repoConfigPath()).toBeUndefined();
    });

    it('reports current problems on demand', () => {
      writeRepoConfig({ setupScript: 42 });
      expect(managerFor(tmpDir).repoConfigProblems()[0]).toContain('"setupScript" must be a string');
      expect(managerFor(tmpDir).repoConfigProblems).toBeTypeOf('function');
    });

    it('has no problems with an empty repository', () => {
      expect(managerFor(tmpDir).repoConfigProblems()).toEqual([]);
    });
  });

  // ── projectValues: what the project form edits and saves ───────────────────

  describe('projectValues', () => {
    const managerFor = (root: string | undefined) => new ConfigManager({ repoRoot: () => root });

    it('leaves the user\'s own overrides out, so saving cannot commit them', () => {
      // The leak: the form was seeded from get(), which already holds the
      // user's settings.json — one Save and their docker ports and worktree
      // directory were in the committed file for the whole team.
      writeRepoConfig({ defaultBaseBranch: 'trunk', docker: { composeFile: 'compose.yaml' } });
      withSettings({
        worktreesDirectory: '/Users/me/my-worktrees',
        defaultBaseBranch: 'my-branch',
        docker: { ports: ['MY_PORT'], basePort: 40000 },
        debugBasePort: 7000,
      });
      const manager = managerFor(tmpDir);

      // get() is still what runs here — the user's choices win…
      expect(manager.get().worktreesDirectory).toBe('/Users/me/my-worktrees');
      // …but none of them reach the project's view.
      expect(manager.projectValues()).toEqual({
        worktreesDirectory: '.worktrees',
        defaultBaseBranch: 'trunk',
        setupScript: '',
        setupInTerminal: false,
        teardownScript: '',
        docker: {
          composeFile: 'compose.yaml',
          overrideFile: 'docker-compose.worktree.yml',
          ports: [],
          basePort: 20000,
          portStride: 100,
        },
        debugBasePort: 9898,
        debugTemplate: { type: 'node', request: 'attach', name: 'Stack: Debug', port: '{{PORT}}' },
      });
    });

    it('is the shipped defaults when the repository has no file', () => {
      withSettings({ setupScript: 'mine.sh' });
      expect(managerFor(tmpDir).projectValues().setupScript).toBe('');
      expect(managerFor(undefined).projectValues().worktreesDirectory).toBe('.worktrees');
    });
  });

  // ── saveUserValues: the personal half of the settings panel ────────────────

  describe('saveUserValues', () => {
    /** Settings double with real layering: workspace > global > default. */
    function layered(layers: {
      global?: Record<string, unknown>;
      workspace?: Record<string, unknown>;
      defaults?: Record<string, unknown>;
    }) {
      const { global = {}, workspace: ws = {}, defaults = {} } = layers;
      const update = vi.fn().mockResolvedValue(undefined);
      workspace.getConfiguration.mockImplementation((_section?: string) => ({
        get: (key: string, fallback?: unknown) => ws[key] ?? global[key] ?? defaults[key] ?? fallback,
        inspect: (key: string) => ({
          key, defaultValue: defaults[key], globalValue: global[key], workspaceValue: ws[key],
        }),
        update,
      }));
      return update;
    }

    it('writes only the keys that changed — not a copy of every default', async () => {
      const update = layered({ defaults: { claudeCommand: 'claude', focusMode: false, notifyOnAttention: true } });

      await new ConfigManager().saveUserValues({ claudeCommand: '/opt/bin/claude', focusMode: false, notifyOnAttention: true });

      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith('claudeCommand', '/opt/bin/claude', ConfigurationTarget.Global);
    });

    it('writes to the workspace when a workspace value would shadow the global one', async () => {
      // Written globally, the save "succeeded" and the workspace value kept
      // winning — nothing the user could see changed.
      const update = layered({ defaults: { focusMode: false }, workspace: { focusMode: false }, global: { focusMode: true } });

      await new ConfigManager().saveUserValues({ focusMode: true });

      expect(update).toHaveBeenCalledWith('focusMode', true, ConfigurationTarget.Workspace);
      expect(update).not.toHaveBeenCalledWith('focusMode', true, ConfigurationTarget.Global);
    });

    it('removes the global key when it is set back to the default, instead of pinning the default', async () => {
      const update = layered({ defaults: { defaultProvider: 'claude' }, global: { defaultProvider: 'codex' } });

      await new ConfigManager().saveUserValues({ defaultProvider: 'claude' });

      expect(update).toHaveBeenCalledWith('defaultProvider', undefined, ConfigurationTarget.Global);
    });

    it('writes nothing at all for an unchanged form', async () => {
      const update = layered({ global: { codexCommand: 'codex-beta' }, defaults: { codexCommand: 'codex' } });
      await new ConfigManager().saveUserValues({ codexCommand: 'codex-beta' });
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('setDefaultProvider', () => {
    it('writes stack.defaultProvider globally', async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      workspace.getConfiguration.mockReturnValue({ get: vi.fn(), update } as never);

      await new ConfigManager().setDefaultProvider('opencode');

      // Global, not workspace: which agent you reach for is a property of you,
      // not of the repo you happen to have open.
      expect(update).toHaveBeenCalledWith('defaultProvider', 'opencode', ConfigurationTarget.Global);
    });
  });
});
