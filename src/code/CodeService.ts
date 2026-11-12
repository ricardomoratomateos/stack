import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changedFiles, fuzzyFiles, listDir, listWorktreeFiles, readTextFile, type ChangedFile, type FileContent, type TreeEntry } from './files';
import { LspProcess, spawnLsp, type LspSpec, type LspStatus, type SpawnLsp } from './LspProcess';
import { LightIndex, gitGrep, projectDirOf, type Declaration, type Grep, type Place } from './lightIndex';
import { dependencyRoots, PathRefused, resolveInWorktree, resolveReadable, type ReadScope } from './pathGuard';

/** Something the user should read as is ("indexing…", "Phpactor is not installed"), not a crash. */
export class CodeError extends Error {}

/** The task a request is about: its worktree and the repository it belongs to. */
export interface CodeTask { id: string; root: string; repoRoot: string }

/** Navigation only. Nothing that writes (rename, formatting, code actions, executeCommand) is passed on. */
export const NAVIGATION_METHODS: ReadonlySet<string> = new Set([
  'textDocument/definition', 'textDocument/references', 'textDocument/hover', 'textDocument/documentSymbol', 'workspace/symbol',
]);

export interface RunResult { code: number; stdout: string; stderr: string }
export type Run = (command: string, args: string[], cwd: string) => Promise<RunResult>;

