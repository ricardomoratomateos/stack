import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LspProcess, type LspSpec, type SpawnLsp } from './LspProcess';

export interface RunResult { code: number; stdout: string; stderr: string }
export type Run = (command: string, args: string[], cwd: string) => Promise<RunResult>;

/** `a | b`, both in `cwd`; resolves with the worse exit code and what they said on stderr. */
export type Pipe = (a: [string, string[]], b: [string, string[]], cwd: string) => Promise<{ code: number; stderr: string }>;

export const pipe: Pipe = ([ac, aa], [bc, ba], cwd) => new Promise((resolve) => {
  const left = nodeSpawn(ac, aa, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const right = nodeSpawn(bc, ba, { cwd, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let codes = 0, worst = 0;
  const done = (code: number | null): void => { worst = Math.max(worst, code ?? 1); if (++codes === 2) resolve({ code: worst, stderr: stderr.slice(-2000) }); };
  left.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  right.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  left.stdout.pipe(right.stdin);
  right.stdin.on('error', () => { /* tar went away: its exit code says why */ });
  left.on('error', () => done(127));
  right.on('error', () => done(127));
  left.on('exit', done);
  right.on('exit', done);
});

/** The commit a repository's base index is (being) built from, and the ref it was read off. */
export interface BaseInfo { ref: string; commit: string }

export interface BaseStatus {
  state: 'none' | 'preparing' | 'ready' | 'failed';
  ref?: string;
  commit?: string;
  /** "extracting", "1200/33000", or why it failed. */
  message: string;
}

export interface PhpBaseDeps {
  run: Run;
  pipe: Pipe;
  spawn: SpawnLsp;
  /** How to start Phpactor on `view` with its files under `xdg`; undefined when Phpactor is not installed. */
  spec: (xdg: string, view: { root: string; map: Array<[string, string]> }) => LspSpec | undefined;
  /** The repo's base branch (`defaultBaseBranch`), when it has one. */
  baseBranch: () => string | undefined;
  /** A task's Phpactor is using the repo's view: the base is not touched until it is gone. */
  busy: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Removes a directory without holding the caller up. */
  discard: (dir: string) => void;
  log: (line: string) => void;
}

const SKIP_TOPS = new Set(['vendor', 'node_modules', '.worktrees', '.git']);

/** `origin/<branch>`, else the local branch, else the main checkout's HEAD. */
export async function resolveBaseRef(run: Run, repoRoot: string, branch: string | undefined): Promise<BaseInfo | undefined> {
  const candidates = branch ? [`origin/${branch}`, branch, 'HEAD'] : ['HEAD'];
  for (const ref of candidates) {
    const r = await run('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot);
    const commit = r.stdout.trim();
    if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(commit)) return { ref, commit };
  }
  return undefined;
}

/** The top-level entries of `commit` that hold PHP, plus Composer's files when the commit has them. */
export async function phpTops(run: Run, repoRoot: string, commit: string): Promise<string[]> {
  const r = await run('git', ['-C', repoRoot, 'ls-tree', '-r', '--name-only', '-z', commit], repoRoot);
  if (r.code !== 0) return [];
  const tops = new Set<string>();
  for (const file of r.stdout.split('\0')) {
    if (file === 'composer.json' || file === 'composer.lock') tops.add(file);
    else if (file.endsWith('.php')) {
      const top = file.split('/')[0];
      if (!SKIP_TOPS.has(top)) tops.add(top);
    }
  }
  return [...tops].sort();
}

/** Symlinks in `viewDir` to the given top-level entries of `root`: what Phpactor is started on. */
export function linkView(root: string, viewDir: string, tops: readonly string[]): { root: string; map: Array<[string, string]> } {
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

const chunks = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * A repository's base for PHP navigation: the sources of its base branch, extracted from git into the cache
 * (`base-src`, never a worktree or a branch in the repo), and Phpactor's index of them (`base`). Tasks clone
 * that index and re-index only what they changed; nothing a task does is ever written here.
 *
 * It is built in the background, once, and brought up to date when the ref moves: only the PHP files that
 * changed between the two commits are extracted again, and Phpactor re-indexes those (it goes by ctime).
 * Phpactor runs at low priority and is stopped as soon as the index is done.
 */
export class PhpBase {
  readonly src: string;
  readonly xdg: string;
  readonly view: string;
  private readonly infoFile: string;
  private building?: Promise<void>;
  private progress = '';
  private target?: BaseInfo;
  private failure = '';
  private proc?: LspProcess;
  private disposed = false;
  /** A commit of the ref found to hold no PHP: not looked at again. */
  private noPhp?: string;

  constructor(readonly repoRoot: string, readonly dir: string, private readonly deps: PhpBaseDeps) {
    this.src = path.join(dir, 'base-src');
    this.xdg = path.join(dir, 'base');
    this.view = path.join(dir, 'view');
    this.infoFile = path.join(dir, 'base.json');
  }

  private record(): (Partial<BaseInfo> & { ready?: boolean; from?: BaseInfo }) | undefined {
    try { return JSON.parse(fs.readFileSync(this.infoFile, 'utf8')) as Partial<BaseInfo> & { ready?: boolean; from?: BaseInfo }; } catch { return undefined; }
  }

  /** The base as it is on disk, when its index is complete (it may be behind the ref: still good to clone). */
  info(): BaseInfo | undefined {
    const j = this.record();
    return j?.ready && j.ref && j.commit ? { ref: j.ref, commit: j.commit } : undefined;
  }

  /** An update that was cut short (stackd stopped): it is picked up from where it started, not from scratch. */
  private interrupted(): BaseInfo | undefined {
    const from = this.record()?.from;
    return from?.ref && from.commit && fs.existsSync(this.src) ? from : undefined;
  }

  get preparing(): boolean { return !!this.building; }

  status(): BaseStatus {
    const info = this.info();
    if (this.building) return { state: 'preparing', ref: this.target?.ref, commit: this.target?.commit, message: this.progress || 'starting' };
    if (info) return { state: 'ready', ref: info.ref, commit: info.commit, message: '' };
    if (this.failure) return { state: 'failed', message: this.failure };
    return { state: 'none', message: '' };
  }

  /**
   * Starts building or updating the base when the ref is ahead of it; returns at once. Nothing happens while
   * a build is running, or while a task's Phpactor holds the repo's view (the next check will find it free)
   * unless `claimed`: the caller has stopped it and holds the repo's start.
   */
  async check(claimed = false): Promise<void> {
    if (this.building || this.disposed) return;
    const target = await resolveBaseRef(this.deps.run, this.repoRoot, this.deps.baseBranch());
    if (!target || this.building || this.disposed) return;
    const have = this.info() ?? this.interrupted();
    if (have?.commit === target.commit && this.info() || this.noPhp === target.commit) return;
    if (!claimed && this.deps.busy()) return;
    this.target = target;
    this.failure = '';
    this.progress = 'starting';
    const build = this.build(have, target)
      .catch((e: unknown) => { this.failure = e instanceof Error ? e.message : String(e); this.deps.log(`[code] base of ${this.repoRoot} failed: ${this.failure}`); })
      .finally(() => { if (this.building === build) this.building = undefined; this.proc = undefined; });
    this.building = build;
  }

  /** Resolves when no build is running (for tests and scripts; the daemon never waits on it). */
  async settled(): Promise<void> { while (this.building) await this.building; }

  private async build(have: BaseInfo | undefined, target: BaseInfo): Promise<void> {
    const t0 = this.deps.now();
    const git = (args: string[]) => this.deps.run('git', ['-C', this.repoRoot, ...args], this.repoRoot);
    const tops = await phpTops(this.deps.run, this.repoRoot, target.commit);
    if (!tops.some((t) => !t.startsWith('composer.'))) { this.noPhp = target.commit; return; } // not a PHP repository: no base
    const incremental = !!have && fs.existsSync(this.src);
    // Until the index is complete again nothing may clone it.
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.infoFile, JSON.stringify({ ...target, ready: false, ...(incremental && have ? { from: have } : {}) }));
    let touched = 0;
    if (incremental && have) {
      this.progress = 'updating sources';
      const diff = await git(['diff', '--name-status', '-z', '--no-renames', have.commit, target.commit, '--', '*.php', 'composer.json', 'composer.lock']);
      if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
      const parts = diff.stdout.split('\0').filter(Boolean);
      const changed: string[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const file = parts[i + 1];
        if (SKIP_TOPS.has(file.split('/')[0])) continue;
        if (parts[i] === 'D') fs.rmSync(path.join(this.src, file), { force: true }); else changed.push(file);
      }
      // `tar -m`: extracted now. Phpactor re-indexes a file whose ctime is past its index's timestamp.
      for (const batch of chunks(changed, 400)) {
        const r = await this.deps.pipe(['git', ['-C', this.repoRoot, 'archive', '--format=tar', target.commit, '--', ...batch]], ['tar', ['-xmf', '-', '-C', this.src]], this.repoRoot);
        if (r.code !== 0) throw new Error(`extracting the changed files failed: ${r.stderr.trim()}`);
      }
      touched = parts.length / 2;
    } else {
      this.progress = 'extracting';
      this.deps.discard(this.src);
      this.deps.discard(this.xdg);
      fs.mkdirSync(this.src, { recursive: true });
      // Only the PHP of those directories (and Composer's files): the base is for an index, not a checkout.
      const specs = tops.map((t) => (/\.(php|json|lock)$/.test(t) ? t : `:(glob)${t}/**/*.php`));
      const r = await this.deps.pipe(['git', ['-C', this.repoRoot, 'archive', '--format=tar', target.commit, '--', ...specs]], ['tar', ['-xmf', '-', '-C', this.src]], this.repoRoot);
      if (r.code !== 0) throw new Error(`extracting ${target.ref} failed: ${r.stderr.trim()}`);
    }
    const extractedMs = this.deps.now() - t0;
    if (this.disposed) return;
    await this.index(tops, incremental);
    if (this.disposed) return;
    fs.writeFileSync(this.infoFile, JSON.stringify({ ...target, ready: true }));
    this.deps.log(`[code] base of ${path.basename(this.repoRoot)} ${incremental ? `updated (${touched} file(s))` : 'built'} at ${target.ref} ${target.commit.slice(0, 7)}: sources ${extractedMs} ms, index ${this.deps.now() - t0 - extractedMs} ms`);
  }

  /** Runs Phpactor over base-src until its index is complete, then stops it. */
  private async index(tops: string[], incremental: boolean): Promise<void> {
    this.progress = 'indexing';
    const spec = this.deps.spec(this.xdg, linkView(this.src, this.view, tops));
    if (!spec) throw new Error('Phpactor is not installed');
    // Low priority: this runs behind whatever the user is doing.
    const proc = new LspProcess({ ...spec, command: 'nice', args: ['-n', '10', spec.command, ...spec.args] }, this.src, this.deps.spawn, this.deps.now);
    this.proc = proc;
    try {
      await proc.ready;
      const started = this.deps.now();
      for (;;) {
        if (proc.state === 'dead') throw new Error(`Phpactor stopped: ${proc.message}`);
        if (this.disposed) return;
        if (proc.indexed) { await this.deps.sleep(1000); break; } // a moment for its last writes
        const m = /^(\d+)\s*\/\s*(\d+)/.exec(proc.message);
        if (proc.state === 'indexing' && m) this.progress = `${m[1]}/${m[2]}`;
        // An update with nothing to re-index reports no progress at all: do not wait for one forever.
        if (incremental && proc.state !== 'indexing' && this.deps.now() - started > 30_000) break;
        await this.deps.sleep(500);
      }
    } finally {
      proc.stop();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.proc?.stop();
  }
}
