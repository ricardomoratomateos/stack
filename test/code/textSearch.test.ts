import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTextHit, textSearch, textSearchArgs } from '../../src/code/textSearch';

describe('Find in Path', () => {
  it('reads git grep lines, colons in the text included', () => {
    expect(parseTextHit('src/a.php:12:5:  $x = a::b();')).toEqual({ path: 'src/a.php', line: 12, column: 5, text: '  $x = a::b();' });
    expect(parseTextHit('Binary file x matches')).toBeUndefined();
  });

  it('is a fixed-string search, case-insensitive unless asked, excluding what the settings exclude', () => {
    const args = textSearchArgs('/r', '-e foo', { exclude: ['vendor', 'lib/legacy'] });
    expect(args).toContain('-F');
    expect(args).toContain('-i');
    expect(args.slice(args.indexOf('-e'), args.indexOf('-e') + 2)).toEqual(['-e', '-e foo']);
    expect(args.slice(-2)).toEqual([':(exclude)vendor', ':(exclude)lib/legacy']);
    expect(textSearchArgs('/r', 'x', { caseSensitive: true, wholeWord: true })).toEqual(expect.arrayContaining(['-w']));
    expect(textSearchArgs('/r', 'x', { caseSensitive: true })).not.toContain('-i');
  });

  it('searches a worktree, untracked files too, and stops at the limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-search-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      fs.mkdirSync(path.join(dir, 'vendor'));
      fs.writeFileSync(path.join(dir, 'a.php'), '<?php\nclass Invoice {}\n// invoice total\n');
      fs.writeFileSync(path.join(dir, 'vendor', 'b.php'), 'Invoice\n');
      fs.writeFileSync(path.join(dir, 'many.txt'), 'Invoice\n'.repeat(20));
      execFileSync('git', ['add', 'a.php', 'vendor'], { cwd: dir });
      const all = await textSearch(dir, 'invoice', { exclude: ['vendor'] });
      expect(all.hits.filter((h) => h.path === 'a.php').map((h) => [h.line, h.column])).toEqual([[2, 7], [3, 4]]);
      expect(all.hits.some((h) => h.path.startsWith('vendor/'))).toBe(false);
      expect(all.hits.some((h) => h.path === 'many.txt')).toBe(true);
      expect((await textSearch(dir, 'invoice', { caseSensitive: true })).hits.map((h) => h.line)).toEqual([3]);
      const few = await textSearch(dir, 'Invoice', { limit: 5 });
      expect(few.hits).toHaveLength(5);
      expect(few.truncated).toBe(true);
      expect(await textSearch(dir, 'nothing-like-this')).toEqual({ hits: [], truncated: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
