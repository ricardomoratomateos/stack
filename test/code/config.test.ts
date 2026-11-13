import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultCodeConfig, phpFilterOf, phpTopsOf, phpWanted } from '../../src/code/config';
import { basePathspecs } from '../../src/code/phpBase';
import { sourceFiles } from '../../src/code/lightIndex';
import { NodeConfig } from '../../src/daemon/NodeConfig';
import { readRepoConfig } from '../../src/config/RepoConfig';

const tmp: string[] = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'code-cfg-')); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('code settings', () => {
  it('defaults: every top with PHP, minus vendor, node_modules, .git and the worktrees directory', () => {
    const f = phpFilterOf(defaultCodeConfig());
    expect(phpTopsOf(f, ['lib/A.php', 'www/B.php', 'vendor/x/C.php', '.worktrees/t/lib/D.php', 'rector.php', 'composer.json', 'app.js']))
      .toEqual(['composer.json', 'lib', 'rector.php', 'www']);
  });

  it('the worktrees directory is always out, whatever it is called', () => {
    const f = phpFilterOf(defaultCodeConfig({ worktreesDirectory: 'zer', phpExcludeDirs: [] }));
    expect(f.exclude).toEqual(['.git', 'zer']);
    expect(phpWanted(f, 'zer/t/lib/A.php')).toBe(false);
    expect(phpWanted(f, 'vendor/x/A.php')).toBe(true); // asked for: vendor indexed
    expect(defaultCodeConfig({ worktreesDirectory: '../wt' }).php.exclude).toEqual(['.git', 'vendor', 'node_modules']);
  });

  it('phpIndexDirs, nested excludes and other extensions', () => {
    const f = phpFilterOf(defaultCodeConfig({ phpIndexDirs: ['lib/modules', './src/'], phpExcludeDirs: ['lib/modules/legacy'], phpExtensions: ['php', '.phtml'] }));
    expect(f.dirs).toEqual(['lib/modules', 'src']);
    expect(f.extensions).toEqual(['php', 'phtml']);
    expect(phpTopsOf(f, ['lib/modules/A.php', 'lib/core/B.php', 'src/v.phtml', 'lib/modules/legacy/C.php', 'www/D.php']))
      .toEqual(['lib/modules', 'src']);
    expect(phpWanted(f, 'lib/modules/legacy/C.php')).toBe(false);
    expect(basePathspecs(f, ['composer.json', 'lib/modules'])).toEqual([
      'composer.json', ':(glob)lib/modules/**/*.php', ':(glob)lib/modules/**/*.phtml',
      ':(exclude).git', ':(exclude).worktrees', ':(exclude)lib/modules/legacy',
    ]);
  });

  it('phpBaseBranch falls back to defaultBaseBranch', () => {
    expect(defaultCodeConfig().php.baseBranch).toBe('develop');
    expect(defaultCodeConfig({ defaultBaseBranch: 'main' }).php.baseBranch).toBe('main');
    expect(defaultCodeConfig({ defaultBaseBranch: 'main', phpBaseBranch: 'release' }).php.baseBranch).toBe('release');
  });

  it('come from the repo file, under the user\'s settings; machine settings only from the user', () => {
    const repo = dir();
    fs.mkdirSync(path.join(repo, '.stack'));
    fs.writeFileSync(path.join(repo, '.stack', 'config.json'), JSON.stringify({
      phpIndexDirs: ['lib'], phpExcludeDirs: ['lib/old'], phpMaxChangedFiles: 100, phpactorOptions: { 'php_code_sniffer.enabled': false },
      phpactorPath: '/nope', phpNavigation: 'yes',
    }));
    const problems = readRepoConfig(repo).problems;
    expect(problems).toContainEqual(expect.stringMatching(/"phpactorPath" is a per-user setting/));
    expect(problems).toContainEqual(expect.stringMatching(/"phpNavigation" must be true or false/));
    const settings = path.join(dir(), 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ phpExcludeDirs: ['x'], codeIdleMinutes: 3, phpactorPath: '/opt/phpactor', phpIndexDirs: 'lib' }));
    const c = new NodeConfig(() => repo, settings).get();
    expect(c.phpIndexDirs).toEqual(['lib']); // the user's is not a list: the repo's
    expect(c.phpExcludeDirs).toEqual(['x']);
    expect(c.phpMaxChangedFiles).toBe(100);
    expect(c.phpactorOptions).toEqual({ 'php_code_sniffer.enabled': false });
    expect(c.phpNavigation).toBe(true);
    expect(c.phpactorPath).toBe('/opt/phpactor');
    expect(c.codeIdleMinutes).toBe(3);
    expect(c.phpBaseOnStart).toBe(true);
  });

  it('JS/TS: skips directory names anywhere and paths only where they are', () => {
    const root = dir();
    for (const f of ['src/a.ts', 'src/dist/b.ts', 'apps/legacy/c.ts', 'apps/new/legacy/d.ts', 'node_modules/x/e.ts']) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), '');
    }
    const rel = (skip: string[]) => sourceFiles(root, 1000, skip).map((f) => path.relative(root, f)).sort();
    expect(rel(['node_modules', 'dist', 'apps/legacy'])).toEqual(['apps/new/legacy/d.ts', 'src/a.ts']);
  });
});
