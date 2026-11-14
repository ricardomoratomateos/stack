import type { StackConfig } from '../types';
import type { RepoScopedKey } from './RepoConfig';
import { CODE_DEFAULTS } from '../code/config';

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
  ...CODE_DEFAULTS,
};
