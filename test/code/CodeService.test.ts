import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeError, CodeService, phpactorRepoKey, NAVIGATION_METHODS, type CodeOptions, type CodeTask } from '../../src/code/CodeService';
import { LspProcess } from '../../src/code/LspProcess';
import { PathRefused } from '../../src/code/pathGuard';
import { fakeSpawn, settle } from './fakeLsp';

describe('LspProcess', () => {
  const spec = { id: 'srv', command: 'srv', args: ['--stdio'], init: { a: 1 }, config: (section: string | undefined) => (section === 'x' ? { on: true } : null) };

  it('initializes, then answers requests, whole frames or split ones', async () => {
    const { spawn, servers, calls } = fakeSpawn();
    const proc = new LspProcess(spec, '/work', spawn);
    await proc.ready;
    expect(calls[0]).toMatchObject({ command: 'srv', args: ['--stdio'], cwd: '/work' });
    const init = servers[0].sent('initialize')[0].params as { rootUri: string; initializationOptions: unknown };
    expect(init.rootUri).toBe('file:///work');
    expect(init.initializationOptions).toEqual({ a: 1 });
    expect(servers[0].sent('initialized')).toHaveLength(1);
    expect(proc.state).toBe('ready');

    servers[0].silent = true;
    const pending = proc.request('textDocument/hover', { q: 1 });
    await settle();
    servers[0].send({ jsonrpc: '2.0', id: servers[0].sent('textDocument/hover')[0].id, result: { contents: 'hi' } }, true);
    expect(await pending).toEqual({ contents: 'hi' });
  });

  it('answers what the server asks of its client', async () => {
    const { spawn, servers } = fakeSpawn();
    const proc = new LspProcess(spec, '/work', spawn);
    await proc.ready;
    servers[0].send({ jsonrpc: '2.0', id: 90, method: 'workspace/configuration', params: { items: [{ section: 'x' }, { section: 'y' }] } });
    servers[0].send({ jsonrpc: '2.0', id: 91, method: 'workspace/workspaceFolders' });
    servers[0].send({ jsonrpc: '2.0', id: 92, method: 'window/workDoneProgress/create', params: {} });
    const answers = servers[0].received.filter((m) => m.method === undefined);
    expect(answers.map((a) => [a.id, a.result])).toEqual([[90, [{ on: true }, null]], [91, [{ uri: 'file:///work', name: 'work' }]], [92, null]]);
  });

  it('follows indexing progress, and knows when an index has been built', async () => {
    const { spawn, servers } = fakeSpawn();
    const proc = new LspProcess(spec, '/work', spawn);
    await proc.ready;
    servers[0].notify('$/progress', { token: 't1', value: { kind: 'begin', title: 'Finding references' } });
    expect(proc.status()).toMatchObject({ state: 'indexing', message: 'Finding references' });
    servers[0].notify('$/progress', { token: 't1', value: { kind: 'end' } });
    expect(proc.state).toBe('ready');
    expect(proc.indexed).toBe(false); // that was a search, not the index

    servers[0].notify('$/progress', { token: 't2', value: { kind: 'begin', title: 'Indexing workspace' } });
    servers[0].notify('$/progress', { token: 't2', value: { kind: 'report', message: '10/20' } });
    expect(proc.status()).toMatchObject({ state: 'indexing', message: '10/20' });
    servers[0].notify('$/progress', { token: 't2', value: { kind: 'end' } });
    expect(proc.status()).toMatchObject({ state: 'ready', message: '' });
    expect(proc.indexed).toBe(true);
  });

  it('opens a document once, and hands over the diagnostics the server publishes for it', async () => {
    const { spawn, servers } = fakeSpawn();
    const proc = new LspProcess(spec, '/work', spawn);
    await proc.ready;
    proc.ensureOpen('/work/a.ts', 'typescript', 'let a');
    proc.ensureOpen('/work/a.ts', 'typescript', 'let a');
    expect(servers[0].sent('textDocument/didOpen')).toHaveLength(1);

    const asked = proc.diagnosticsFor('/work/a.ts', 5000, () => new Promise(() => {}));
    servers[0].notify('textDocument/publishDiagnostics', { uri: 'file:///work/a.ts', diagnostics: [{ message: 'unused' }] });
    expect(await asked).toEqual([{ message: 'unused' }]);
    expect(await proc.diagnosticsFor('/work/a.ts', 5000, () => Promise.resolve())).toEqual([{ message: 'unused' }]); // kept
    expect(await proc.diagnosticsFor('/work/silent.ts', 10, () => Promise.resolve())).toEqual([]); // gave up waiting
  });

  it('fails what is pending when the server dies, and refuses afterwards', async () => {
    const { spawn, servers } = fakeSpawn();
    const exits = vi.fn();
    const proc = new LspProcess(spec, '/work', spawn, Date.now, exits);
    await proc.ready;
    servers[0].silent = true;
    const pending = proc.request('textDocument/definition', {});
    servers[0].die(2);
    await expect(pending).rejects.toThrow('srv exited (2)');
    expect(proc.state).toBe('dead');
    expect(exits).toHaveBeenCalledTimes(1);
    await expect(proc.request('textDocument/hover', {})).rejects.toThrow('srv exited (2)');
    proc.stop(); // already dead: nothing more
    expect(exits).toHaveBeenCalledTimes(1);
  });

  it('reports a server that could not start instead of taking the daemon down', async () => {
    const { spawn, servers } = fakeSpawn();
    const proc = new LspProcess(spec, '/work', (c, a, o) => { const child = spawn(c, a, o); servers[0].silent = true; return { ...child, stdin: { write: () => { throw new Error('EPIPE'); } } }; });
    await expect(proc.ready).rejects.toThrow('EPIPE');
  });
});

