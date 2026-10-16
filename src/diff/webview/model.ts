/**
 * Pure model of a review: the parsed diff, the folder tree beside it, and the
 * rows a file turns into in each view. No DOM and no React in here, so it is
 * testable on its own and the components only decide how things look.
 *
 * The diff is parsed exactly once (diff2html's parser); everything else is
 * derived from that, per file and only when the file is actually shown.
 */
import { parse } from 'diff2html';
import type { DiffBlock, DiffFile } from 'diff2html/lib/types';

export type FileStatus = 'A' | 'M' | 'D' | 'R';
export type Side = 'old' | 'new';

export interface FileEntry {
  /** Position in review order (the order of the folder tree, depth first). */
  index: number;
  /** The path the file has after the change (the old one for a deletion). */
  path: string;
  /** Where it was before; differs from `path` only for renames. */
  oldPath: string;
  status: FileStatus;
  added: number;
  deleted: number;
  binary: boolean;
  blocks: DiffBlock[];
  /** Rows the file renders to (changed + context lines + hunk headers). */
  rowCount: number;
  /** Why it starts collapsed, if it does. */
  heavy?: 'large' | 'generated';
  /** Changes whenever the file's diff does, so a "viewed" tick does not outlive the edit it was for. */
  signature: string;
}

/** Above this many changed lines a file starts collapsed behind a "show" button. */
export const LARGE_FILE_CHANGES = 600;
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.(map|snap|lock)$/;

const NULL_PATH = '/dev/null';

function statusOf(f: DiffFile): FileStatus {
  if (f.isNew) return 'A';
  if (f.isDeleted) return 'D';
  if (f.isRename) return 'R';
  return 'M';
}

function entryOf(f: DiffFile): Omit<FileEntry, 'index'> {
  const path = f.newName && f.newName !== NULL_PATH ? f.newName : f.oldName;
  const oldPath = f.oldName && f.oldName !== NULL_PATH ? f.oldName : path;
  let rowCount = 0;
  for (const b of f.blocks) rowCount += b.lines.length + 1;
  const changes = f.addedLines + f.deletedLines;
  const heavy = GENERATED.test(path) ? 'generated' : changes > LARGE_FILE_CHANGES ? 'large' : undefined;
  return {
    path, oldPath, status: statusOf(f), added: f.addedLines, deleted: f.deletedLines,
    binary: f.isBinary === true, blocks: f.blocks, rowCount,
    ...(heavy ? { heavy } : {}),
    signature: `${path}|${f.addedLines}|${f.deletedLines}|${rowCount}`,
  };
}

// ── Folder tree ──────────────────────────────────────────────────────────────

export interface DirNode {
  /** Compacted name, e.g. `agent/src/brain`. */
  name: string;
  /** Unique id: the full path of the deepest folder in the chain. */
  id: string;
  dirs: DirNode[];
  files: FileEntry[];
  added: number;
  deleted: number;
  fileCount: number;
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });

/** Folders first, then files, each alphabetical; single-child folder chains fold into one node. */
export function buildTree(files: FileEntry[]): DirNode {
  interface Raw { name: string; id: string; dirs: Map<string, Raw>; files: FileEntry[] }
  const root: Raw = { name: '', id: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], id: cur.id ? `${cur.id}/${parts[i]}` : parts[i], dirs: new Map(), files: [] };
        cur.dirs.set(parts[i], next);
      }
      cur = next;
    }
    cur.files.push(f);
  }

  const finish = (raw: Raw, isRoot: boolean): DirNode => {
    let node: Raw = raw;
    let name = raw.name;
    // Fold `a` -> `b` -> `c` into `a/b/c` while each has nothing else in it.
    while (!isRoot && node.files.length === 0 && node.dirs.size === 1) {
      node = [...node.dirs.values()][0];
      name = `${name}/${node.name}`;
    }
    const dirs = [...node.dirs.values()].map((d) => finish(d, false)).sort((a, b) => byName(a.name, b.name));
    const own = [...node.files].sort((a, b) => byName(a.path.slice(a.path.lastIndexOf('/') + 1), b.path.slice(b.path.lastIndexOf('/') + 1)));
    let added = 0, deleted = 0, fileCount = own.length;
    for (const f of own) { added += f.added; deleted += f.deleted; }
    for (const d of dirs) { added += d.added; deleted += d.deleted; fileCount += d.fileCount; }
    return { name, id: node.id, dirs, files: own, added, deleted, fileCount };
  };
  return finish(root, true);
}

