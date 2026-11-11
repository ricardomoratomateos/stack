import { describe, expect, it } from 'vitest';
import { DEFS, PROJECT_DEFS, USER_DEFS, repoValueOf, SHOWN, isModified, titleOf, valueOf } from './schema';

describe('settings schema', () => {
  it('has every shown setting, from package.json', () => {
    expect(DEFS.map((d) => d.key)).toEqual([...SHOWN]);
    const p = DEFS.find((d) => d.key === 'defaultProvider')!;
    expect(p.enum).toContain('claude');
    expect(p.description.length).toBeGreaterThan(10);
    expect(DEFS.find((d) => d.key === 'promptPrefix')!.multiline).toBe(true);
  });
  it('titles', () => expect(titleOf('setupInTerminal')).toBe('Setup In Terminal'));
  it('reads either spelling and ignores wrong types', () => {
    const d = DEFS.find((x) => x.key === 'claudeCommand')!;
    expect(valueOf(d, { 'stack.claudeCommand': 'c' })).toBe('c');
    expect(valueOf(d, { claudeCommand: 3 })).toBeUndefined();
  });
  it('modified only when different from the default', () => {
    const d = DEFS.find((x) => x.key === 'claudeCommand')!;
    expect(isModified(d, undefined)).toBe(false);
    expect(isModified(d, d.default)).toBe(false);
    expect(isModified(d, 'other')).toBe(true);
  });
  it('splits project keys from user keys', () => {
    expect(PROJECT_DEFS.map((d) => d.key)).toEqual(['worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'setupInTerminal', 'teardownScript']);
    expect(USER_DEFS.length + PROJECT_DEFS.length).toBe(DEFS.length);
    expect(USER_DEFS.map((d) => d.key)).toContain('defaultProvider');
  });
  it('repo files use unprefixed keys only', () => {
    const d = PROJECT_DEFS.find((x) => x.key === 'defaultBaseBranch')!;
    expect(repoValueOf(d, { defaultBaseBranch: 'main' })).toBe('main');
    expect(repoValueOf(d, { 'stack.defaultBaseBranch': 'main' })).toBeUndefined();
  });
});