describe('CodeService', () => {
  let tmp: string, repo: string, wt: string, cfg: string, task: CodeTask;
  let spawned: ReturnType<typeof fakeSpawn>;
  const make = (over: Partial<CodeOptions> = {}): CodeService => new CodeService({
    cacheDir: path.join(cfg, 'cache'), toolsDir: path.join(cfg, 'tools'), spawn: spawned.spawn, pathEnv: () => '', idleMs: 600_000,
    pipe, copyIndex: async (from, to) => fs.cpSync(from, to, { recursive: true }), discard: (d) => fs.rmSync(d, { recursive: true, force: true }),
    ...over,
  });
  const uri = (rel: string): string => pathToFileURL(path.join(wt, rel)).href;
  const phpRepo = (): string => path.join(cfg, 'cache', 'phpactor', phpactorRepoKey(repo));
  const BASE = 'b'.repeat(40);
  /** A finished base: its index, and its record (base branch develop, at `commit`). */
  const baseIndex = (stamp = '100', commit = BASE) => {
    const index = path.join(phpRepo(), 'base', 'cache', 'phpactor', 'index', 'view-abc');
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(path.join(index, 'timestamp.v3'), stamp);
    fs.writeFileSync(path.join(index, 'class_1'), 'record');
    fs.writeFileSync(path.join(phpRepo(), 'base.json'), JSON.stringify({ ref: 'origin/develop', commit, ready: true }));
    baseAt = commit;
  };
  let baseAt = BASE;
  const git = (diff: string, dirty = '') => vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes('--verify')) return args.some((a) => a.startsWith('origin/develop')) ? { code: 0, stdout: `${baseAt}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: 'task-sha\n', stderr: '' };
    if (args.includes('ls-tree')) return { code: 0, stdout: 'src/A.php\0', stderr: '' };
    if (args.includes('diff')) return { code: 0, stdout: diff, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: dirty, stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  });
  /** `git archive | tar -x`: the base's sources. */
  const pipe = async (_a: [string, string[]], [, b]: [string, string[]]) => {
    const src = b[b.indexOf('-C') + 1];
    fs.mkdirSync(path.join(src, 'src'), { recursive: true });
    fs.writeFileSync(path.join(src, 'src', 'A.php'), '<?php\nclass A {}\n');
    return { code: 0, stderr: '' };
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-codesvc-')));
    repo = path.join(tmp, 'repo');
    wt = path.join(repo, '.worktrees', 't1');
    cfg = path.join(tmp, 'config');
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'A.php'), '<?php\nclass A {}\n');
    fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=1\n');
    fs.writeFileSync(path.join(cfg, 'tools', 'phpactor.phar'), '');
    task = { id: 't1', root: wt, repoRoot: repo, baseBranch: 'develop' };
    spawned = fakeSpawn();
    baseAt = BASE;
  });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('opens a task: its real root and what it changed', () => {
    const svc = make();
    expect(svc.open(task, 'diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n')).toEqual({ root: wt, changed: [{ path: 'src/a.ts', status: 'A' }] });
  });

  it('lists and reads inside the worktree only', async () => {
    const svc = make();
    expect(svc.tree(task, wt)).toEqual([{ name: 'src', dir: true }]);
    expect(svc.read(task, path.join(wt, 'src', 'a.ts')).text).toBe('export const a = 1;\n');
    expect(() => svc.read(task, path.join(repo, 'secret.env'))).toThrow(PathRefused);
    expect(() => svc.tree(task, repo)).toThrow(PathRefused);
    expect(() => svc.read(task, 'src/a.ts')).toThrow(PathRefused);
    await expect(svc.diagnostics(task, path.join(repo, 'secret.env'))).rejects.toThrow(PathRefused);
    await expect(svc.lsp(task, 'php', 'textDocument/definition', { textDocument: { uri: pathToFileURL(path.join(repo, 'secret.env')).href } })).rejects.toThrow(PathRefused);
    expect(spawned.calls).toHaveLength(0); // refused before any server was started
  });

  it('reads a dependency of the main checkout the worktree links to, but never lists or lints there', async () => {
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.d.ts'), 'export {};\n');
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(wt, 'node_modules'));
    const svc = make();
    expect(svc.read(task, path.join(repo, 'node_modules', 'pkg', 'index.d.ts')).text).toBe('export {};\n');
    expect(() => svc.tree(task, path.join(repo, 'node_modules'))).toThrow(PathRefused);
  });

  it('passes navigation on and nothing else', async () => {
    expect([...NAVIGATION_METHODS].sort()).toEqual(['textDocument/definition', 'textDocument/documentSymbol', 'textDocument/hover', 'textDocument/references', 'workspace/symbol']);
    const svc = make();
    for (const method of ['textDocument/rename', 'textDocument/formatting', 'workspace/executeCommand', 'textDocument/codeAction', 'workspace/applyEdit', 'shutdown']) {
      await expect(svc.lsp(task, 'php', method, {})).rejects.toThrow(`Method not allowed: ${method}`);
    }
    await expect(svc.lsp(task, 'go', 'textDocument/hover', {})).rejects.toThrow(CodeError);
    expect(spawned.calls).toHaveLength(0);
  });

  it('starts Phpactor for a task on its clone of the repo\'s base, with its index outside the repository and auto-config off', async () => {
    baseIndex();
    const svc = make({ run: git('') });
    await expect(svc.lsp(task, 'php', 'textDocument/definition', { textDocument: { uri: uri('src/A.php') }, position: { line: 1, character: 7 } }))
      .rejects.toThrow('Indexing PHP… starting'); // its clone's start-up pass, first
    expect(spawned.calls).toHaveLength(1);
    const call = spawned.calls[0];
    expect(call.command).toBe('php');
    expect(call.args).toEqual(['-d', 'memory_limit=-1', path.join(cfg, 'tools', 'phpactor.phar'), 'language-server']);
    expect(call.cwd).toBe(path.join(phpRepo(), 'view')); // a view of symlinks into the worktree, shared by the repo's tasks
    for (const key of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) expect(call.env[key]).toContain(path.join(phpRepo(), 'tasks', 't1'));
    const init = (spawned.servers[0].sent('initialize')[0].params as { initializationOptions: Record<string, unknown> }).initializationOptions;
    expect(init['language_server_configuration.auto_config']).toBe(false);
    expect(init['language_server.enable_trust_check']).toBe(false);
    expect(init['indexer.exclude_patterns']).toContain('/vendor/**/*');
    expect(init['composer.class_maps_only']).toBe(true);
    expect(init['composer.autoloader_path']).toBe(path.join(repo, 'vendor', 'autoload.php')); // the worktree has no vendor/
    expect(fs.readdirSync(wt)).toEqual(['src']); // nothing appeared in the worktree
    svc.dispose();
  });

  it('says "indexing" until the clone\'s start-up pass is over, then answers', async () => {
    baseIndex();
    const svc = make({ run: git('') });
    const ask = () => svc.lsp(task, 'php', 'textDocument/definition', { textDocument: { uri: uri('src/A.php') }, position: { line: 1, character: 7 } });
    await expect(ask()).rejects.toThrow('Indexing PHP… starting');
    const server = spawned.servers[0];
    server.notify('$/progress', { token: 'i', value: { kind: 'begin', title: 'Indexing workspace' } });
    server.notify('$/progress', { token: 'i', value: { kind: 'report', message: '5/10' } });
    await expect(ask()).rejects.toThrow('Indexing PHP… 5/10');
    expect(svc.status(task)).toEqual([
      { server: 'php base', state: 'ready', message: 'develop @ bbbbbbb' },
      expect.objectContaining({ server: 'phpactor', state: 'indexing', message: '5/10' }),
    ]);
    expect(server.sent('textDocument/definition')).toHaveLength(0);
    server.notify('$/progress', { token: 'i', value: { kind: 'end' } });
    server.answer = () => ({ uri: uri('src/A.php'), range: {} });
    expect(await ask()).toEqual({ uri: uri('src/A.php'), range: {} });
    expect(server.sent('textDocument/didOpen')).toHaveLength(1);
    expect((server.sent('textDocument/didOpen')[0].params as { textDocument: { text: string } }).textDocument.text).toContain('class A');
    expect(spawned.calls).toHaveLength(1); // the same server all along
    svc.dispose();
  });

  it('waits for the repo\'s base while it is built, never building it from a task, then clones it', async () => {
    const svc = make({ run: git(''), sleep: () => settle() });
    const ask = () => svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' });
    await expect(ask()).rejects.toThrow('Preparing develop…');
    while (spawned.servers.length < 1) await settle();
    const builder = spawned.servers[0];
    expect(spawned.calls[0]).toMatchObject({ command: 'nice', cwd: path.join(phpRepo(), 'view') });
    expect(spawned.calls[0].env.XDG_CACHE_HOME).toBe(path.join(phpRepo(), 'base', 'cache'));
    expect(fs.realpathSync(path.join(phpRepo(), 'view', 'src'))).toBe(path.join(phpRepo(), 'base-src', 'src')); // the base's sources, not a checkout
    await settle();
    builder.notify('$/progress', { token: 'i', value: { kind: 'begin', title: 'Indexing workspace' } });
    builder.notify('$/progress', { token: 'i', value: { kind: 'report', message: '5/10 (50%, 20MB)' } });
    while (!svc.status(task)[0]?.message.includes('5/10')) await settle();
    expect(svc.status(task)).toEqual([{ server: 'php base', state: 'indexing', message: 'Preparing develop… 5/10' }]);
    await expect(ask()).rejects.toThrow('Preparing develop… 5/10');
    expect(spawned.calls).toHaveLength(1); // the task waits: no second Phpactor, and the base is not killed for it
    expect(builder.killed).toBe(false);
    // Phpactor writes its index; here it is faked.
    const index = path.join(phpRepo(), 'base', 'cache', 'phpactor', 'index', 'view-abc');
    fs.mkdirSync(index, { recursive: true });
    fs.writeFileSync(path.join(index, 'timestamp.v3'), '1');
    builder.notify('$/progress', { token: 'i', value: { kind: 'end' } });
    await svc.baseSettled(repo);
    expect(builder.killed).toBe(true); // stopped as soon as the base index is done
    await expect(ask()).rejects.toThrow('Indexing PHP');
    expect(spawned.calls[1].env.XDG_CACHE_HOME).toBe(path.join(phpRepo(), 'tasks', 't1', 'cache'));
    expect(fs.existsSync(path.join(phpRepo(), 'tasks', 't1', 'cache', 'phpactor', 'index', 'view-abc', 'timestamp.v3'))).toBe(true);
    svc.dispose();
  });

  it('answers straight away when the task already has its clone of the base', async () => {
    baseIndex();
    const svc = make({ run: git('') });
    await expect(svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' })).rejects.toThrow('Indexing PHP');
    svc.dispose();
    const again = make({ run: git('') });
    expect(await again.lsp(task, 'php', 'workspace/symbol', { query: 'A' })).toBeNull();
    again.dispose();
  });

  it('finds Phpactor: the setting, then PATH, then Stack\'s tools; and says how to get it when there is none', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'phpactor'), '#!/bin/sh\n', { mode: 0o755 });
    const mine = path.join(tmp, 'my-phpactor');
    fs.writeFileSync(mine, '');
    expect(make({ setting: (k) => (k === 'phpactorPath' ? mine : undefined), pathEnv: () => bin }).phpactorCommand())
      .toEqual({ command: 'php', args: ['-d', 'memory_limit=-1', mine, 'language-server'] });
    expect(make({ pathEnv: () => `/nope${path.delimiter}${bin}` }).phpactorCommand()).toEqual({ command: path.join(bin, 'phpactor'), args: ['language-server'] });
    expect(make().phpactorCommand()?.args[2]).toBe(path.join(cfg, 'tools', 'phpactor.phar'));
    expect(make({ setting: () => path.join(tmp, 'missing') }).phpactorCommand()).toBeUndefined(); // a wrong setting is not papered over
    fs.rmSync(path.join(cfg, 'tools', 'phpactor.phar'));
    await expect(make().lsp(task, 'php', 'textDocument/hover', { textDocument: { uri: uri('src/A.php') } })).rejects.toThrow(/needs Phpactor/);
    expect(spawned.calls).toHaveLength(0);
  });

  it('stops a server nobody has asked anything of for ten minutes; a request pushes that back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const svc = make();
    await expect(svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' })).rejects.toThrow('Indexing');
    const first = spawned.servers[0];
    vi.advanceTimersByTime(9 * 60_000);
    await expect(svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' })).rejects.toThrow('Indexing'); // a request: the clock starts again
    vi.advanceTimersByTime(9 * 60_000);
    expect(first.killed).toBe(false);
    expect(svc.status(task)).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    expect(first.killed).toBe(true);
    expect(svc.status(task)).toEqual([]);

    await expect(svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' })).rejects.toThrow('Indexing'); // the next request starts a new one
    expect(spawned.servers).toHaveLength(2);
    svc.dispose();
    expect(spawned.servers[1].killed).toBe(true);
  });

  describe('one index per repo', () => {
    it('clones the base for a task, stamps it as built now and lists for Phpactor only what differs from the base', async () => {
      baseIndex();
      execFileSync('git', ['init', '-q', wt]);
      execFileSync('git', ['-C', wt, 'add', 'src/A.php']);
      fs.writeFileSync(path.join(wt, 'src', 'B.php'), '<?php\nclass B {}\n');
      const run = git('src/A.php\0src/Gone.php\0', '?? src/B.php\0');
      const svc = make({ run, now: () => 5_000_000 });
      await expect(svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' })).rejects.toThrow('Indexing PHP');
      expect(run.mock.calls.find(([, a]) => a.includes('diff'))?.[1]).toEqual(['-C', wt, 'diff', '--name-only', '-z', BASE, 'task-sha', '--', '*.php']);
      const clone = path.join(phpRepo(), 'tasks', 't1', 'cache', 'phpactor', 'index', 'view-abc');
      expect(fs.readFileSync(path.join(clone, 'class_1'), 'utf8')).toBe('record');
      expect(fs.readFileSync(path.join(clone, 'timestamp.v3'), 'utf8')).toBe('5000');
      // As the server sees them (the view), and not the deleted one.
      const view = path.join(phpRepo(), 'view');
      expect(fs.readFileSync(path.join(clone, 'dirty'), 'utf8').split('\n').filter(Boolean).sort()).toEqual([path.join(view, 'src', 'A.php'), path.join(view, 'src', 'B.php')]);
      const base = path.join(phpRepo(), 'base', 'cache', 'phpactor', 'index', 'view-abc');
      expect(fs.readFileSync(path.join(base, 'timestamp.v3'), 'utf8')).toBe('100'); // the base untouched
      expect(fs.existsSync(path.join(base, 'dirty'))).toBe(false);
      expect(spawned.calls[0].env.XDG_CACHE_HOME).toBe(path.join(phpRepo(), 'tasks', 't1', 'cache'));
      expect(spawned.servers[0].sent('textDocument/didSave')).toHaveLength(0);
      svc.dispose();
    });

    it('re-clones when the base has moved on since the task\'s clone', async () => {
      baseIndex();
      const svc = make({ run: git('') });
      await svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' }).catch(() => undefined);
      svc.dispose();
      baseIndex('200', 'c'.repeat(40));
      const again = make({ run: git('') });
      await expect(again.lsp(task, 'php', 'workspace/symbol', { query: 'A' })).rejects.toThrow('Indexing PHP');
      expect(JSON.parse(fs.readFileSync(path.join(phpRepo(), 'tasks', 't1', 'clone.json'), 'utf8'))).toEqual({ base: 'c'.repeat(40), ref: 'origin/develop' });
      again.dispose();
    });

    it('starts one Phpactor for requests that arrive together', async () => {
      baseIndex();
      const svc = make({ run: git('src/A.php\0') });
      const asks = [1, 2, 3, 4].map(() => svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' }).catch((e: Error) => e.message));
      expect(await Promise.all(asks)).toEqual(Array(4).fill('Indexing PHP… starting'));
      expect(spawned.calls).toHaveLength(1);
      svc.dispose();
    });

    it('runs one Phpactor per repo: opening another task stops the first', async () => {
      baseIndex();
      const other = path.join(repo, '.worktrees', 't2');
      fs.mkdirSync(path.join(other, 'src'), { recursive: true });
      const svc = make({ run: git('') });
      await svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' }).catch(() => undefined);
      await svc.lsp({ id: 't2', root: other, repoRoot: repo }, 'php', 'workspace/symbol', { query: 'A' }).catch(() => undefined);
      expect(spawned.servers[0].killed).toBe(true);
      expect(spawned.servers).toHaveLength(2);
      svc.dispose();
    });

    it('indexes the task in full, on its own, when too much differs from the base', async () => {
      baseIndex();
      const many = Array.from({ length: 6100 }, (_, i) => `src/F${i}.php`).join('\0');
      const svc = make({ run: git(many) });
      await expect(svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' })).rejects.toThrow('Indexing PHP');
      expect(fs.existsSync(path.join(phpRepo(), 'tasks', 't1', 'clone.json'))).toBe(false);
      svc.dispose();
    });
  });

  it('forgets a deleted task: its servers and its index on disk', async () => {
    baseIndex();
    const svc = make({ run: git('') });
    await svc.lsp(task, 'php', 'workspace/symbol', { query: 'A' }).catch(() => undefined);
    const dir = path.join(phpRepo(), 'tasks', 't1');
    expect(fs.existsSync(dir)).toBe(true);
    svc.forget('t1');
    expect(spawned.servers[0].killed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(phpRepo(), 'base'))).toBe(true); // the repo's base stays
    expect(svc.status(task)).toEqual([expect.objectContaining({ server: 'php base' })]);
    svc.forget('never-opened'); // nothing to do, nothing thrown
  });

  it('keeps a task id from naming a directory outside the cache', async () => {
    baseIndex();
    const svc = make({ run: git('') });
    const odd: CodeTask = { ...task, id: '../../escape' };
    await svc.lsp(odd, 'php', 'workspace/symbol', {}).catch(() => undefined);
    expect(spawned.calls[0].env.XDG_CACHE_HOME).toContain(path.join(phpRepo(), 'tasks', '.._.._escape'));
    svc.forget(odd.id);
    expect(fs.existsSync(cfg)).toBe(true);
  });
  it('lints PHP with `php -l`', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'No syntax errors detected', stderr: '' })
      .mockResolvedValueOnce({ code: 255, stdout: `PHP Parse error:  syntax error, unexpected token "}" in ${path.join(wt, 'src', 'A.php')} on line 2\n`, stderr: '' })
      .mockResolvedValueOnce({ code: 127, stdout: '', stderr: 'php: command not found' });
    const svc = make({ run });
    const file = path.join(wt, 'src', 'A.php');
    expect(await svc.diagnostics(task, file)).toEqual([]);
    expect(run).toHaveBeenCalledWith('php', ['-l', file], wt);
    expect(await svc.diagnostics(task, file)).toEqual([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1000 } }, severity: 1, source: 'php -l', message: 'syntax error, unexpected token "}"' },
    ]);
    expect(await svc.diagnostics(task, file)).toEqual([]); // no php on this machine: no diagnostics, no failure
  });

  it('lints JS/TS through oxlint with Stack\'s own config, and stays quiet without oxlint', async () => {
    expect(await make().diagnostics(task, path.join(wt, 'src', 'a.ts'))).toEqual([]);
    expect(spawned.calls).toHaveLength(0);

    const bin = path.join(cfg, 'tools', 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'oxlint'), '');
    const svc = make();
    const asked = svc.diagnostics(task, path.join(wt, 'src', 'a.ts'));
    await settle(); await settle();
    spawned.servers[0].notify('textDocument/publishDiagnostics', { uri: uri('src/a.ts'), diagnostics: [{ message: 'no-unused-vars' }] });
    expect(await asked).toEqual([{ message: 'no-unused-vars' }]);
    expect(spawned.calls[0]).toMatchObject({ command: path.join(bin, 'oxlint'), args: ['--lsp'] });
    const config = path.join(cfg, 'cache', 'oxlint.json');
    const init = (spawned.servers[0].sent('initialize')[0].params as { initializationOptions: Array<{ options: { configPath: string } }> }).initializationOptions;
    expect(init[0].options.configPath).toBe(config);
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).jsPlugins).toBeUndefined(); // native rules only: no code from the repository
    expect(await svc.diagnostics(task, path.join(wt, 'src'))).toEqual([]); // not a JS/TS or PHP file
    svc.dispose();
  });

  it('navigates JS/TS without a server', async () => {
    fs.writeFileSync(path.join(wt, 'package.json'), '{}');
    fs.writeFileSync(path.join(wt, 'src', 'b.ts'), 'import { a } from \'./a\';\nexport const b = a;\n');
    const grep = vi.fn().mockResolvedValue([['src/a.ts', 0, 'export const a = 1;'], ['src/b.ts', 0, 'import { a } from \'./a\';'], ['src/b.ts', 1, 'export const b = a;']]);
    const svc = make({ grep });
    const at = { textDocument: { uri: uri('src/b.ts') }, position: { line: 1, character: 17 } };
    expect(await svc.lsp(task, 'typescript', 'textDocument/definition', at)).toEqual([
      { uri: uri('src/a.ts'), range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } } },
    ]);
    const refs = (await svc.lsp(task, 'typescript', 'textDocument/references', at)) as Array<{ uri: string; range: { start: { line: number } } }>;
    expect(refs.map((r) => `${path.basename(r.uri)}:${r.range.start.line}`)).toEqual(['a.ts:0', 'b.ts:0', 'b.ts:1']);
    expect(await svc.lsp(task, 'typescript', 'textDocument/hover', at)).toBeNull();
    expect(await svc.lsp(task, 'typescript', 'textDocument/documentSymbol', { textDocument: { uri: uri('src/b.ts') } })).toEqual([
      expect.objectContaining({ name: 'b', kind: 13 }),
    ]);
    expect(await svc.lsp(task, 'javascript', 'workspace/symbol', { query: 'b' })).toEqual([expect.objectContaining({ name: 'b', containerName: 'src/b.ts' })]);
    await expect(svc.lsp(task, 'typescript', 'textDocument/definition', {})).rejects.toThrow('A document is required.');
    expect(svc.status(task)).toEqual([{ server: 'js/ts', state: 'ready', message: '' }]);
    expect(spawned.calls).toHaveLength(0);
  });
});
