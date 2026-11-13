import { defaultCodeConfig, phpFilterOf } from '../../src/code/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filterKey, PhpBase, phpTops, resolveBaseRef, type PhpBaseDeps, type Pipe, type Run } from '../../src/code/phpBase';
import { fakeSpawn, settle, type FakeServer } from './fakeLsp';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('resolveBaseRef', () => {
  const refs = (known: Record<string, string>): Run => async (_c, args) => {
    const ref = args[args.length - 1].replace(/\^\{commit\}$/, '');
    return known[ref] ? { code: 0, stdout: `${known[ref]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
  };
  it('prefers origin/<branch>, then the local branch, then the main checkout', async () => {
    expect(await resolveBaseRef(refs({ 'origin/develop': SHA_A, develop: SHA_B, HEAD: SHA_B }), '/r', 'develop')).toEqual({ ref: 'origin/develop', commit: SHA_A });
    expect(await resolveBaseRef(refs({ develop: SHA_B, HEAD: SHA_A }), '/r', 'develop')).toEqual({ ref: 'develop', commit: SHA_B });
    expect(await resolveBaseRef(refs({ HEAD: SHA_A }), '/r', 'develop')).toEqual({ ref: 'HEAD', commit: SHA_A });
    expect(await resolveBaseRef(refs({ HEAD: SHA_A }), '/r', undefined)).toEqual({ ref: 'HEAD', commit: SHA_A });
    expect(await resolveBaseRef(refs({}), '/r', 'develop')).toBeUndefined();
  });
});

describe('phpTops', () => {
  it('lists the top-level entries holding PHP, never vendor, plus Composer\'s files', async () => {
    const run: Run = async () => ({ code: 0, stdout: 'lib/a/A.php\0www/b.php\0vendor/x/X.php\0frontend/app.ts\0composer.json\0composer.lock\0rector.php\0.worktrees/t/lib/A.php\0', stderr: '' });
    expect(await phpTops(run, '/r', SHA_A)).toEqual(['composer.json', 'composer.lock', 'lib', 'rector.php', 'www']);
  });
});

describe('PhpBase', () => {
  let tmp: string, repo: string, dir: string;
  let commit: string;
  let diff: string;
  let spawned: ReturnType<typeof fakeSpawn>;
  let pipes: Array<{ a: string[]; b: string[] }>;
  let busy: boolean;
  let lsTree: string;

  const run = vi.fn<Run>(async (_cmd, args) => {
    if (args.includes('rev-parse')) return args.some((a) => a.startsWith('origin/develop')) ? { code: 0, stdout: `${commit}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
    if (args.includes('ls-tree')) return { code: 0, stdout: lsTree, stderr: '' };
    if (args.includes('diff')) return { code: 0, stdout: diff, stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  });
  /** `git archive … | tar -x -C <src>`: writes each named file (or lib/A.php for a whole-tree extraction). */
  const pipe: Pipe = async ([, a], [, b]) => {
    pipes.push({ a, b });
    const src = b[b.indexOf('-C') + 1];
    const named = a.slice(a.indexOf('--') + 1);
    for (const f of named.some((n) => n.startsWith(':(glob)')) ? ['lib/A.php', 'composer.json'] : named) {
      fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
      fs.writeFileSync(path.join(src, f), `<?php // ${commit}\n`);
    }
    return { code: 0, stderr: '' };
  };
  const make = (over: Partial<PhpBaseDeps> = {}): PhpBase => new PhpBase(repo, dir, {
    run, pipe, spawn: spawned.spawn, now: () => 1000, sleep: () => settle(), log: () => {},
    discard: (d) => fs.rmSync(d, { recursive: true, force: true }),
    baseBranch: () => 'develop', busy: () => busy,
    spec: (xdg, view) => ({ id: 'phpactor', command: 'php', args: ['phpactor.phar', 'language-server'], env: { XDG_CACHE_HOME: path.join(xdg, 'cache') }, view }),
    ...over,
  });
  /** Plays the server: once the nth Phpactor is up, it indexes (and writes an index) and says so. */
  const indexes = async (n: number, xdg: string): Promise<FakeServer> => {
    while (spawned.servers.length < n) await settle();
    const server = spawned.servers[n - 1];
    await settle();
    const index = path.join(xdg, 'cache', 'phpactor', 'index', 'view-abc');
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(path.join(index, 'timestamp.v3'), '1');
    server.notify('$/progress', { token: 'i', value: { kind: 'begin', title: 'Indexing workspace' } });
    server.notify('$/progress', { token: 'i', value: { kind: 'report', message: '5/10 (50%)' } });
    return server;
  };
  const done = (server: FakeServer) => server.notify('$/progress', { token: 'i', value: { kind: 'end' } });

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-phpbase-')));
    repo = path.join(tmp, 'repo');
    dir = path.join(tmp, 'cache', 'phpactor', 'repo-1');
    fs.mkdirSync(repo, { recursive: true });
    commit = SHA_A;
    diff = '';
    lsTree = 'lib/A.php\0composer.json\0frontend/x.ts\0';
    busy = false;
    pipes = [];
    run.mockClear();
    spawned = fakeSpawn();
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('builds from the base branch\'s PHP, extracted from git into the cache, with a low-priority Phpactor it stops when done', async () => {
    const base = make();
    await base.check();
    expect(base.status()).toMatchObject({ state: 'preparing', ref: 'origin/develop', commit: SHA_A });
    const server = await indexes(1, base.xdg);
    expect(pipes[0].a).toEqual(['-C', repo, 'archive', '--format=tar', SHA_A, '--', 'composer.json', ':(glob)lib/**/*.php',
      ':(exclude).git', ':(exclude).worktrees', ':(exclude)vendor', ':(exclude)node_modules']);
    expect(pipes[0].b).toEqual(['-xmf', '-', '-C', base.src]);
    expect(spawned.calls[0]).toMatchObject({ command: 'nice', args: ['-n', '10', 'php', 'phpactor.phar', 'language-server'], cwd: base.view });
    expect(fs.realpathSync(path.join(base.view, 'lib'))).toBe(path.join(base.src, 'lib')); // the view points at the base's sources
    while (base.status().message !== '5/10') await settle();
    expect(base.info()).toBeUndefined(); // nothing may clone it yet
    done(server);
    await base.settled();
    expect(base.status()).toEqual({ state: 'ready', ref: 'origin/develop', commit: SHA_A, message: '' });
    expect(base.info()).toEqual({ ref: 'origin/develop', commit: SHA_A });
    expect(server.killed).toBe(true);
    expect(fs.readdirSync(repo)).toEqual([]); // nothing written in the repository

    await base.check(); // the ref has not moved: nothing to do
    expect(spawned.servers).toHaveLength(1);
  });

  it('catches up incrementally when the ref moves: only the PHP that changed is extracted, removed files are deleted', async () => {
    const base = make();
    await base.check();
    done(await indexes(1, base.xdg));
    await base.settled();
    fs.mkdirSync(path.join(base.src, 'lib', 'old'), { recursive: true });
    fs.writeFileSync(path.join(base.src, 'lib', 'old', 'Gone.php'), '<?php');

    commit = SHA_B;
    diff = 'M\0lib/A.php\0A\0lib/New.php\0D\0lib/old/Gone.php\0M\0vendor/x/X.php\0';
    await base.check();
    expect(base.status()).toMatchObject({ state: 'preparing', commit: SHA_B });
    const server = await indexes(2, base.xdg);
    // While it runs, the record says where it came from: a cut-short update resumes from there.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'base.json'), 'utf8'))).toMatchObject({ commit: SHA_B, ready: false, from: { commit: SHA_A } });
    expect(run.mock.calls.find(([, a]) => a.includes('diff'))?.[1]).toEqual(['-C', repo, 'diff', '--name-status', '-z', '--no-renames', SHA_A, SHA_B, '--', '*.php', 'composer.json', 'composer.lock']);
    expect(pipes[1].a.slice(-3)).toEqual(['--', 'lib/A.php', 'lib/New.php']);
    expect(fs.existsSync(path.join(base.src, 'lib', 'old', 'Gone.php'))).toBe(false);
    expect(fs.readFileSync(path.join(base.src, 'lib', 'A.php'), 'utf8')).toContain(SHA_B);
    done(server);
    await base.settled();
    expect(base.info()).toEqual({ ref: 'origin/develop', commit: SHA_B });
  });

  it('is built again from scratch when the repo\'s PHP settings change, even at the same commit', async () => {
    let filter = phpFilterOf(defaultCodeConfig());
    const base = make({ filter: () => filter });
    await base.check();
    done(await indexes(1, base.xdg));
    await base.settled();
    lsTree = 'lib/A.php\0src/B.php\0composer.json\0';
    filter = phpFilterOf(defaultCodeConfig({ phpIndexDirs: ['src'] }));
    await base.check();
    expect(base.status()).toMatchObject({ state: 'preparing', commit: SHA_A });
    const server = await indexes(2, base.xdg);
    expect(pipes[1].a).toContain(':(glob)src/**/*.php');
    expect(pipes[1].a).not.toContain(':(glob)lib/**/*.php');
    done(server);
    await base.settled();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'base.json'), 'utf8')).filter).toBe(filterKey(filter));
  });

  it('resumes an update that was cut short from where it started', async () => {
    const base = make();
    await base.check();
    done(await indexes(1, base.xdg));
    await base.settled();
    commit = SHA_B;
    diff = 'M\0lib/A.php\0';
    await base.check();
    await indexes(2, base.xdg);
    base.dispose(); // stackd stops

    const again = make();
    expect(again.info()).toBeUndefined();
    await again.check();
    done(await indexes(3, again.xdg));
    await again.settled();
    expect(pipes.filter((p) => p.a.some((x) => x.startsWith(':(glob)')))).toHaveLength(1); // never extracted in full again
    expect(again.info()).toEqual({ ref: 'origin/develop', commit: SHA_B });
  });

  it('leaves the view alone while a task\'s Phpactor holds it, unless the caller claimed it', async () => {
    busy = true;
    const base = make();
    await base.check();
    expect(base.status().state).toBe('none');
    expect(spawned.calls).toHaveLength(0);
    await base.check(true);
    expect(base.status().state).toBe('preparing');
    base.dispose();
  });

  it('has no base for a repository without PHP, and does not look again at the same commit', async () => {
    lsTree = 'src/a.ts\0composer.json\0';
    const base = make();
    await base.check();
    await base.settled();
    expect(base.status().state).toBe('none');
    await base.check();
    expect(run.mock.calls.filter(([, a]) => a.includes('ls-tree'))).toHaveLength(1);
    expect(pipes).toHaveLength(0);
  });

  it('says why it failed, and is not ready', async () => {
    const base = make({ pipe: async () => ({ code: 128, stderr: 'fatal: not a tree object' }) });
    await base.check();
    await base.settled();
    expect(base.status()).toEqual({ state: 'failed', message: 'extracting origin/develop failed: fatal: not a tree object' });
    expect(base.info()).toBeUndefined();
  });

  it('fails when Phpactor dies while indexing', async () => {
    const base = make();
    await base.check();
    const server = await indexes(1, base.xdg);
    server.die(255);
    await base.settled();
    expect(base.status()).toMatchObject({ state: 'failed', message: expect.stringContaining('Phpactor stopped') });
  });
});
