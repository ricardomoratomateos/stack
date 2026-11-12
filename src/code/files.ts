import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TreeEntry { name: string; dir: boolean }
export interface FileContent { path: string; size: number; text: string; binary?: boolean; tooLarge?: boolean }
export interface ChangedFile { path: string; status: 'A' | 'M' | 'D' | 'R' }

/** Larger files are not sent to the browser. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** One directory, folders first. `.git` is never listed. */
export function listDir(dir: string): TreeEntry[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
    .map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name))) }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export function readTextFile(file: string): FileContent {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Not a file.');
  if (st.size > MAX_FILE_BYTES) return { path: file, size: st.size, tooLarge: true, text: '' };
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return { path: file, size: st.size, binary: true, text: '' };
  return { path: file, size: st.size, text: buf.toString('utf8') };
}

/** The files a unified diff touches, in its order. */
export function changedFiles(unified: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  for (const line of unified.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) { current = { path: header[2], status: 'M' }; out.push(current); continue; }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.status = 'A';
    else if (line.startsWith('deleted file mode')) current.status = 'D';
    else if (line.startsWith('rename to ')) { current.status = 'R'; current.path = line.slice('rename to '.length); }
    else if (line.startsWith('@@')) current = undefined; // the hunks: nothing more to learn from this file
  }
  return out;
}

/** Tracked and untracked-but-not-ignored files of a worktree, relative. Falls back to walking when git fails. */
export function listWorktreeFiles(root: string, run: typeof execFile = execFile): Promise<string[]> {
  return new Promise((resolve) => {
    run('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(walk(root));
      resolve(String(stdout).split('\0').filter(Boolean));
    });
  });
}

const SKIP = new Set(['.git', 'node_modules', '.worktrees', '.DS_Store']);

function walk(root: string, limit = 200_000): string[] {
  const files: string[] = [];
  const visit = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= limit) return;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) visit(path.join(dir, e.name), rel + e.name + '/'); }
      else if (e.isFile()) files.push(rel + e.name);
    }
  };
  visit(root, '');
  return files;
}

/**
 * Quick open: a subsequence match ranked the way an editor does. The whole query inside the file name wins,
 * then contiguous runs and matches at the start of a path segment; `vendor/` sinks.
 */
export function fuzzyFiles(files: readonly string[], query: string, limit: number): string[] {
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (!needle) return files.slice(0, limit);
  const scored: Array<{ f: string; s: number }> = [];
  for (const f of files) {
    const hay = f.toLowerCase();
    const base = hay.lastIndexOf('/') + 1;
    let s = 0;
    const inName = hay.indexOf(needle, base);
    if (inName >= 0) s = 1000 - (inName - base) * 2 - (hay.length - base - needle.length);
    else {
      let at = -1, run = 0, ok = true;
      for (const ch of needle) {
        const next = hay.indexOf(ch, at + 1);
        if (next < 0) { ok = false; break; }
        run = next === at + 1 ? run + 1 : 0;
        s += 1 + run * 3 + (next >= base ? 4 : 0) + (next === 0 || hay[next - 1] === '/' ? 6 : 0);
        at = next;
      }
      if (!ok) continue;
      s -= hay.length / 20;
    }
    if (hay.startsWith('vendor/') || hay.includes('/vendor/')) s -= 200;
    scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s || a.f.length - b.f.length);
  return scored.slice(0, limit).map((x) => x.f);
}
