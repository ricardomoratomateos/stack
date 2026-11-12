/** A URL found in a line of terminal text: `[start, end)` are string offsets. */
export interface FoundUrl {
  url: string;
  start: number;
  end: number;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
/** Punctuation that ends a sentence, not the URL ("see https://x.dev/a."). */
const TRAILING = /[.,;:!?'"]+$/;

/** Plain http(s) URLs in `text`, without trailing sentence punctuation or an unbalanced closing bracket. */
export function findUrls(text: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    for (;;) {
      const before = url;
      url = url.replace(TRAILING, '');
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        if (url.endsWith(close) && count(url, close) > count(url, open)) url = url.slice(0, -1);
      }
      if (url === before) break;
    }
    if (/^https?:\/\/[^/]+/.test(url)) out.push({ url, start: m.index!, end: m.index! + url.length });
  }
  return out;
}

const count = (s: string, c: string) => s.split(c).length - 1;

/** Links open on ⌘-click, as in Terminal, iTerm and VS Code: a plain click stays the agent's. */
export const opensLink = (e: MouseEvent) => e.metaKey;
