import { execFile } from 'node:child_process';
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

interface Running { proc: LspProcess; timer?: ReturnType<typeof setTimeout>; firstIndex: boolean }

interface TaskState {
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
    if (!s) { s = { servers: new Map(), light: new Map() }; this.tasks.set(task.id, s); }
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

  private phpactorDir(taskId: string): string {
    return path.join(this.opts.cacheDir, 'phpactor', taskId.replace(/[^A-Za-z0-9._-]/g, '_'));
  }

  private phpactorSpec(task: CodeTask): LspSpec {
    const cmd = this.phpactorCommand();
    if (!cmd) throw new CodeError('PHP navigation needs Phpactor: set "phpactorPath" in ~/.config/stack/settings.json, or put phpactor.phar in ~/.config/stack/tools/.');
    const dir = this.phpactorDir(task.id);
    const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data') };
    for (const d of Object.values(env)) fs.mkdirSync(d, { recursive: true });
    const own = path.join(task.root, 'vendor', 'autoload.php');
    return {
      id: 'phpactor',
      ...cmd,
      env,
      init: {
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
  private hasPhpIndex(taskId: string): boolean {
    const indexes = path.join(this.phpactorDir(taskId), 'cache', 'phpactor', 'index');
    try { return fs.readdirSync(indexes).some((d) => fs.readdirSync(path.join(indexes, d)).some((f) => f.startsWith('timestamp'))); } catch { return false; }
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
      : this.server(task, this.phpactorSpec(task), !this.hasPhpIndex(task.id));
    const { proc } = running;
    await proc.ready;
    if (proc.state === 'dead') throw new CodeError(`Phpactor stopped: ${proc.message}`);
    // The first index of a worktree takes a minute or more; until it is built there is nothing to answer from.
    if (running.firstIndex && !proc.indexed) throw new CodeError(`Indexing PHP… ${proc.state === 'indexing' ? proc.message : 'starting'}`.trim());
    running.firstIndex = false;
    if (file) proc.ensureOpen(file, 'php', readTextFile(file).text);
    return proc.request(method, params);
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
    fs.rmSync(this.phpactorDir(taskId), { recursive: true, force: true });
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
