import { spawn } from 'node:child_process';

/** One line that matched a text search: repo-relative path, 1-based line and column, the line's text (trimmed to ~240 chars). */
export interface TextHit { path: string; line: number; column: number; text: string }

export interface TextSearchResult { hits: TextHit[]; truncated: boolean }

export interface TextSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Directories left out (repo-relative, as `vendor` or `lib/legacy`). */
  exclude?: readonly string[];
  /** Stops reading once this many lines matched. */
  limit?: number;
}

/** The `git grep` argv for a fixed-string search (tracked and untracked, ignored files left out). */
export function textSearchArgs(root: string, query: string, opts: TextSearchOptions = {}): string[] {
  return [
    '-C', root, 'grep', '-n', '--column', '-I', '-F', '--untracked', '--no-color',
    ...(opts.caseSensitive ? [] : ['-i']), ...(opts.wholeWord ? ['-w'] : []),
    '-e', query, '--', '.', ...(opts.exclude ?? []).map((x) => `:(exclude)${x}`),
  ];
}

/** `path:line:column:text`, as `git grep -n --column` prints it. */
export function parseTextHit(raw: string): TextHit | undefined {
  const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(raw);
  if (!m) return undefined;
  const text = m[4].length > 240 ? `${m[4].slice(0, 240)}…` : m[4];
  return { path: m[1], line: Number(m[2]), column: Number(m[3]), text };
}

/** Find in Path: `git grep -F` over the worktree, killed once `limit` hits are read. */
export function textSearch(root: string, query: string, opts: TextSearchOptions = {}): Promise<TextSearchResult> {
  const limit = opts.limit ?? 300;
  return new Promise((resolve, reject) => {
    if (!query) { resolve({ hits: [], truncated: false }); return; }
    const child = spawn('git', textSearchArgs(root, query, opts), { stdio: ['ignore', 'pipe', 'pipe'] });
    const hits: TextHit[] = [];
    let truncated = false;
    let rest = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (truncated) return;
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) {
        const hit = parseTextHit(l);
        if (!hit) continue;
        if (hits.length >= limit) { truncated = true; child.kill(); return; }
        hits.push(hit);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!truncated && rest) { const hit = parseTextHit(rest); if (hit && hits.length < limit) hits.push(hit); }
      // 1 is "nothing matched"; anything else not killed by us is a real failure.
      if (!truncated && code !== 0 && code !== 1) reject(new Error(stderr.trim() || `git grep exited ${code}`));
      else resolve({ hits, truncated });
    });
  });
}