const execRun: Run = (command, args, cwd) => new Promise((resolve) => {
  execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

export interface CodeOptions {
  /** `<configDir>/cache`: indexes and generated configs. Nothing is ever written inside a repository. */
  cacheDir: string;
  /** `<configDir>/tools`: where Stack keeps tools it was given (phpactor.phar, node_modules/.bin/oxlint). */
  toolsDir: string;
  /** A user setting (settings.json), e.g. `phpactorPath`. */
  setting?: (key: string) => string | undefined;
  spawn?: SpawnLsp;
  run?: Run;
  grep?: Grep;
  now?: () => number;
  /** A language server nobody asked anything of for this long is stopped. */
  idleMs?: number;
  /** PATH to look tools up on; default the daemon's. */
  pathEnv?: () => string;
  log?: (line: string) => void;
}

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number; code?: string | number; source?: string; message: string;
}

interface LspLocation { uri: string; range: LspDiagnostic['range'] }

interface Running {
  proc: LspProcess;
  timer?: ReturnType<typeof setTimeout>;
  firstIndex: boolean;
  /** Files to re-index into a cloned index before the first answer (they differ from the base). */
  overlay?: string[];
  /** The main checkout's server: its finished index becomes the repo's base. */
  main?: boolean;
  baseRecorded?: boolean;
  /** Building the repo's base from the main checkout on behalf of a task, which then gets its clone. */
  baseFor?: boolean;
}

/** Past this many differing PHP files, a clone of the base is no shortcut: the task is indexed in full. */
const MAX_OVERLAY = 1500;

interface TaskState {
  repoRoot: string;
  servers: Map<string, Running>;
  files?: Promise<string[]>;
  light: Map<string, { index: Promise<LightIndex>; done: number; total: number; ready: boolean }>;
  extras?: string[];
}

const TEN_MINUTES = 10 * 60 * 1000;
const isPhp = (languageId: string): boolean => languageId === 'php';
const isScript = (languageId: string): boolean => /^(type|java)script(react)?$/.test(languageId);
const scriptLanguage = (file: string): string => (/\.tsx$/.test(file) ? 'typescriptreact' : /\.[cm]?ts$/.test(file) ? 'typescript' : /\.jsx$/.test(file) ? 'javascriptreact' : 'javascript');

/** LSP SymbolKind for the light index's kinds. */
const SYMBOL_KIND: Record<string, number> = { function: 12, class: 5, interface: 11, type: 26, enum: 10, namespace: 3, variable: 13, method: 6, property: 7 };

const location = (p: Place): LspLocation => ({
  uri: pathToFileURL(p.file).href,
  range: { start: { line: p.line, character: p.col }, end: { line: p.line, character: p.col + p.length } },
});

/**
 * What the Code tab asks of the daemon, per task: the worktree's files (guarded), navigation, diagnostics.
 *
 * - PHP: one Phpactor per task, started on the first PHP navigation, with its index under the cache
 *   directory; `vendor/` is not indexed, vendor classes are found through Composer's class maps.
 * - JS/TS: no server. A syntactic index per project (lightIndex.ts) and `git grep`.
 * - Diagnostics: `oxlint --lsp` with Stack's own config for JS/TS, `php -l` for PHP.
 *
 * Servers are stopped after `idleMs` without a request, and when their task is deleted.
 */
export class CodeService {
  private readonly tasks = new Map<string, TaskState>();
  private readonly phpStarts = new Map<string, Promise<Running>>();
  private readonly spawn: SpawnLsp;
  private readonly run: Run;
  private readonly grep: Grep;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: CodeOptions) {
    this.spawn = opts.spawn ?? spawnLsp;
    this.run = opts.run ?? execRun;
    this.grep = opts.grep ?? gitGrep;
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? TEN_MINUTES;
    this.log = opts.log ?? (() => {});
  }

  private state(task: CodeTask): TaskState {
    let s = this.tasks.get(task.id);
    if (!s) { s = { repoRoot: task.repoRoot, servers: new Map(), light: new Map() }; this.tasks.set(task.id, s); }
    return s;
  }

  private scope(task: CodeTask): ReadScope {
    const s = this.state(task);
    s.extras ??= dependencyRoots(task.root, task.repoRoot);
    return { root: task.root, extras: s.extras };
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  /** Opening the tab: where the task lives and what it changed. */
  open(task: CodeTask, unifiedDiff: string): { root: string; changed: ChangedFile[] } {
    return { root: fs.realpathSync(task.root), changed: changedFiles(unifiedDiff) };
  }

  tree(task: CodeTask, dir: unknown): TreeEntry[] {
    return listDir(resolveInWorktree(this.scope(task), dir));
  }

  read(task: CodeTask, file: unknown): FileContent {
    return readTextFile(resolveReadable(this.scope(task), file));
  }

  async files(task: CodeTask, query: string): Promise<{ total: number; files: string[] }> {
    const s = this.state(task);
    s.files ??= listWorktreeFiles(task.root);
    const all = await s.files;
    return { total: all.length, files: fuzzyFiles(all, query, 60) };
  }

  /** The quick-open list is cached; the agent adds files. Called when the tab is opened again. */
  refreshFiles(task: CodeTask): void { this.state(task).files = undefined; }

  // ── Language servers ──────────────────────────────────────────────────────

  private onPath(name: string): string | undefined {
    for (const dir of (this.opts.pathEnv?.() ?? process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
    }
    return undefined;
  }

  /** `phpactorPath` setting, else `phpactor` on PATH, else `<tools>/phpactor.phar`. */
  phpactorCommand(): { command: string; args: string[] } | undefined {
    const configured = this.opts.setting?.('phpactorPath');
    const php = (file: string) => ({ command: 'php', args: ['-d', 'memory_limit=-1', file, 'language-server'] });
    if (configured) return fs.existsSync(configured) ? php(configured) : undefined;
    const found = this.onPath('phpactor');
    if (found) return { command: found, args: ['language-server'] };
    const phar = path.join(this.opts.toolsDir, 'phpactor.phar');
    return fs.existsSync(phar) ? php(phar) : undefined;
  }

  /** `oxlint` on PATH, else `<tools>/node_modules/.bin/oxlint`. */
  oxlintCommand(): string | undefined {
    const local = path.join(this.opts.toolsDir, 'node_modules', '.bin', 'oxlint');
    return this.onPath('oxlint') ?? (fs.existsSync(local) ? local : undefined);
  }

  /**
   * Phpactor's files for a repository. Every task of the repo is served through the same `view` path, so
   * one index fits them all: `base` is the main checkout's (built once, never written by a task), and each
   * task gets `tasks/<id>`, an APFS clone of it (`cp -c`: instant, no disk until it diverges) where only
   * the files that differ from the main checkout are re-indexed. One Phpactor per repo runs at a time.
   */
  private repoDirs(task: CodeTask): { view: string; base: string; task: string } {
    const dir = path.join(this.opts.cacheDir, 'phpactor', phpactorRepoKey(task.repoRoot));
    return { view: path.join(dir, 'view'), base: path.join(dir, 'base'), task: path.join(dir, 'tasks', task.id.replace(/[^A-Za-z0-9._-]/g, '_')) };
  }

  private phpactorSpec(task: CodeTask, dir: string): LspSpec {
    const cmd = this.phpactorCommand();
    if (!cmd) throw new CodeError('PHP navigation needs Phpactor: set "phpactorPath" in ~/.config/stack/settings.json, or put phpactor.phar in ~/.config/stack/tools/.');
    const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data') };
    for (const d of Object.values(env)) fs.mkdirSync(d, { recursive: true });
    const own = path.join(task.root, 'vendor', 'autoload.php');
    const view = phpactorView(task.root, this.repoDirs(task).view);
    return {
      id: 'phpactor',
      ...cmd,
      env,
      view,
      init: {
        // The view is symlinks into the worktree (see phpactorView): the indexer must follow them.
        'indexer.follow_symlinks': true,
        // MUST stay off: left on, Phpactor writes `<project>/.phpactor.json` at start. Nothing is written in a worktree.
        'language_server_configuration.auto_config': false,
        'language_server.enable_trust_check': false, // and never load the worktree's own .phpactor.json
        'language_server.diagnostics_on_open': false,
        'language_server.diagnostics_on_update': false,
        'language_server.diagnostics_on_save': false,
        'indexer.enabled_watchers': ['lsp'],
        // vendor/ is not indexed; a vendor class is still found through Composer's class maps, read as data.
        'indexer.exclude_patterns': ['/vendor/**/*', '/node_modules/**/*', '/.worktrees/**/*', '/.php/**/*'],
        'composer.enable': true,
        'composer.class_maps_only': true,
        'composer.autoloader_path': fs.existsSync(own) ? own : path.join(task.repoRoot, 'vendor', 'autoload.php'),
        'language_server_indexer.workspace_symbol_search_limit': 100,
      },
    };
  }

  /** Whether this task's Phpactor index was built before (then a start only re-validates it, and it answers meanwhile). */
  private hasPhpIndex(dir: string): boolean {
    return indexTimestamps(dir).length > 0;
  }

  private oxlintSpec(task: CodeTask): LspSpec | undefined {
    const command = this.oxlintCommand();
    if (!command) return undefined;
    // Stack's own rules, outside any repository: native rules only, so no plugin code from the repo is run.
    const config = path.join(this.opts.cacheDir, 'oxlint.json');
    fs.mkdirSync(this.opts.cacheDir, { recursive: true });
    fs.writeFileSync(config, JSON.stringify({
      plugins: ['typescript', 'react', 'unicorn', 'jsx-a11y', 'import'],
      categories: { correctness: 'warn' },
      env: { browser: true, es2021: true, node: true },
    }, null, 2));
    return {
      id: 'oxlint', command, args: ['--lsp'],
      init: [{ workspaceUri: pathToFileURL(task.root).href, options: { configPath: config, run: 'onType' } }],
      config: () => ({ configPath: config }),
    };
  }

  private server(task: CodeTask, spec: LspSpec, firstIndex = false): Running {
    const s = this.state(task);
    let running = s.servers.get(spec.id);
    if (!running || running.proc.state === 'dead') {
      const proc = new LspProcess(spec, task.root, this.spawn, this.now);
      running = { proc, firstIndex };
      s.servers.set(spec.id, running);
      this.log(`[code] ${spec.id} started for ${task.id}`);
    }
    this.touch(task.id, spec.id, running);
    return running;
  }

  /** Every request pushes the idle shutdown back. */
  private touch(taskId: string, id: string, running: Running): void {
    if (running.timer) clearTimeout(running.timer);
    running.timer = setTimeout(() => {
      running.proc.stop();
      if (this.tasks.get(taskId)?.servers.get(id) === running) this.tasks.get(taskId)?.servers.delete(id);
      this.log(`[code] ${id} stopped for ${taskId} (idle)`);
    }, this.idleMs);
    running.timer.unref?.();
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  /** One navigation request, answered in LSP shapes whoever answers it. */
  async lsp(task: CodeTask, languageId: string, method: string, params: unknown): Promise<unknown> {
    if (!NAVIGATION_METHODS.has(method)) throw new CodeError(`Method not allowed: ${method}`);
    const p = (params ?? {}) as { textDocument?: { uri?: unknown }; position?: { line?: unknown; character?: unknown }; query?: unknown };
    const uri = p.textDocument?.uri;
    const file = typeof uri === 'string' ? resolveReadable(this.scope(task), fileURLToPath(uri)) : undefined;
    if (isPhp(languageId)) return this.php(task, method, params, file);
    if (isScript(languageId)) return this.script(task, method, p, file);
    throw new CodeError(`No navigation for ${languageId}.`);
  }

  private async php(task: CodeTask, method: string, params: unknown, file: string | undefined): Promise<unknown> {
    const existing = this.state(task).servers.get('phpactor');
    const running = existing && existing.proc.state !== 'dead'
      ? this.server(task, existing.proc.spec)
      : await this.phpStart(task);
    const { proc } = running;
    await proc.ready;
    if (proc.state === 'dead') throw new CodeError(`Phpactor stopped: ${proc.message}`);
    if (running.overlay) {
      const files = running.overlay;
      running.overlay = undefined;
      for (const f of files) { try { proc.save(f, 'php', readTextFile(f).text); } catch { /* gone meanwhile */ } }
      this.log(`[code] phpactor re-indexed ${files.length} changed file(s) for ${task.id}`);
    }
    if (running.main && proc.indexed && !running.baseRecorded) {
      running.baseRecorded = true;
      const head = await this.gitHead(task.repoRoot);
      if (head) fs.writeFileSync(path.join(this.repoDirs(task).base, 'base.json'), JSON.stringify({ head }));
    }
    if (running.baseFor && running.baseRecorded) {
      // The base this task was waiting for is built: switch to the task's own clone of it.
      if (running.timer) clearTimeout(running.timer);
      proc.stop();
      this.state(task).servers.delete('phpactor');
      return this.php(task, method, params, file);
    }
    if (running.baseFor) throw new CodeError(`Indexing PHP (once per repository)… ${proc.state === 'indexing' ? proc.message : 'starting'}`.trim());
    // The first index of a worktree takes a minute or more; until it is built there is nothing to answer from.
    if (running.firstIndex && !proc.indexed) throw new CodeError(`Indexing PHP… ${proc.state === 'indexing' ? proc.message : 'starting'}`.trim());
    running.firstIndex = false;
    if (file) proc.ensureOpen(file, 'php', readTextFile(file).text);
    return proc.request(method, params);
  }

  /**
   * One start at a time per repo. The Code tab asks several things at once (symbols, hover, diagnostics) and
   * a start awaits git; without this each request started its own Phpactor on the same view and index.
   */
  private async phpStart(task: CodeTask): Promise<Running> {
    const inflight = this.phpStarts.get(task.repoRoot);
    if (inflight) {
      await inflight.catch(() => undefined);
      const now = this.state(task).servers.get('phpactor');
      if (now && now.proc.state !== 'dead') return this.server(task, now.proc.spec);
      return this.phpStart(task);
    }
    const p = this.startPhpactor(task);
    this.phpStarts.set(task.repoRoot, p);
    try { return await p; } finally { if (this.phpStarts.get(task.repoRoot) === p) this.phpStarts.delete(task.repoRoot); }
  }

  /** Starts the repo's Phpactor for `task`: the main checkout on the base index, a task on its clone of it. */
  private async startPhpactor(task: CodeTask): Promise<Running> {
    // One server per repo: they all see the same view path.
    for (const [id, other] of this.tasks) {
      const r = other.servers.get('phpactor');
      if (id !== task.id && r && other.repoRoot === task.repoRoot && r.proc.state !== 'dead') {
        if (r.timer) clearTimeout(r.timer);
        r.proc.stop();
        other.servers.delete('phpactor');
        this.log(`[code] phpactor stopped for ${id} (switching to ${task.id})`);
      }
    }
    const dirs = this.repoDirs(task);
    const main = path.resolve(task.root) === path.resolve(task.repoRoot);
    if (main) {
      const r = this.server(task, this.phpactorSpec(task, dirs.base), !this.hasPhpIndex(dirs.base));
      r.main = true;
      return r;
    }
    const base = this.readJson<{ head?: string }>(path.join(dirs.base, 'base.json'));
    if (!base?.head || !this.hasPhpIndex(dirs.base)) {
      // No finished base yet: build it from the main checkout first (once per repo), then clone it for this task.
      const r = this.server(task, this.phpactorSpec({ ...task, root: task.repoRoot }, dirs.base), true);
      r.main = true;
      r.baseFor = true;
      return r;
    }
    const changed = await this.phpChanges(task, base.head);
    if (changed === undefined || changed.length > MAX_OVERLAY) {
      fs.rmSync(dirs.task, { recursive: true, force: true });
      return this.server(task, this.phpactorSpec(task, dirs.task), true);
    }
    const mine = this.readJson<{ base?: string }>(path.join(dirs.task, 'clone.json'));
    if (mine?.base !== base.head || !this.hasPhpIndex(dirs.task)) cloneIndex(dirs.base, dirs.task, base.head, this.now());
    const r = this.server(task, this.phpactorSpec(task, dirs.task), false);
    r.overlay = changed.map((f) => path.join(task.root, f)).filter((f) => fs.existsSync(f));
    return r;
  }

  /** PHP files that may differ between the base index (main checkout at `baseHead`) and the task, relative to it. */
  private async phpChanges(task: CodeTask, baseHead: string): Promise<string[] | undefined> {
    const head = await this.gitHead(task.root);
    if (!head) return undefined;
    const diff = await this.run('git', ['-C', task.repoRoot, 'diff', '--name-only', '-z', baseHead, head, '--', '*.php'], task.repoRoot);
    if (diff.code !== 0) return undefined;
    const dirty = async (root: string) => {
      const r = await this.run('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all', '--', '*.php'], root);
      return r.code === 0 ? r.stdout.split('\0').filter((l) => l.length > 3).map((l) => l.slice(3)) : [];
    };
    const files = new Set([...diff.stdout.split('\0').filter(Boolean), ...await dirty(task.root), ...await dirty(task.repoRoot)]);
    return [...files].filter((f) => f.endsWith('.php'));
  }

  private async gitHead(root: string): Promise<string | undefined> {
    const r = await this.run('git', ['-C', root, 'rev-parse', 'HEAD'], root);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  private readJson<T>(file: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
  }

  private lightFor(task: CodeTask, file: string): Promise<LightIndex> {
    const s = this.state(task);
    const project = projectDirOf(fs.realpathSync(task.root), file);
    let entry = s.light.get(project);
    if (!entry) {
      const fresh = { done: 0, total: 0, ready: false, index: undefined as unknown as Promise<LightIndex> };
      fresh.index = LightIndex.build(project, (done, total) => { fresh.done = done; fresh.total = total; }, this.grep)
        .then((index) => { fresh.ready = true; return index; });
      fresh.index.catch(() => { s.light.delete(project); });
      s.light.set(project, fresh);
      entry = fresh;
    }
    return entry.index;
  }

  private async script(
    task: CodeTask, method: string,
    p: { position?: { line?: unknown; character?: unknown }; query?: unknown }, file: string | undefined,
  ): Promise<unknown> {
    if (method === 'workspace/symbol') {
      const out: unknown[] = [];
      for (const entry of this.state(task).light.values()) {
        if (!entry.ready) continue;
        for (const s of (await entry.index).symbols(String(p.query ?? ''))) {
          out.push({ name: s.name, kind: SYMBOL_KIND[s.kind] ?? 13, containerName: s.container, location: location(s.place) });
        }
      }
      return out;
    }
    if (!file) throw new CodeError('A document is required.');
    if (method === 'textDocument/hover') return null; // no types without a type checker
    const index = await this.lightFor(task, file);
    const text = readTextFile(file).text;
    if (method === 'textDocument/documentSymbol') return outline(index.outline(file, text));
    const line = Number(p.position?.line ?? 0), col = Number(p.position?.character ?? 0);
    if (method === 'textDocument/definition') return index.definition(file, text, line, col).map(location);
    return (await index.references(file, text, line, col)).map(location);
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  async diagnostics(task: CodeTask, fileArg: unknown): Promise<LspDiagnostic[]> {
    const file = resolveInWorktree(this.scope(task), fileArg);
    if (/\.(php|phtml)$/.test(file)) return this.phpLint(task, file);
    if (!/\.([cm]?[jt]sx?)$/.test(file)) return [];
    const spec = this.oxlintSpec(task);
    if (!spec) return [];
    const { proc } = this.server(task, spec);
    await proc.ready;
    proc.ensureOpen(file, scriptLanguage(file), readTextFile(file).text);
    return (await proc.diagnosticsFor(file, 15000, (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); }))) as LspDiagnostic[];
  }

  /** `php -l`: syntax only. "PHP Parse error: … in <file> on line N". */
  private async phpLint(task: CodeTask, file: string): Promise<LspDiagnostic[]> {
    const { code, stdout, stderr } = await this.run('php', ['-l', file], task.root);
    if (code === 0) return [];
    const m = /(?:Parse|Fatal) error:\s*(.+?) in .+? on line (\d+)/.exec(stdout + '\n' + stderr);
    if (!m) return [];
    const line = Math.max(0, Number(m[2]) - 1);
    return [{ range: { start: { line, character: 0 }, end: { line, character: 1000 } }, severity: 1, source: 'php -l', message: m[1] }];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  status(task: CodeTask): LspStatus[] {
    const s = this.tasks.get(task.id);
    if (!s) return [];
    const out = [...s.servers.values()].map((r) => r.proc.status());
    for (const [project, entry] of s.light) {
      out.push({
        server: 'js/ts', state: entry.ready ? 'ready' : 'indexing',
        message: entry.ready ? '' : `${entry.done} of ${entry.total || '…'} files (${path.basename(project)})`,
      });
    }
    return out;
  }

  /** Stops the task's servers and forgets what was cached in memory. */
  close(taskId: string): void {
    const s = this.tasks.get(taskId);
    if (!s) return;
    for (const r of s.servers.values()) { if (r.timer) clearTimeout(r.timer); r.proc.stop(); }
    this.tasks.delete(taskId);
  }

  /** The task is gone: its servers and its index on disk. */
  forget(taskId: string): void {
    this.close(taskId);
    const root = path.join(this.opts.cacheDir, 'phpactor');
    const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_');
    let repos: string[] = [];
    try { repos = fs.readdirSync(root); } catch { /* nothing cached */ }
    for (const repo of repos) fs.rmSync(path.join(root, repo, 'tasks', safe), { recursive: true, force: true });
    fs.rmSync(path.join(root, safe), { recursive: true, force: true }); // the per-task layout of before
  }

  dispose(): void {
    for (const id of [...this.tasks.keys()]) this.close(id);
  }
}

/** Declarations as LSP DocumentSymbols: members nest under their container. */
function outline(decls: Declaration[]): unknown[] {
  const range = (d: Declaration) => ({ start: { line: d[1], character: d[2] }, end: { line: d[1], character: d[2] + d[0].length } });
  const symbol = (d: Declaration) => ({ name: d[0], kind: SYMBOL_KIND[d[3]] ?? 13, range: range(d), selectionRange: range(d), children: [] as unknown[] });
  const top = new Map<string, ReturnType<typeof symbol>>();
  const out: unknown[] = [];
  for (const d of decls) {
    const s = symbol(d);
    if (d[4] && top.has(d[4])) top.get(d[4])!.children.push(s);
    else { out.push(s); if (!d[4]) top.set(d[0], s); }
  }
  return out;
}

export { PathRefused };

/**
 * What Phpactor is started on: a directory of symlinks to the worktree's top-level entries that hold
 * tracked PHP files, rebuilt at every start. Its indexer walks every directory under its root before
 * applying exclude patterns, so on a checkout with real node_modules, vendor or other worktrees nested
 * inside (the main checkout keeps them in .worktrees/), walking the worktree itself takes forever and
 * indexes every nested copy. vendor/ stays out (Composer's class maps still find a vendor class).
 */
export function phpactorView(root: string, viewDir: string, listPhp: (root: string) => string[] = trackedPhp): { root: string; map: Array<[string, string]> } {
  const tops = new Set<string>();
  for (const file of listPhp(root)) {
    const top = file.split('/')[0];
    if (top && !['vendor', 'node_modules', '.worktrees', '.git'].includes(top)) tops.add(top);
  }
  for (const extra of ['composer.json', 'composer.lock']) if (fs.existsSync(path.join(root, extra))) tops.add(extra);
  fs.rmSync(viewDir, { recursive: true, force: true });
  fs.mkdirSync(viewDir, { recursive: true });
  const map: Array<[string, string]> = [];
  for (const top of [...tops].sort()) {
    const real = path.join(root, top);
    if (!fs.existsSync(real)) continue;
    fs.symlinkSync(real, path.join(viewDir, top));
    const dir = fs.statSync(real).isDirectory();
    map.push(dir ? [`${real}/`, `${path.join(viewDir, top)}/`] : [real, path.join(viewDir, top)]);
  }
  return { root: viewDir, map };
}

/** Tracked PHP files, relative to `root` (git's index, so nested worktrees and untracked trees are not walked). */
function trackedPhp(root: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '*.php'], { maxBuffer: 256 * 1024 * 1024, timeout: 20_000 });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** The directory name of a repository's Phpactor files under the cache. */
export const phpactorRepoKey = (repoRoot: string): string =>
  `${path.basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, '_')}-${shortHash(path.resolve(repoRoot))}`;

const shortHash = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** The `timestamp*` files of the Phpactor indexes under an XDG dir (one per project id). */
function indexTimestamps(dir: string): string[] {
  const indexes = path.join(dir, 'cache', 'phpactor', 'index');
  try {
    return fs.readdirSync(indexes).flatMap((d) => fs.readdirSync(path.join(indexes, d)).filter((f) => f.startsWith('timestamp')).map((f) => path.join(indexes, d, f)));
  } catch {
    return [];
  }
}

/**
 * The task's index as an APFS clone of the base (`cp -c`), stamped as built now: Phpactor re-indexes a file
 * only when its ctime is past the index's timestamp, and a task's checkout is newer than the base, so
 * without the stamp it would re-index everything. The files that really differ are re-indexed by hand.
 */
export function cloneIndex(base: string, task: string, baseHead: string, now: number): void {
  fs.rmSync(task, { recursive: true, force: true });
  fs.mkdirSync(task, { recursive: true });
  execFileSync('cp', ['-c', '-R', path.join(base, 'cache'), path.join(task, 'cache')]);
  for (const d of ['config', 'data']) fs.mkdirSync(path.join(task, d), { recursive: true });
  for (const stamp of indexTimestamps(task)) fs.writeFileSync(stamp, String(Math.floor(now / 1000)));
  fs.writeFileSync(path.join(task, 'clone.json'), JSON.stringify({ base: baseHead }));
}
