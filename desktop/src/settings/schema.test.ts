import { describe, expect, it } from 'vitest';
import { DEFS, PROJECT_DEFS, USER_DEFS, formatValue, parseList, repoValueOf, SHOWN, isModified, titleOf, valueOf } from './schema';

describe('settings schema', () => {
  it('has every shown setting, from settings.json', () => {
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
    expect(PROJECT_DEFS.map((d) => d.key).slice(0, 5)).toEqual(['worktreesDirectory', 'defaultBaseBranch', 'setupScript', 'setupInTerminal', 'teardownScript']);
    expect(PROJECT_DEFS.map((d) => d.key)).toContain('phpIndexDirs');
    expect(USER_DEFS.map((d) => d.key)).toContain('phpactorPath');
    expect(USER_DEFS.length + PROJECT_DEFS.length).toBe(DEFS.length);
    expect(USER_DEFS.map((d) => d.key)).toContain('defaultProvider');
  });
  it('lists and numbers: typed, compared by value, a list typed on one line', () => {
    const dirs = DEFS.find((x) => x.key === 'phpExcludeDirs')!;
    expect(dirs).toMatchObject({ type: 'array', group: 'Code', default: ['vendor', 'node_modules'] });
    expect(valueOf(dirs, { phpExcludeDirs: ['a'] })).toEqual(['a']);
    expect(valueOf(dirs, { phpExcludeDirs: 'a' })).toBeUndefined();
    expect(isModified(dirs, ['vendor', 'node_modules'])).toBe(false);
    expect(parseList(' lib, www ,, src')).toEqual(['lib', 'www', 'src']);
    expect(formatValue(['lib', 'www'])).toBe('lib, www');
    expect(valueOf(DEFS.find((x) => x.key === 'codeIdleMinutes')!, { codeIdleMinutes: 5 })).toBe(5);
  });
  it('repo files use unprefixed keys only', () => {
    const d = PROJECT_DEFS.find((x) => x.key === 'defaultBaseBranch')!;
    expect(repoValueOf(d, { defaultBaseBranch: 'main' })).toBe('main');
    expect(repoValueOf(d, { 'stack.defaultBaseBranch': 'main' })).toBeUndefined();
  });
});