/** The files in tree order, which is the order the review reads in. */
export function treeOrder(node: DirNode): FileEntry[] {
  return [...node.dirs.flatMap(treeOrder), ...node.files];
}

export type TreeRow =
  | { type: 'dir'; node: DirNode; depth: number; open: boolean }
  | { type: 'file'; file: FileEntry; depth: number };

/** What the sidebar draws: the tree minus the contents of collapsed folders. */
export function flattenTree(root: DirNode, collapsed: ReadonlySet<string>, openAll = false): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (n: DirNode, depth: number) => {
    for (const d of n.dirs) {
      const open = openAll || !collapsed.has(d.id);
      out.push({ type: 'dir', node: d, depth, open });
      if (open) walk(d, depth + 1);
    }
    for (const f of n.files) out.push({ type: 'file', file: f, depth });
  };
  walk(root, 0);
  return out;
}

/** Every term in the query must appear in the path (case-insensitive). */
export function matchesFilter(path: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = path.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export interface Review {
  files: FileEntry[];
  tree: DirNode;
  added: number;
  deleted: number;
}

/** Parse once; order the files like the tree; index them. */
export function prepareReview(unified: string): Review {
  const raw = unified.trim() ? parse(unified) : [];
  const entries = raw.map((f) => ({ ...entryOf(f), index: 0 }));
  const tree = buildTree(entries);
  const files = treeOrder(tree);
  files.forEach((f, i) => { f.index = i; });
  return { files, tree, added: tree.added, deleted: tree.deleted };
}

/** A tree of just the files that match, for the filtered sidebar. */
export function filterReview(review: Review, query: string): { files: FileEntry[]; tree: DirNode } {
  if (!query.trim()) return { files: review.files, tree: review.tree };
  const files = review.files.filter((f) => matchesFilter(f.path, query));
  return { files, tree: buildTree(files) };
}

// ── Lines ────────────────────────────────────────────────────────────────────

export interface Span { s: number; e: number }

export interface Line {
  kind: 'add' | 'del' | 'ctx';
  oldNo?: number;
  newNo?: number;
  text: string;
  /** Character ranges that changed within the line, when it has a counterpart. */
  marks?: Span[];
}

export interface HunkItem { kind: 'hunk'; block: number; range: string; context: string }
export interface LineItem { kind: 'line'; block: number; line: Line }
export type Item = HunkItem | LineItem;

const TOKEN = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g;
/** Past this a line pair is not worth diffing within; the whole line is the change. */
const MAX_WORD_DIFF_CHARS = 1500;
const MAX_LCS_CELLS = 60_000;

function tokens(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** Ranges (in characters) to highlight on each side to show what changed between two lines. */
export function wordMarks(a: string, b: string): { a: Span[]; b: Span[] } {
  if (a === b || a.length > MAX_WORD_DIFF_CHARS || b.length > MAX_WORD_DIFF_CHARS) return { a: [], b: [] };
  const ta = tokens(a);
  const tb = tokens(b);
  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let suf = 0;
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++;

  const midA = ta.slice(pre, ta.length - suf);
  const midB = tb.slice(pre, tb.length - suf);
  const keepA = new Array<boolean>(midA.length).fill(false);
  const keepB = new Array<boolean>(midB.length).fill(false);

  if (midA.length > 0 && midB.length > 0 && midA.length * midB.length <= MAX_LCS_CELLS) {
    const w = midB.length + 1;
    const dp = new Uint32Array((midA.length + 1) * w);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { keepA[i] = true; keepB[j] = true; i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }

  const spans = (all: string[], keep: boolean[], offset: number): Span[] => {
    const out: Span[] = [];
    let pos = 0;
    // `offset` is the number of leading tokens shared by both lines.
    for (let k = 0; k < offset; k++) pos += all[k].length;
    for (let k = 0; k < keep.length; k++) {
      const len = all[offset + k].length;
      if (!keep[k]) {
        const last = out[out.length - 1];
        if (last && last.e === pos) last.e = pos + len;
        else out.push({ s: pos, e: pos + len });
      }
      pos += len;
    }
    return out;
  };

  const marksA = spans(ta, keepA, pre);
  const marksB = spans(tb, keepB, pre);
  // Two lines that share almost nothing: highlighting everything is noise, the line colour already says it.
  const covered = (m: Span[]) => m.reduce((n, x) => n + x.e - x.s, 0);
  if (covered(marksA) > a.length * 0.8 || covered(marksB) > b.length * 0.8) return { a: [], b: [] };
  return { a: marksA, b: marksB };
}

/** Runs of removed lines followed by added lines are edits of each other; pair them in order. */
function markEdits(dels: Line[], adds: Line[]): void {
  const n = Math.min(dels.length, adds.length);
  for (let i = 0; i < n; i++) {
    const m = wordMarks(dels[i].text, adds[i].text);
    if (m.a.length) dels[i].marks = m.a;
    if (m.b.length) adds[i].marks = m.b;
  }
}

const HUNK = /^@@+ (.+?) @@+ ?(.*)$/;

/** Flatten a file's blocks into hunk headers and lines, word-level marks included. */
export function buildItems(file: Pick<FileEntry, 'blocks'>): Item[] {
  const items: Item[] = [];
  file.blocks.forEach((block, bi) => {
    const m = HUNK.exec(block.header);
    items.push({ kind: 'hunk', block: bi, range: m ? m[1] : '', context: m ? m[2] : block.header });
    let dels: Line[] = [];
    let adds: Line[] = [];
    const flush = () => { markEdits(dels, adds); dels = []; adds = []; };
    for (const l of block.lines) {
      // diff2html keeps the leading +/-/space in `content`.
      const text = l.content.slice(1);
      let line: Line;
      if (l.type === 'insert') { line = { kind: 'add', newNo: l.newNumber, text }; adds.push(line); }
      else if (l.type === 'delete') {
        // A removal after additions starts a new edit.
        if (adds.length) flush();
        line = { kind: 'del', oldNo: l.oldNumber, text };
        dels.push(line);
      } else { flush(); line = { kind: 'ctx', oldNo: l.oldNumber, newNo: l.newNumber, text }; }
      items.push({ kind: 'line', block: bi, line });
    }
    flush();
  });
  return items;
}

export type SplitRow =
  | { kind: 'hunk'; hunk: HunkItem }
  | { kind: 'pair'; block: number; left?: Line; right?: Line };

/** Side-by-side rows: removals sit beside the additions that replace them. */
export function buildSplit(items: Item[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === 'hunk') { rows.push({ kind: 'hunk', hunk: it }); i++; continue; }
    if (it.line.kind === 'ctx') { rows.push({ kind: 'pair', block: it.block, left: it.line, right: it.line }); i++; continue; }
    const dels: Line[] = [];
    const adds: Line[] = [];
    while (i < items.length) {
      const x = items[i];
      if (x.kind !== 'line' || x.line.kind === 'ctx') break;
      (x.line.kind === 'del' ? dels : adds).push(x.line);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ kind: 'pair', block: it.block, left: dels[k], right: adds[k] });
  }
  return rows;
}

// ── Comment anchors ──────────────────────────────────────────────────────────

/** The side and number a click on `line` (or on one half of a split row) anchors a comment to. */
export function anchorOf(line: Line, side?: Side): { side: Side; line: number } | undefined {
  const s: Side = side ?? (line.kind === 'del' ? 'old' : 'new');
  const n = s === 'old' ? line.oldNo : line.newNo;
  return n === undefined ? undefined : { side: s, line: n };
}

export const anchorKey = (side: Side, line: number) => `${side}:${line}`;

/** Every anchor a row answers to: a context line is both the old and the new line. */
export function anchorKeys(line: Line): string[] {
  const keys: string[] = [];
  if (line.kind !== 'add' && line.oldNo !== undefined) keys.push(anchorKey('old', line.oldNo));
  if (line.kind !== 'del' && line.newNo !== undefined) keys.push(anchorKey('new', line.newNo));
  return keys;
}

// ── Small formatting helpers ─────────────────────────────────────────────────

export const fmt = (n: number) => n.toLocaleString('en-US');

export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return { dir: slash >= 0 ? path.slice(0, slash + 1) : '', name: path.slice(slash + 1) };
}

/** Width of the line-number gutter, in `ch`, for the widest number in the file. */
export function gutterChars(file: Pick<FileEntry, 'blocks'>): number {
  let max = 0;
  for (const b of file.blocks) {
    for (const l of b.lines) max = Math.max(max, l.oldNumber ?? 0, l.newNumber ?? 0);
  }
  return Math.max(3, String(max).length);
}

/** Whether `side`/`line` still exists in the file's diff: a comment on a line that is gone has nothing to point at. */
export function hasAnchor(review: Pick<Review, 'files'>, path: string, side: Side, line: number | undefined): boolean {
  const f = review.files.find((x) => x.path === path);
  if (!f) return false;
  if (line === undefined) return true;
  return f.blocks.some((b) => b.lines.some((l) => (side === 'old' ? l.oldNumber : l.newNumber) === line));
}
