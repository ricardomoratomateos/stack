import { describe, it, expect } from 'vitest';
import { buildCommentPrompt } from '../../src/diff/commentPrompt';
import type { DiffComment } from '../../src/diff/types';

describe('buildCommentPrompt', () => {
  it('returns "" with no comments', () => {
    expect(buildCommentPrompt([])).toBe('');
  });

  it('renders a location, code snippet and body per comment', () => {
    const comments: DiffComment[] = [
      { file: 'src/foo.ts', side: 'new', line: 42, code: '  return null;', body: 'handle the null case' },
    ];
    const out = buildCommentPrompt(comments);
    expect(out).toContain('src/foo.ts:42');
    expect(out).toContain('`return null;`');
    expect(out).toContain('→ handle the null case');
    expect(out).toContain('do not open a pull request');
  });

  it('groups by file and orders comments by line', () => {
    const comments: DiffComment[] = [
      { file: 'a.ts', side: 'new', line: 20, body: 'second' },
      { file: 'a.ts', side: 'new', line: 5, body: 'first' },
      { file: 'b.ts', side: 'new', line: 1, body: 'other file' },
    ];
    const out = buildCommentPrompt(comments);
    expect(out).toContain('### a.ts');
    expect(out).toContain('### b.ts');
    // within a.ts, line 5 comes before line 20
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
  });

  it('omits the location line number when unknown', () => {
    const out = buildCommentPrompt([{ file: 'x.ts', side: 'new', body: 'note' }]);
    expect(out).toContain('**x.ts**');
    expect(out).not.toContain('x.ts:');
  });

  it('sorts comments in the same file when a line number is missing', () => {
    // Three comments in one file with a missing line in the middle — the sort
    // comparator sees an undefined `.line` in both the `a` and `b` positions,
    // exercising both `?? 0` fallbacks.
    const out = buildCommentPrompt([
      { file: 'a.ts', side: 'new', line: 8, body: 'has line 8' },
      { file: 'a.ts', side: 'new', body: 'no line' },
      { file: 'a.ts', side: 'new', line: 3, body: 'has line 3' },
    ]);
    // The line-less comment (treated as 0) sorts first, then line 3, then line 8.
    expect(out.indexOf('no line')).toBeLessThan(out.indexOf('has line 3'));
    expect(out.indexOf('has line 3')).toBeLessThan(out.indexOf('has line 8'));
  });
});
