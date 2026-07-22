import * as vscode from 'vscode';
import { UnmessConfig, DebugTemplate, DockerConfig } from '../types';
import type { ProviderId } from '../ports/IAgentProvider';

const DOCKER_DEFAULTS: DockerConfig = {
  composeFile: 'docker-compose.yml',
  overrideFile: 'docker-compose.worktree.yml',
  ports: [],
  basePort: 20000,
  portStride: 100,
};

export class ConfigManager {
  get(): UnmessConfig {
    const cfg = vscode.workspace.getConfiguration('unmess');
    // VSCode does not deep-merge object settings, so fold user values over the
    // defaults key by key.
    const docker = cfg.get<Partial<DockerConfig>>('docker', {});
    return {
      worktreesDirectory: cfg.get<string>('worktreesDirectory', '.worktrees'),
      setupScript: cfg.get<string>('setupScript', ''),
      teardownScript: cfg.get<string>('teardownScript', ''),
      defaultProvider: cfg.get<ProviderId>('defaultProvider', 'claude'),
      claudeCommand: cfg.get<string>('claudeCommand', 'claude'),
      opencodeCommand: cfg.get<string>('opencodeCommand', 'opencode'),
      notifyOnAttention: cfg.get<boolean>('notifyOnAttention', true),
      scopeSearchToActiveWorktree: cfg.get<boolean>('scopeSearchToActiveWorktree', true),
      docker: {
        composeFile: docker.composeFile ?? DOCKER_DEFAULTS.composeFile,
        overrideFile: docker.overrideFile ?? DOCKER_DEFAULTS.overrideFile,
        ports: docker.ports ?? DOCKER_DEFAULTS.ports,
        basePort: docker.basePort ?? DOCKER_DEFAULTS.basePort,
        portStride: docker.portStride ?? DOCKER_DEFAULTS.portStride,
      },
      xdebugBasePort: cfg.get<number>('xdebugBasePort', 9898),
      debugTemplate: cfg.get<DebugTemplate>('debugTemplate', {
        type: 'php',
        request: 'launch',
        name: 'Unmess: Debug',
        port: '{{PORT}}',
        pathMappings: {},
      }),
    };
  }
}
