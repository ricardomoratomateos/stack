import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  extractFileCandidates,
  TerminalFileLinkProvider,
  TerminalFileLinkDeps,
} from '../../src/terminal/TerminalFileLinkProvider';

// ─────────────────────────────────────────────────────────────────────────────
// extractFileCandidates — pure lexical extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('extractFileCandidates', () => {
  it('finds a relative multi-segment path with line and column', () => {
    const [c] = extractFileCandidates('fixed in src/adapters/GitCliAdapter.ts:49:12 today');
    expect(c).toEqual({
      startIndex: 9,
      length: 'src/adapters/GitCliAdapter.ts:49:12'.length,
      filePath: 'src/adapters/GitCliAdapter.ts',
      line: 49,
      column: 12,
    });
  });

  it('finds a path with only a line number', () => {
    const [c] = extractFileCandidates('see src/foo.ts:12');
    expect(c).toMatchObject({ filePath: 'src/foo.ts', line: 12, column: undefined });
  });

  it('finds absolute, home-relative, and dot-relative paths', () => {
    const abs = extractFileCandidates('read /Users/x/repo/file.php please');
    expect(abs[0].filePath).toBe('/Users/x/repo/file.php');

    const home = extractFileCandidates('config at ~/projects/my-app/src/x.md');
    expect(home[0].filePath).toBe('~/projects/my-app/src/x.md');

    const dot = extractFileCandidates('run ./scripts/build.sh and ../other/file.ts');
    expect(dot.map((c) => c.filePath)).toEqual(['./scripts/build.sh', '../other/file.ts']);
  });

  it('finds a bare filename with extension', () => {
    const [c] = extractFileCandidates('edit package.json first');
    expect(c).toMatchObject({ startIndex: 5, filePath: 'package.json' });
  });

  it('returns multiple candidates on one line', () => {
    const cs = extractFileCandidates('moved src/a.ts to src/b.ts');
    expect(cs.map((c) => c.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('skips tokens glued to a URL', () => {
    const cs = extractFileCandidates('see https://github.com/user/repo for details');
    expect(cs).toEqual([]);
  });

  it('trims sentence punctuation stuck to a path without line suffix', () => {
    const [c] = extractFileCandidates('the bug lives in src/foo.ts.');
    expect(c.filePath).toBe('src/foo.ts');
    expect(c.length).toBe('src/foo.ts'.length);
  });

  it('keeps the :line suffix inside the clickable range', () => {
    const [c] = extractFileCandidates('(src/foo.ts:3)');
    expect(c.filePath).toBe('src/foo.ts');
    expect(c.line).toBe(3);
    expect(c.length).toBe('src/foo.ts:3'.length);
  });

  it('drops a match that is nothing but punctuation after trimming', () => {
    // "e.g." matches the bare-filename alternative as "e.g" + trailing "." —
    // trimming leaves "e.g", still a candidate; a pure-dot token never matches.
    const cs = extractFileCandidates('e.g. nothing here');
    expect(cs.map((c) => c.filePath)).toEqual(['e.g']);
  });

  it('returns nothing for plain prose', () => {
    expect(extractFileCandidates('no paths in this sentence at all')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TerminalFileLinkProvider — resolution + existence filtering + open
// ─────────────────────────────────────────────────────────────────────────────

const TERMINAL = {} as vscode.Terminal;

function makeProvider(overrides: Partial<TerminalFileLinkDeps> = {}) {
  const deps: TerminalFileLinkDeps = {
    resolveBase: vi.fn(() => '/wt'),
    exists: vi.fn(() => true),
    open: vi.fn(async () => {}),
    home: '/home/rick',
    ...overrides,
  };
  return { provider: new TerminalFileLinkProvider(deps), deps };
}

function linksFor(provider: TerminalFileLinkProvider, line: string) {
  return provider.provideTerminalLinks({ terminal: TERMINAL, line } as vscode.TerminalLinkContext);
}

describe('TerminalFileLinkProvider', () => {
  it('resolves relative paths against the terminal base and carries line/col', () => {
    const { provider } = makeProvider();
    const [link] = linksFor(provider, 'fix src/foo.ts:12:5 now');
    expect(link).toMatchObject({
      absPath: '/wt/src/foo.ts',
      line: 12,
      column: 5,
      tooltip: 'Open in editor',
    });
  });

  it('keeps absolute paths as-is and expands ~/', () => {
    const { provider } = makeProvider();
    const links = linksFor(provider, '/etc/hosts.d/a.conf and ~/notes/x.md');
    expect(links.map((l) => l.absPath)).toEqual(['/etc/hosts.d/a.conf', '/home/rick/notes/x.md']);
  });

  it('defaults home to os.homedir() when not injected', () => {
    const { provider } = makeProvider({ home: undefined });
    const [link] = linksFor(provider, 'open ~/x.md');
    expect(link.absPath.endsWith('/x.md')).toBe(true);
    expect(link.absPath.startsWith('/')).toBe(true);
  });

  it('filters candidates whose resolved path does not exist', () => {
    const { provider } = makeProvider({ exists: (p) => p === '/wt/src/real.ts' });
    const links = linksFor(provider, 'src/real.ts vs src/fake.ts');
    expect(links.map((l) => l.absPath)).toEqual(['/wt/src/real.ts']);
  });

  it('returns no links when the terminal has no resolvable base', () => {
    const { provider, deps } = makeProvider({ resolveBase: () => undefined });
    expect(linksFor(provider, 'src/foo.ts:1')).toEqual([]);
    expect(deps.exists).not.toHaveBeenCalled();
  });

  it('handleTerminalLink delegates to deps.open with path, line, and column', async () => {
    const { provider, deps } = makeProvider();
    const [link] = linksFor(provider, 'src/foo.ts:12:5');
    await provider.handleTerminalLink(link);
    expect(deps.open).toHaveBeenCalledWith('/wt/src/foo.ts', 12, 5);
  });
});
