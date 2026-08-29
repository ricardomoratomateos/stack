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
    const file = path.join(tmpDir, '.unmess', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  };

  beforeEach(() => {
    resetVscodeMock();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmess-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads the "unmess" configuration section', () => {
    new ConfigManager().get();
    expect(workspace.getConfiguration).toHaveBeenCalledWith('unmess');
  });

  it('returns defaults: .worktrees, empty scripts, claude, 9898, node debugTemplate with {{PORT}}', () => {
    const config = new ConfigManager().get();

    expect(config).toEqual({
      worktreesDirectory: '.worktrees',
      defaultBaseBranch: 'develop',
      setupScript: '',
      teardownScript: '',
      defaultProvider: 'claude',
      claudeCommand: 'claude',
      codexCommand: 'codex',
      grokCommand: 'grok',
      opencodeCommand: 'opencode',
      notifyOnAttention: true,
      scopeSearchToActiveWorktree: true,
      focusMode: false,
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
        name: 'Unmess: Debug',
        port: '{{PORT}}',
      },
    });
  });

  it('returns user overrides when set', () => {
    const overrides: Record<string, unknown> = {
      worktreesDirectory: '/abs/worktrees',
      defaultBaseBranch: 'main',
      setupScript: '/scripts/setup.sh',
      teardownScript: '/scripts/teardown.sh',
      defaultProvider: 'opencode',
      claudeCommand: 'claude --dangerously-skip-permissions',
      codexCommand: 'codex --full-auto',
      grokCommand: '/usr/local/bin/grok',
      opencodeCommand: '/usr/local/bin/opencode',
      notifyOnAttention: false,
      scopeSearchToActiveWorktree: false,
      focusMode: true,
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

  describe('.unmess/config.json', () => {
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
      const expected = path.join(tmpDir, '.unmess', 'config.json');
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

  describe('setDefaultProvider', () => {
    it('writes unmess.defaultProvider globally', async () => {
      const update = vi.fn().mockResolvedValue(undefined);
      workspace.getConfiguration.mockReturnValue({ get: vi.fn(), update } as never);

      await new ConfigManager().setDefaultProvider('grok');

      // Global, not workspace: which agent you reach for is a property of you,
      // not of the repo you happen to have open.
      expect(update).toHaveBeenCalledWith('defaultProvider', 'grok', ConfigurationTarget.Global);
    });
  });
});
