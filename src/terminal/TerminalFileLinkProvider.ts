import type * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

/** A file-looking token found in a terminal line, before any existence check. */
export interface FileLinkCandidate {
  startIndex: number;
  length: number;
  filePath: string;
  line?: number;
  column?: number;
}

// Path-ish tokens: absolute (/x/y), home (~/x), dot-relative (./x, ../x),
// multi-segment relative (src/foo.ts), or a bare filename with an extension
// (package.json) — each with an optional :line[:col] suffix.
const CANDIDATE_RE =
  /((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)*|[\w.@+-]+(?:\/[\w.@+-]+)+|[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9_]{0,7})(?::(\d+)(?::(\d+))?)?/g;

/**
 * Extracts file-path candidates from one terminal line. Purely lexical — the
 * caller filters against the filesystem, which is what kills false positives
 * (URLs, version strings, prose).
 */
export function extractFileCandidates(text: string): FileLinkCandidate[] {
  const candidates: FileLinkCandidate[] = [];
  CANDIDATE_RE.lastIndex = 0;
  for (let m = CANDIDATE_RE.exec(text); m !== null; m = CANDIDATE_RE.exec(text)) {
    // Skip matches glued to a previous path/word/URL segment (e.g. the
    // `example.com/a/b` tail of `https://example.com/a/b`).
    const before = text[m.index - 1];
    if (before !== undefined && /[\w/.~]/.test(before)) continue;

    let filePath = m[1];
    let length = m[0].length;
    if (m[2] === undefined) {
      // No :line suffix — drop sentence punctuation stuck to the path. The
      // result is never empty: every regex alternative anchors on a character
      // outside the trim set.
      const trimmed = filePath.replace(/[.,;]+$/, '');
      length -= filePath.length - trimmed.length;
      filePath = trimmed;
    }

    candidates.push({
      startIndex: m.index,
      length,
      filePath,
      line: m[2] !== undefined ? Number(m[2]) : undefined,
      column: m[3] !== undefined ? Number(m[3]) : undefined,
    });
  }
  return candidates;
}

export interface TerminalFileLinkDeps {
  /** Base directory used to resolve relative paths for this terminal (its worktree). */
  resolveBase(terminal: vscode.Terminal): string | undefined;
  exists(p: string): boolean;
  open(absPath: string, line?: number, column?: number): Promise<void>;
  /** Overridable for tests; defaults to os.homedir(). */
  home?: string;
}

export interface WorktreeFileLink extends vscode.TerminalLink {
  absPath: string;
  line?: number;
  column?: number;
}

/**
 * Makes file paths printed in foreman terminals clickable. VSCode's built-in
 * link detection can't resolve the relative paths Claude prints (src/foo.ts:12)
 * because the shell runs inside tmux, where cwd tracking is lost — this
 * provider resolves them against the terminal's worktree instead.
 */
export class TerminalFileLinkProvider implements vscode.TerminalLinkProvider<WorktreeFileLink> {
  private home: string;

  constructor(private deps: TerminalFileLinkDeps) {
    this.home = deps.home ?? os.homedir();
  }

  provideTerminalLinks(context: vscode.TerminalLinkContext): WorktreeFileLink[] {
    const base = this.deps.resolveBase(context.terminal);
    if (!base) return [];

    const links: WorktreeFileLink[] = [];
    for (const c of extractFileCandidates(context.line)) {
      const absPath = this.resolve(c.filePath, base);
      if (!this.deps.exists(absPath)) continue;
      links.push({
        startIndex: c.startIndex,
        length: c.length,
        tooltip: 'Open in editor',
        absPath,
        line: c.line,
        column: c.column,
      });
    }
    return links;
  }

  handleTerminalLink(link: WorktreeFileLink): Promise<void> {
    return this.deps.open(link.absPath, link.line, link.column);
  }

  private resolve(filePath: string, base: string): string {
    if (filePath.startsWith('~/')) return path.join(this.home, filePath.slice(2));
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(base, filePath);
  }
}
