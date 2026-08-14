import { describe, it, expect, beforeEach } from 'vitest';
import { workspace, resetVscodeMock } from 'vscode';
import { ConfigManager } from '../../src/config/ConfigManager';

describe('ConfigManager', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('reads the "unmess" configuration section', () => {
    new ConfigManager().get();
    expect(workspace.getConfiguration).toHaveBeenCalledWith('unmess');
  });

  it('returns defaults: ./zer, empty scripts, claude, 9898, php debugTemplate with {{PORT}}', () => {
    // shared mock's default getConfiguration returns get(key, default) => default
    const config = new ConfigManager().get();

    expect(config).toEqual({
      worktreesDirectory: '.worktrees',
      defaultBaseBranch: 'develop',
      setupScript: '',
      teardownScript: '',
      defaultProvider: 'claude',
      claudeCommand: 'claude',
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
      xdebugBasePort: 9898,
      debugTemplate: {
        type: 'php',
        request: 'launch',
        name: 'Unmess: Debug',
        port: '{{PORT}}',
        pathMappings: {},
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
      xdebugBasePort: 9000,
      debugTemplate: {
        type: 'node',
        request: 'attach',
        name: 'Custom Debug',
        port: 1234,
      },
    };
    workspace.getConfiguration.mockImplementation((_section?: string) => ({
      get: (key: string, defaultValue?: unknown) =>
        key in overrides ? overrides[key] : defaultValue,
    }));

    const config = new ConfigManager().get();

    expect(config).toEqual(overrides);
  });

  it('mixes user overrides with defaults for unset keys', () => {
    const overrides: Record<string, unknown> = { xdebugBasePort: 7777 };
    workspace.getConfiguration.mockImplementation((_section?: string) => ({
      get: (key: string, defaultValue?: unknown) =>
        key in overrides ? overrides[key] : defaultValue,
    }));

    const config = new ConfigManager().get();

    expect(config.xdebugBasePort).toBe(7777);
    expect(config.worktreesDirectory).toBe('.worktrees');
    expect(config.setupScript).toBe('');
    expect(config.teardownScript).toBe('');
    expect(config.claudeCommand).toBe('claude');
    expect(config.debugTemplate.port).toBe('{{PORT}}');
  });

  it('folds a partial docker object over the docker defaults', () => {
    const overrides: Record<string, unknown> = { docker: { ports: ['HTTP_PORT'] } };
    workspace.getConfiguration.mockImplementation((_section?: string) => ({
      get: (key: string, defaultValue?: unknown) =>
        key in overrides ? overrides[key] : defaultValue,
    }));

    const config = new ConfigManager().get();

    expect(config.docker).toEqual({
      composeFile: 'docker-compose.yml',
      overrideFile: 'docker-compose.worktree.yml',
      ports: ['HTTP_PORT'],
      basePort: 20000,
      portStride: 100,
    });
  });
});
