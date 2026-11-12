import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dependencyRoots, PathRefused, resolveInWorktree, resolveReadable } from '../../src/code/pathGuard';
import { changedFiles, fuzzyFiles, listDir, listWorktreeFiles, MAX_FILE_BYTES, readTextFile } from '../../src/code/files';

describe('code browser: what may be read', () => {
  let tmp: string, repo: string, wt: string, outside: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-code-')));
    repo = path.join(tmp, 'repo');
    wt = path.join(repo, '.worktrees', 'task');
    outside = path.join(tmp, 'outside');
    for (const d of [path.join(wt, 'src'), path.join(repo, 'node_modules', 'pkg'), path.join(repo, 'vendor', 'acme'), outside]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.d.ts'), 'export {};\n');
    fs.writeFileSync(path.join(repo, 'vendor', 'acme', 'A.php'), '<?php\n');
    fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=1\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'no\n');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads inside the worktree and nowhere else', () => {
    const scope = { root: wt };
    expect(resolveReadable(scope, path.join(wt, 'src', 'a.ts'))).toBe(path.join(wt, 'src', 'a.ts'));
    expect(resolveReadable(scope, wt)).toBe(wt);
    expect(() => resolveReadable(scope, path.join(outside, 'secret.txt'))).toThrow(PathRefused);
    expect(() => resolveReadable(scope, path.join(repo, 'secret.env'))).toThrow('Outside the task\'s worktree.');
    expect(() => resolveReadable(scope, path.join(wt, '..', '..', 'secret.env'))).toThrow(PathRefused);
    expect(() => resolveReadable(scope, '/etc/passwd')).toThrow(PathRefused);
  });

  it('refuses relative paths, non-strings and files that do not exist', () => {
    const scope = { root: wt };
    expect(() => resolveReadable(scope, 'src/a.ts')).toThrow('An absolute path is required.');
    expect(() => resolveReadable(scope, undefined)).toThrow(PathRefused);
    expect(() => resolveReadable(scope, path.join(wt, 'nope.ts'))).toThrow('No such file.');
  });

  it('judges a symlink by where it leads', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(wt, 'innocent.txt'));
    fs.symlinkSync(outside, path.join(wt, 'linked'));
    expect(() => resolveReadable({ root: wt }, path.join(wt, 'innocent.txt'))).toThrow(PathRefused);
    expect(() => resolveReadable({ root: wt }, path.join(wt, 'linked', 'secret.txt'))).toThrow(PathRefused);
  });

  it('allows the extra read-only roots, but not as the worktree itself', () => {
    const scope = { root: wt, extras: [path.join(repo, 'node_modules')] };
    const dep = path.join(repo, 'node_modules', 'pkg', 'index.d.ts');
    expect(resolveReadable(scope, dep)).toBe(dep);
    expect(() => resolveInWorktree(scope, dep)).toThrow(PathRefused);
    expect(() => resolveReadable(scope, path.join(repo, 'secret.env'))).toThrow(PathRefused);
    expect(resolveReadable({ root: wt, extras: [path.join(tmp, 'gone')] }, path.join(wt, 'src', 'a.ts'))).toBe(path.join(wt, 'src', 'a.ts'));
  });

  it('finds the main checkout\'s dependencies a worktree links to, and only those', () => {
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
    fs.mkdirSync(path.join(wt, 'frontend', 'app'), { recursive: true });
    fs.symlinkSync(outside, path.join(wt, 'frontend', 'app', 'node_modules')); // leads out of the repository: ignored
    fs.mkdirSync(path.join(wt, 'tools', 'node_modules'), { recursive: true }); // a real directory is inside the worktree anyway
    const roots = dependencyRoots(wt, repo);
    expect(roots.sort()).toEqual([path.join(repo, 'node_modules'), path.join(repo, 'vendor')].sort());
    expect(dependencyRoots(wt, path.join(tmp, 'missing'))).toEqual([]);
  });
});

describe('code browser: files', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-files-'))); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists a directory, folders first, without .git', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'b.txt'), '');
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    fs.symlinkSync(path.join(dir, 'src'), path.join(dir, 'link'));
    expect(listDir(dir)).toEqual([{ name: 'link', dir: true }, { name: 'src', dir: true }, { name: 'a.txt', dir: false }, { name: 'b.txt', dir: false }]);
  });

  it('reads text, and says so instead of sending binaries or huge files', () => {
    fs.writeFileSync(path.join(dir, 't.txt'), 'hola');
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(dir, 'big.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
    expect(readTextFile(path.join(dir, 't.txt'))).toMatchObject({ text: 'hola', size: 4 });
    expect(readTextFile(path.join(dir, 'b.bin'))).toMatchObject({ binary: true, text: '' });
    expect(readTextFile(path.join(dir, 'big.txt'))).toMatchObject({ tooLarge: true, text: '' });
    expect(() => readTextFile(dir)).toThrow('Not a file.');
  });

  it('reads the changed files out of a unified diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-new file mode in a line of code', '+x',
      'diff --git a/src/new.php b/src/new.php', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.php', '@@ -0,0 +1 @@', '+<?php',
      'diff --git a/old.txt b/old.txt', 'deleted file mode 100644',
      'diff --git a/x.ts b/y.ts', 'similarity index 100%', 'rename from x.ts', 'rename to y.ts',
    ].join('\n');
    expect(changedFiles(diff)).toEqual([
      { path: 'src/a.ts', status: 'M' }, { path: 'src/new.php', status: 'A' }, { path: 'old.txt', status: 'D' }, { path: 'y.ts', status: 'R' },
    ]);
    expect(changedFiles('')).toEqual([]);
  });

  it('ranks quick open like an editor', () => {
    const files = ['vendor/acme/Order.php', 'src/Order/OrderLine.php', 'src/Order.php', 'src/other/reorder.ts', 'README.md'];
    expect(fuzzyFiles(files, 'order', 3)).toEqual(['src/Order.php', 'src/Order/OrderLine.php', 'src/other/reorder.ts']);
    expect(fuzzyFiles(files, 'sool', 5)).toEqual(['src/Order/OrderLine.php']); // a subsequence across the path
    expect(fuzzyFiles(files, '', 2)).toEqual(files.slice(0, 2));
    expect(fuzzyFiles(files, 'zzz', 5)).toEqual([]);
  });

  it('lists a worktree with git, and by walking when git cannot', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), '');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '');
    const git = ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(null, 'src/a.ts\0b.ts\0')) as never;
    expect(await listWorktreeFiles(dir, git)).toEqual(['src/a.ts', 'b.ts']);
    const broken = ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(new Error('not a repository'), '')) as never;
    expect(await listWorktreeFiles(dir, broken)).toEqual(['src/a.ts']);
  });
});
