import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { phpactorView } from '../../src/code/CodeService';
import { rewriteUris } from '../../src/code/LspProcess';

const tmp: string[] = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-view-')); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('phpactorView', () => {
  it('links only the top-level entries holding PHP (never vendor) plus composer files', () => {
    const root = dir();
    for (const d of ['lib', 'www', 'vendor', 'node_modules', '.worktrees', 'frontend']) fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, 'rector.php'), '<?php');
    fs.writeFileSync(path.join(root, 'composer.json'), '{}');
    const view = path.join(dir(), 'root');
    const v = phpactorView(root, view, () => ['lib/A.php', 'www/b/C.php', 'vendor/x/D.php', 'rector.php', '.worktrees/t/lib/E.php']);
    expect(fs.readdirSync(view).sort()).toEqual(['composer.json', 'lib', 'rector.php', 'www']);
    expect(fs.realpathSync(path.join(view, 'lib'))).toBe(fs.realpathSync(path.join(root, 'lib')));
    expect(v.map).toContainEqual([`${path.join(root, 'lib')}/`, `${path.join(view, 'lib')}/`]);
    expect(v.map).toContainEqual([path.join(root, 'rector.php'), path.join(view, 'rector.php')]);
  });

  it('is rebuilt from scratch each start', () => {
    const root = dir();
    fs.mkdirSync(path.join(root, 'lib'));
    fs.mkdirSync(path.join(root, 'src'));
    const view = path.join(dir(), 'root');
    phpactorView(root, view, () => ['lib/A.php', 'src/B.php']);
    phpactorView(root, view, () => ['lib/A.php']);
    expect(fs.readdirSync(view)).toEqual(['lib']);
  });
});

describe('rewriteUris', () => {
  it('rewrites URIs at the start of JSON strings, both ways', () => {
    const pairs: Array<[string, string]> = [['/repo/lib/', '/view/lib/']];
    const out = rewriteUris(JSON.stringify({ uri: 'file:///repo/lib/A.php', other: 'file:///repo/libx/B.php', text: 'see file:///repo/lib/A.php' }), pairs);
    expect(JSON.parse(out)).toEqual({ uri: 'file:///view/lib/A.php', other: 'file:///repo/libx/B.php', text: 'see file:///repo/lib/A.php' });
    const back = rewriteUris(out, pairs.map(([a, b]) => [b, a]));
    expect(JSON.parse(back).uri).toBe('file:///repo/lib/A.php');
  });
});
