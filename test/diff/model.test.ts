import { describe, it, expect } from 'vitest';
import {
  anchorKeys, anchorOf, buildItems, buildSplit, buildTree, filterReview, flattenTree, fmt, gutterChars,
  hasAnchor, matchesFilter, prepareReview, splitPath, treeOrder, wordMarks, LARGE_FILE_CHANGES,
  type Line, type LineItem,
} from '../../src/diff/webview/model';

function modified(path: string, lines: string[], head = '@@ -1,3 +1,3 @@ fn()'): string {
  return [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, head, ...lines, ''].join('\n');
}

describe('prepareReview', () => {
  it('is empty for an empty diff', () => {
    expect(prepareReview('  \n').files).toEqual([]);
  });

  it('orders files like the tree: folders first, then files, each alphabetical', () => {
    const r = prepareReview([
      modified('zeta.ts', [' a', '-b', '+c']),
      modified('src/b.ts', [' a', '-b', '+c']),
      modified('src/a/deep.ts', [' a', '-b', '+c']),
      modified('README.md', [' a', '-b', '+c']),
    ].join(''));
    expect(r.files.map((f) => f.path)).toEqual(['src/a/deep.ts', 'src/b.ts', 'README.md', 'zeta.ts']);
    expect(r.files.map((f) => f.index)).toEqual([0, 1, 2, 3]);
  });

  it('totals the additions and deletions', () => {
    const r = prepareReview(modified('a.ts', [' x', '-old', '+new1', '+new2']));
    expect([r.added, r.deleted]).toEqual([2, 1]);
  });

  it('classifies added, deleted, renamed and modified files', () => {
    const r = prepareReview([
      'diff --git a/n.ts b/n.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,1 @@\n+hi\n',
      'diff --git a/d.ts b/d.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/d.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n',
      'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n',
      modified('m.ts', [' a', '-b', '+c']),
    ].join(''));
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(by['n.ts'].status).toBe('A');
    expect(by['d.ts'].status).toBe('D');
    expect(by['d.ts'].oldPath).toBe('d.ts');
    expect(by['new.ts'].status).toBe('R');
    expect(by['new.ts'].oldPath).toBe('old.ts');
    expect(by['m.ts'].status).toBe('M');
  });

  it('flags binary files', () => {
    const r = prepareReview('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n');
    expect(r.files[0].binary).toBe(true);
  });

  it('collapses generated and very large files by default', () => {
    const big = Array.from({ length: LARGE_FILE_CHANGES + 1 }, (_, i) => `+line ${i}`);
    const r = prepareReview([
      modified('package-lock.json', [' a', '-b', '+c']),
      modified('big.ts', [' a', ...big], `@@ -1,1 +1,${LARGE_FILE_CHANGES + 2} @@`),
      modified('small.ts', [' a', '-b', '+c']),
    ].join(''));
    const by = Object.fromEntries(r.files.map((f) => [f.path, f.heavy]));
    expect(by).toEqual({ 'package-lock.json': 'generated', 'big.ts': 'large', 'small.ts': undefined });
  });

  it('gives a file a signature that changes with its diff', () => {
    const a = prepareReview(modified('a.ts', [' x', '-1', '+2'])).files[0].signature;
    const b = prepareReview(modified('a.ts', [' x', '-1', '+2', '+3'], '@@ -1,2 +1,4 @@')).files[0].signature;
    expect(a).not.toBe(b);
  });
});

