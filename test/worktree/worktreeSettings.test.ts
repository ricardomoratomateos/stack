import { describe, it, expect } from 'vitest';
import { worktreeSettings } from '../../src/worktree/worktreeSettings';

const having = (...files: string[]) => (relative: string) => files.includes(relative);

describe('worktreeSettings', () => {
  it('has nothing to say for a repository with neither node nor PHP', () => {
    expect(worktreeSettings(having('go.mod'))).toBeUndefined();
  });

  it('excludes node_modules for a node repository, with no intelephense settings', () => {
    expect(worktreeSettings(having('package.json'))).toEqual({
      'files.watcherExclude': { '**/node_modules/**': true },
      'files.exclude': { '**/node_modules': true },
    });
  });

  it('excludes vendor and the Symfony cache for a PHP repository, intelephense included', () => {
    expect(worktreeSettings(having('composer.json'))).toEqual({
      'files.watcherExclude': { '**/vendor/**': true, '**/var/cache/**': true },
      'files.exclude': { '**/vendor': true },
      'intelephense.files.exclude': ['**/vendor/**', '**/var/cache/**'],
    });
  });

  it('covers both when both are there', () => {
    expect(worktreeSettings(having('package.json', 'composer.json'))).toEqual({
      'files.watcherExclude': { '**/node_modules/**': true, '**/vendor/**': true, '**/var/cache/**': true },
      'files.exclude': { '**/node_modules': true, '**/vendor': true },
      'intelephense.files.exclude': ['**/node_modules/**', '**/vendor/**', '**/var/cache/**'],
    });
  });
});
