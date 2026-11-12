import { describe, expect, it } from 'vitest';
import { findUrls } from './links';

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
