import type { StackConfig, DebugTemplate, DockerConfig } from '../types';
import type { RepoScopedKey } from './RepoConfig';

export const DOCKER_DEFAULTS: DockerConfig = {
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
export const DEBUG_TEMPLATE_DEFAULT: DebugTemplate = {
  type: 'node',
  request: 'attach',
  name: 'Stack: Debug',
  port: '{{PORT}}',
};

/**
 * What a repository gets when neither its file nor the user says otherwise.
 * One table, read by get() and projectValues() alike, so the two can never
 * disagree about what "unset" means.
 */
export const PROJECT_DEFAULTS: Pick<StackConfig, RepoScopedKey> = {
  worktreesDirectory: '.worktrees',
  defaultBaseBranch: 'develop',
  setupScript: '',
  setupInTerminal: false,
  teardownScript: '',
  docker: DOCKER_DEFAULTS,
  debugBasePort: 9898,
  debugTemplate: DEBUG_TEMPLATE_DEFAULT,
};
