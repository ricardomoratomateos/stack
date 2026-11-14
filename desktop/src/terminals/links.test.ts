import { describe, expect, it } from 'vitest';
import { findFiles, findUrls, resolveFile } from './links';

const urls = (t: string) => findUrls(t).map((u) => u.url);

describe('findUrls', () => {
  it('finds http and https URLs with their offsets', () => {
    expect(findUrls('PR: https://github.com/a/b/pull/1 ok')).toEqual([{ url: 'https://github.com/a/b/pull/1', start: 4, end: 33 }]);
    expect(urls('dev on http://localhost:5173/x and https://x.dev')).toEqual(['http://localhost:5173/x', 'https://x.dev']);
  });

  it('drops trailing sentence punctuation and unbalanced brackets', () => {
    expect(urls('see https://x.dev/a.')).toEqual(['https://x.dev/a']);
    expect(urls('(https://x.dev/a)')).toEqual(['https://x.dev/a']);
    expect(urls('[link](https://x.dev/a).')).toEqual(['https://x.dev/a']);
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('stops at quotes and whitespace, ignores a bare scheme', () => {
    expect(urls('"https://x.dev/q?a=1"')).toEqual(['https://x.dev/q?a=1']);
    expect(urls('https:// nothing')).toEqual([]);
  });
});

describe('findFiles', () => {
  const files = (t: string) => findFiles(t).map((f) => [f.path, f.line, f.column]);

  it('finds the paths agents print, with their line', () => {
    expect(files('⏺ Update(src/code/CodeService.ts)')).toEqual([['src/code/CodeService.ts', undefined, undefined]]);
    expect(files('see apps/operational/src/Locator.php:61 and lib/a.ts:12:5')).toEqual([['apps/operational/src/Locator.php', 61, undefined], ['lib/a.ts', 12, 5]]);
    expect(files('Foo.php:42 is wrong')).toEqual([['Foo.php', 42, undefined]]);
    expect(files('in /Users/me/repo/x.php (line 9).')).toEqual([['/Users/me/repo/x.php', 9, undefined]]);
    expect(files('src/a.ts#L30, ./b/c.tsx:3-8')).toEqual([['src/a.ts', 30, undefined], ['./b/c.tsx', 3, undefined]]);
  });

  it('covers the whole place for the underline', () => {
    const [f] = findFiles('at src/a.ts:12:5 now');
    expect('at src/a.ts:12:5 now'.slice(f.start, f.end)).toBe('src/a.ts:12:5');
  });

  it('leaves prose, versions, hosts and URLs alone', () => {
    expect(files('e.g. Node.js works, v1.2.3 too, example.com')).toEqual([]);
    expect(files('open https://x.dev/src/a.ts now')).toEqual([]);
    expect(files('done.')).toEqual([]);
  });
});

describe('resolveFile', () => {
  const main = { id: 'main', path: '/r' };
  const task = { id: 't', path: '/r/.worktrees/t' };
  it('reads relative paths in the pane\'s worktree and absolute ones in whichever holds them', () => {
    expect(resolveFile('src/a.ts', task, [main, task])).toEqual({ worktreeId: 't', path: 'src/a.ts' });
    expect(resolveFile('./src/a.ts', task, [main, task])).toEqual({ worktreeId: 't', path: 'src/a.ts' });
    expect(resolveFile('/r/.worktrees/t/x.php', main, [main, task])).toEqual({ worktreeId: 't', path: 'x.php' });
    expect(resolveFile('/r/y.php', task, [main, task])).toEqual({ worktreeId: 'main', path: 'y.php' });
    expect(resolveFile('~/r/y.php', task, [main, task], '')).toBeUndefined();
  });
  it('refuses what lies outside every worktree', () => {
    expect(resolveFile('/etc/hosts.conf', task, [main, task])).toBeUndefined();
    expect(resolveFile('../other/a.ts', task, [main, task])).toBeUndefined();
    expect(resolveFile('a.ts', undefined, [main, task])).toBeUndefined();
  });
});