describe('folder tree', () => {
  const files = (paths: string[]) => prepareReview(paths.map((p) => modified(p, [' a', '-b', '+c'])).join('')).files;

  it('folds single-child folder chains into one node', () => {
    const t = buildTree(files(['agent/src/brain/a.ts', 'agent/src/brain/b.ts', 'web/x.ts']));
    expect(t.dirs.map((d) => d.name)).toEqual(['agent/src/brain', 'web']);
    expect(t.dirs[0].id).toBe('agent/src/brain');
    expect(t.dirs[0].fileCount).toBe(2);
    expect(t.fileCount).toBe(3);
  });

  it('keeps a folder that has files of its own, and aggregates counts upwards', () => {
    const t = buildTree(files(['src/a.ts', 'src/inner/deep/b.ts']));
    const src = t.dirs[0];
    expect(src.name).toBe('src');
    expect(src.dirs[0].name).toBe('inner/deep');
    expect(src.added).toBe(2);
    expect(src.deleted).toBe(2);
  });

  it('lists files in tree order', () => {
    const t = buildTree(files(['b.ts', 'a/x.ts', 'a.ts']));
    expect(treeOrder(t).map((f) => f.path)).toEqual(['a/x.ts', 'a.ts', 'b.ts']);
  });

  it('flattens to rows, hiding the contents of collapsed folders unless a filter is on', () => {
    const t = buildTree(files(['a/x.ts', 'a/y.ts', 'z.ts']));
    const open = flattenTree(t, new Set());
    expect(open.map((r) => (r.type === 'dir' ? `d:${r.node.name}` : `f:${r.file.path}`))).toEqual(['d:a', 'f:a/x.ts', 'f:a/y.ts', 'f:z.ts']);
    expect(open[1]).toMatchObject({ depth: 1 });
    const shut = flattenTree(t, new Set(['a']));
    expect(shut.map((r) => r.type)).toEqual(['dir', 'file']);
    expect(shut[0]).toMatchObject({ open: false });
    expect(flattenTree(t, new Set(['a']), true)).toHaveLength(4);
  });

  it('matches every term of a filter against the path, ignoring case', () => {
    expect(matchesFilter('Src/Brain/Eleven.ts', 'brain eleven')).toBe(true);
    expect(matchesFilter('src/brain/eleven.ts', 'brain zzz')).toBe(false);
    expect(matchesFilter('anything', '   ')).toBe(true);
  });

  it('filters a review down to the matching files and rebuilds their tree', () => {
    const r = prepareReview(['a/x.ts', 'b/y.ts'].map((p) => modified(p, [' a', '-b', '+c'])).join(''));
    expect(filterReview(r, '  ')).toMatchObject({ files: r.files });
    const f = filterReview(r, 'y.ts');
    expect(f.files.map((x) => x.path)).toEqual(['b/y.ts']);
    expect(f.tree.dirs.map((d) => d.name)).toEqual(['b']);
  });
});

describe('wordMarks', () => {
  const cut = (s: string, spans: { s: number; e: number }[]) => spans.map((x) => s.slice(x.s, x.e));

  it('marks just the words that changed', () => {
    const a = 'import { exec, execSync } from "x";';
    const b = 'import { execFile, execFileSync } from "x";';
    const m = wordMarks(a, b);
    expect(cut(a, m.a)).toEqual(['exec', 'execSync']);
    expect(cut(b, m.b)).toEqual(['execFile', 'execFileSync']);
  });

  it('marks a pure insertion on one side only', () => {
    const m = wordMarks('foo(a)', 'foo(a, b)');
    expect(m.a).toEqual([]);
    expect(cut('foo(a, b)', m.b).join('')).toBe(', b');
  });

  it('merges neighbouring changed tokens into one range', () => {
    const b = 'const total = alpha + beta + gamma;';
    const m = wordMarks('const total = one;', b);
    expect(m.b).toHaveLength(1);
    expect(cut(b, m.b)).toEqual(['alpha + beta + gamma']);
  });

  it('marks nothing for identical lines, huge lines, or lines that share almost nothing', () => {
    expect(wordMarks('same', 'same')).toEqual({ a: [], b: [] });
    expect(wordMarks('x'.repeat(2000), 'y'.repeat(2000))).toEqual({ a: [], b: [] });
    expect(wordMarks('completely different words', 'nothing alike here at all')).toEqual({ a: [], b: [] });
  });

  it('falls back to the whole changed middle when the lines are too long to align', () => {
    const a = `start ${Array.from({ length: 200 }, (_, i) => `a${i}`).join(' ')} end`;
    const b = `start ${Array.from({ length: 200 }, (_, i) => `b${i}`).join(' ')} end`;
    expect(wordMarks(a, b)).toEqual({ a: [], b: [] }); // all of it changed: noise, so no marks
  });

  it('marks nothing when a line was entirely emptied or filled: the line colour says it', () => {
    expect(wordMarks('', 'x')).toEqual({ a: [], b: [] });
  });
});

