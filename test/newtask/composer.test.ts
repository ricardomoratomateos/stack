import { describe, it, expect } from 'vitest';
import {
  filterBranches, isCancelKey, isComposing, isSubmitKey, providerName, resolveBranch,
  slugify, submitShortcutLabel, validateBranchName,
} from '../../src/newtask/composer';

describe('slugify', () => {
  it('lowercases, drops punctuation and joins words with dashes', () => {
    expect(slugify('Fix the Double-Charge, please!')).toBe('fix-the-double-charge-please');
  });

  it('treats newlines like spaces', () => {
    expect(slugify('first line\nsecond line')).toBe('first-line-second-line');
  });

  it('caps the length and never ends on the dash the cut left behind', () => {
    const slug = slugify('a'.repeat(49) + ' bbbbbb');
    expect(slug).toBe('a'.repeat(49));
    expect(slugify('word '.repeat(30)).length).toBeLessThanOrEqual(50);
  });

  it('is empty when nothing usable is left', () => {
    expect(slugify('  ¿¡?!  ')).toBe('');
  });
});

describe('validateBranchName', () => {
  it.each([
    ['feat/x', undefined],
    ['AS-7090-fix_payments', undefined],
    ['', undefined],
    ['my branch', "Branch names can't contain spaces."],
    ['-x', "Branch names can't start with a dash."],
    ['a..b', "Branch names can't contain '..'."],
    ['a~b', "Branch names can't contain '~'."],
    ['a:b', "Branch names can't contain ':'."],
    ['a@{b', "Branch names can't contain '@{'."],
    ['a\u0007b', expect.stringContaining("can't contain")],
    ['@', "'@' is not a valid branch name."],
    ['/x', 'Slashes must separate names.'],
    ['x/', 'Slashes must separate names.'],
    ['a//b', 'Slashes must separate names.'],
    ['x.', "Branch names can't end with a dot."],
    ['a/.b', "A part of the name can't start with '.' or end with '.lock'."],
    ['a.lock/b', "A part of the name can't start with '.' or end with '.lock'."],
  ])('%j -> %j', (name, expected) => {
    expect(validateBranchName(name)).toEqual(expected);
  });
});

describe('resolveBranch', () => {
  it('follows the description while the user has typed nothing', () => {
    expect(resolveBranch(null, 'Fix login')).toEqual({ name: 'fix-login', auto: true });
  });

  it('treats a blank typed name as no name at all', () => {
    expect(resolveBranch('   ', 'Fix login')).toEqual({ name: 'fix-login', auto: true });
  });

  it('prefers what the user typed, trimmed, and validates it', () => {
    expect(resolveBranch(' feat/x ', 'Fix login')).toEqual({ name: 'feat/x', auto: false, error: undefined });
    expect(resolveBranch('bad name', '').error).toBe("Branch names can't contain spaces.");
  });
});

describe('providerName', () => {
  it('uses display names, not commands', () => {
    expect(providerName('claude')).toBe('Claude');
    expect(providerName('codex')).toBe('Codex');
    expect(providerName('opencode')).toBe('opencode');
  });
});

describe('filterBranches', () => {
  const all = ['develop', 'main', 'feat/develop-x', 'release'];

  it('returns everything for an empty query', () => {
    expect(filterBranches(all, '  ')).toEqual(all);
  });

  it('lists prefix matches before substring matches, case-insensitively, and drops the rest', () => {
    expect(filterBranches(all, 'DEV')).toEqual(['develop', 'feat/develop-x']);
    expect(filterBranches(['x/main', 'main'], 'main')).toEqual(['main', 'x/main']);
    expect(filterBranches(all, 'zzz')).toEqual([]);
  });
});

describe('submitShortcutLabel', () => {
  it('names the key per platform', () => {
    expect(submitShortcutLabel(true)).toBe('⌘↵');
    expect(submitShortcutLabel(false)).toBe('Ctrl+Enter');
  });
});

describe('key rules', () => {
  it('submits on Cmd+Enter and Ctrl+Enter, not on a bare Enter', () => {
    expect(isSubmitKey({ key: 'Enter', metaKey: true })).toBe(true);
    expect(isSubmitKey({ key: 'Enter', ctrlKey: true })).toBe(true);
    expect(isSubmitKey({ key: 'Enter' })).toBe(false);
    expect(isSubmitKey({ key: 'a', metaKey: true })).toBe(false);
  });

  it('cancels on Escape', () => {
    expect(isCancelKey({ key: 'Escape' })).toBe(true);
    expect(isCancelKey({ key: 'Enter' })).toBe(false);
  });

  it('leaves both keys to an IME that is composing, however it reports it', () => {
    expect(isComposing({ key: 'Enter', isComposing: true })).toBe(true);
    expect(isComposing({ key: 'Enter', keyCode: 229 })).toBe(true);
    expect(isComposing({ key: 'Enter' })).toBe(false);
    expect(isSubmitKey({ key: 'Enter', metaKey: true, isComposing: true })).toBe(false);
    expect(isCancelKey({ key: 'Escape', keyCode: 229 })).toBe(false);
  });
});
