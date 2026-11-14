import { describe, expect, it } from 'vitest';
import { toNewTaskInit, translateNewTask } from './bridge';

const ctx = { repoRoot: '/r' };

describe('translateNewTask', () => {
  it('ready is answered with init', () => {
    expect(translateNewTask({ type: 'ready' }, ctx)).toEqual({ kind: 'init' });
  });
  it('create is createTask in the repo, with every field the panel sent', () => {
    expect(translateNewTask({ type: 'create', branch: 'fix-x', title: 'Fix x', description: 'd', baseBranch: 'main', provider: 'opencode' }, ctx)).toEqual({
      kind: 'create',
      body: { repo: '/r', branch: 'fix-x', title: 'Fix x', description: 'd', baseBranch: 'main', provider: 'opencode' },
    });
  });
  it('cancel closes at once, or asks first when text would be lost', () => {
    expect(translateNewTask({ type: 'cancel' }, ctx)).toEqual({ kind: 'close' });
    expect(translateNewTask({ type: 'cancel', dirty: false }, ctx)).toEqual({ kind: 'close' });
    expect(translateNewTask({ type: 'cancel', dirty: true }, ctx)).toEqual({ kind: 'confirmDiscard' });
  });
  it('an agent that is not installed gets the install hint', () => {
    expect(translateNewTask({ type: 'showProviderInstall', provider: 'opencode' }, ctx)).toEqual({ kind: 'install', provider: 'opencode' });
  });
});

describe('toNewTaskInit', () => {
  it('uses stackd\'s branches, base and installed agents', () => {
    const init = toNewTaskInit({ branches: ['main', 'dev'], baseBranch: 'dev', installedProviders: ['claude'], defaultProvider: 'opencode' }, {});
    expect(init).toEqual({ branches: ['main', 'dev'], baseBranch: 'dev', installedProviders: ['claude'], defaultProvider: 'opencode' });
  });
  it('the app\'s own default provider wins', () => {
    const init = toNewTaskInit({ defaultProvider: 'claude' }, { defaultProvider: 'opencode' });
    expect(init.defaultProvider).toBe('opencode');
  });
  it('is usable before stackd answers', () => {
    expect(toNewTaskInit(null, {})).toEqual({ branches: [], baseBranch: 'main', defaultProvider: 'claude', installedProviders: ['claude', 'opencode'] });
  });
});