describe('buildItems / buildSplit', () => {
  const file = (lines: string[], head?: string) => prepareReview(modified('a.ts', lines, head)).files[0];
  const lines = (items: ReturnType<typeof buildItems>) => items.filter((i): i is LineItem => i.kind === 'line').map((i) => i.line);

  it('numbers lines on both sides and strips the diff prefix', () => {
    const items = buildItems(file([' keep', '-gone', '+came', ' tail'], '@@ -10,3 +20,3 @@ ctx'));
    expect(items[0]).toEqual({ kind: 'hunk', block: 0, range: '-10,3 +20,3', context: 'ctx' });
    expect(lines(items).map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ['ctx', 10, 20, 'keep'], ['del', 11, undefined, 'gone'], ['add', undefined, 21, 'came'], ['ctx', 12, 22, 'tail'],
    ]);
  });

  it('keeps an unparseable header as the hunk context', () => {
    expect(buildItems({ blocks: [{ oldStartLine: 1, newStartLine: 1, header: 'weird', lines: [] }] })[0])
      .toMatchObject({ range: '', context: 'weird' });
  });

  it('marks the words that changed between a removed line and the one that replaces it', () => {
    const l = lines(buildItems(file(['-let a = 1;', '+let b = 1;'])));
    expect(l[0].marks).toEqual([{ s: 4, e: 5 }]);
    expect(l[1].marks).toEqual([{ s: 4, e: 5 }]);
  });

  it('pairs edits in order and leaves the surplus unmarked', () => {
    const l = lines(buildItems(file(['-one a', '-two b', '+one z'], '@@ -1,2 +1,1 @@')));
    expect(l[0].marks).toEqual([{ s: 4, e: 5 }]);
    expect(l[1].marks).toBeUndefined();
  });

  it('starts a new edit when a removal follows additions', () => {
    const l = lines(buildItems(file(['+first new', '-old x', '+new x'], '@@ -1,1 +1,2 @@')));
    expect(l.map((x) => x.kind)).toEqual(['add', 'del', 'add']);
    expect(l[1].marks).toEqual([{ s: 0, e: 3 }]);
    expect(l[0].marks).toBeUndefined();
  });

  it('lays removals beside the additions that replace them in split view', () => {
    const rows = buildSplit(buildItems(file([' ctx', '-d1', '-d2', '+a1', ' end'], '@@ -1,4 +1,3 @@')));
    expect(rows.map((r) => (r.kind === 'hunk' ? 'hunk' : `${r.left?.text ?? '_'}|${r.right?.text ?? '_'}`))).toEqual([
      'hunk', 'ctx|ctx', 'd1|a1', 'd2|_', 'end|end',
    ]);
  });

  it('leaves the left empty for a pure addition and the right for a pure removal', () => {
    const rows = buildSplit(buildItems(file(['+only new', ' ctx', '-only old'], '@@ -1,2 +1,2 @@')));
    const pairs = rows.filter((r) => r.kind === 'pair') as { left?: Line; right?: Line }[];
    expect(pairs.map((p) => [!!p.left, !!p.right])).toEqual([[false, true], [true, true], [true, false]]);
  });
});

describe('comment anchors', () => {
  const del: Line = { kind: 'del', oldNo: 7, text: 'x' };
  const add: Line = { kind: 'add', newNo: 9, text: 'y' };
  const ctx: Line = { kind: 'ctx', oldNo: 4, newNo: 6, text: 'z' };

  it('anchors a removed line to the old file and everything else to the new one', () => {
    expect(anchorOf(del)).toEqual({ side: 'old', line: 7 });
    expect(anchorOf(add)).toEqual({ side: 'new', line: 9 });
    expect(anchorOf(ctx)).toEqual({ side: 'new', line: 6 });
  });

  it('honours the half of a split row that was clicked, and never mixes the numberings', () => {
    expect(anchorOf(ctx, 'old')).toEqual({ side: 'old', line: 4 });
    expect(anchorOf(ctx, 'new')).toEqual({ side: 'new', line: 6 });
    expect(anchorOf(del, 'new')).toBeUndefined();
    expect(anchorOf(add, 'old')).toBeUndefined();
  });

  it('answers to both numberings on a context line, and one otherwise', () => {
    expect(anchorKeys(ctx)).toEqual(['old:4', 'new:6']);
    expect(anchorKeys(del)).toEqual(['old:7']);
    expect(anchorKeys(add)).toEqual(['new:9']);
  });

  it('knows whether a commented line is still in the diff', () => {
    const r = prepareReview(modified('a.ts', [' keep', '-gone', '+came'], '@@ -5,2 +5,2 @@'));
    expect(hasAnchor(r, 'a.ts', 'old', 6)).toBe(true);
    expect(hasAnchor(r, 'a.ts', 'new', 6)).toBe(true);
    expect(hasAnchor(r, 'a.ts', 'new', 99)).toBe(false);
    expect(hasAnchor(r, 'a.ts', 'new', undefined)).toBe(true);
    expect(hasAnchor(r, 'other.ts', 'new', 5)).toBe(false);
  });
});

describe('small helpers', () => {
  it('formats counts with thousands separators', () => expect(fmt(1234567)).toBe('1,234,567'));
  it('splits a path into folder and name', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b/', name: 'c.ts' });
    expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' });
  });
  it('sizes the gutter for the widest line number, at least three digits', () => {
    expect(gutterChars(prepareReview(modified('a.ts', [' a', '-b', '+c'])).files[0])).toBe(3);
    expect(gutterChars(prepareReview(modified('a.ts', [' a', '-b', '+c'], '@@ -1998,3 +1998,3 @@')).files[0])).toBe(4);
  });
});
