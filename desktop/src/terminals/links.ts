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

/** A file path found in terminal text (`src/Foo.php:42`), with its line and column when given. */
export interface FoundFile { path: string; line?: number; column?: number; start: number; end: number }

// A path: optional `/`, `./`, `../` or `~/`, segments, and a name with a letter-led extension.
// Then a place: `:42`, `:42:7`, `:42-50`, `#L42`, ` (line 42)`.
const FILE_RE = /(?<![\w@.+\-/~])((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:[:.](\d+))?(?:-\d+)?|#L(\d+)|\s\(lines?\s(\d+))?/g;

/**
 * File paths an agent prints ("Update(src/a.ts)", "src/Foo.php:42", "/abs/x.php"). Only those with a `/` or a line
 * number count, so prose ("e.g.", "Node.js") and bare host names stay text. Inside a URL nothing is a file.
 */
export function findFiles(text: string): FoundFile[] {
  const urls = findUrls(text);
  const out: FoundFile[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    let path = m[1];
    const start = m.index!;
    if (urls.some((u) => start < u.end && start + m[0].length > u.start)) continue;
    const lineText = m[2] ?? m[4] ?? m[5];
    const line = lineText ? Number(lineText) : undefined;
    // A sentence's full stop after a bare name with a line is not part of it; the regex never takes it.
    path = path.replace(/\.+$/, '');
    if (!path.includes('/') && line === undefined) continue;
    if (/^\d/.test(path.split('/').pop()!)) continue; // "1.2.3/x" — versions, not files
    const placeText = m[0].slice(m[1].length);
    out.push({ path, line, column: m[3] ? Number(m[3]) : undefined, start, end: start + m[1].length + placeText.length });
  }
  return out;
}

/** The worktree a path printed in a terminal belongs to, and the path inside it; `cwd` is the pane's worktree. */
export function resolveFile(
  path: string, cwd: { id: string; path: string } | undefined, worktrees: ReadonlyArray<{ id: string; path: string }>, home = '',
): { worktreeId: string; path: string } | undefined {
  const abs = path.startsWith('~/') && home ? `${home}${path.slice(1)}` : path;
  if (abs.startsWith('/')) {
    // The deepest worktree holding it: tasks' worktrees live inside the main checkout.
    const owner = [...worktrees].filter((w) => abs.startsWith(`${w.path.replace(/\/+$/, '')}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    return owner ? { worktreeId: owner.id, path: abs.slice(owner.path.replace(/\/+$/, '').length + 1) } : undefined;
  }
  if (!cwd || path.startsWith('~')) return undefined;
  const rel = path.replace(/^(\.\/)+/, '');
  return rel.startsWith('../') ? undefined : { worktreeId: cwd.id, path: rel };
}
