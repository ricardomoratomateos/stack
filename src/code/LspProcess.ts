import { spawn as nodeSpawn } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The slice of a child process the LSP client needs; tests hand in a fake. */
export interface LspChild {
  pid?: number;
  stdin: { write(chunk: string | Buffer): unknown };
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown };
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown };
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(): unknown;
}

export type SpawnLsp = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => LspChild;

export const spawnLsp: SpawnLsp = (command, args, options) =>
  nodeSpawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as LspChild;

export interface LspSpec {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** `initializationOptions`. */
  init?: unknown;
  /** Answers `workspace/configuration` for one section. */
  config?: (section: string | undefined) => unknown;
}

export type LspState = 'starting' | 'indexing' | 'ready' | 'dead';

export interface LspStatus {
  server: string;
  state: LspState;
  message: string;
  initMs?: number;
  indexMs?: number;
}

interface Message {
  id?: number;
  method?: string;
  params?: { items?: Array<{ section?: string }>; token?: string | number; value?: { kind?: string; title?: string; message?: string }; uri?: string; diagnostics?: unknown[] };
  result?: unknown;
  error?: { message: string };
}

/**
 * One language server over stdio, as a request/response client. It answers the few requests a server makes
 * of its client (configuration, workspace folders), follows indexing progress, and keeps the last diagnostics
 * the server published so they can be asked for.
 */
export class LspProcess {
  state: LspState = 'starting';
  message = '';
  readonly ready: Promise<void>;
  readonly startedAt: number;
  private readonly child: LspChild;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly open = new Set<string>();
  private readonly diagnostics = new Map<string, unknown[]>();
  private readonly diagnosticWaiters = new Map<string, Array<() => void>>();
  private buf: Buffer = Buffer.alloc(0);
  private stderr = '';
  private initMs?: number;
  private indexMs?: number;
  private indexStart?: number;
  /** Work-done progress in flight: token -> its title. */
  private readonly progress = new Map<string, string>();
  /** A progress whose title speaks of indexing has run to its end: the server's index is built. */
  indexed = false;

  constructor(
    readonly spec: LspSpec,
    readonly root: string,
    spawn: SpawnLsp = spawnLsp,
    private readonly now: () => number = Date.now,
    private readonly onExit: () => void = () => {},
  ) {
    this.startedAt = now();
    this.child = spawn(spec.command, spec.args, { cwd: root, env: { ...process.env, NODE_OPTIONS: '', ...spec.env } });
    this.child.stdout.on('data', (c) => this.onData(c));
    this.child.stderr.on('data', (c) => { this.stderr = (this.stderr + c.toString()).slice(-4000); });
    this.child.on('error', (e) => this.die(e.message));
    this.child.on('exit', (code) => this.die(`exited (${code})`));
    this.ready = this.initialize();
    this.ready.catch(() => {}); // the caller awaits it; an unobserved rejection must not take the daemon down
  }

  private die(why: string): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    const last = this.stderr.trim().split('\n').pop();
    this.message = last ? `${why}: ${last}` : why;
    for (const p of this.pending.values()) p.reject(new Error(`${this.spec.id} ${this.message}`));
    this.pending.clear();
    for (const waiters of this.diagnosticWaiters.values()) for (const wake of waiters) wake();
    this.diagnosticWaiters.clear();
    this.onExit();
  }

  private async initialize(): Promise<void> {
    const uri = pathToFileURL(this.root).href;
    await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'stackd' },
      rootUri: uri,
      rootPath: this.root,
      workspaceFolders: [{ uri, name: path.basename(this.root) }],
      initializationOptions: this.spec.init,
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false } },
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: { didSave: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
      },
    });
    this.notify('initialized', {});
    this.initMs = this.now() - this.startedAt;
    if (this.state === 'starting') this.state = 'ready';
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, head).toString('ascii'));
      const len = m ? Number(m[1]) : 0;
      if (this.buf.length < head + 4 + len) return;
      const body = this.buf.subarray(head + 4, head + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(head + 4 + len);
      let msg: Message;
      try { msg = JSON.parse(body) as Message; } catch { continue; }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: Message): void {
    if (msg.method === undefined) {
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p || msg.id === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result ?? null);
      return;
    }
    if (msg.id !== undefined) { // the server asks its client
      let result: unknown = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items ?? []).map((i) => this.spec.config?.(i.section) ?? null);
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
      this.write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
      const uri = msg.params.uri;
      this.diagnostics.set(uri, msg.params.diagnostics ?? []);
      for (const wake of this.diagnosticWaiters.get(uri) ?? []) wake();
      this.diagnosticWaiters.delete(uri);
      return;
    }
    if (msg.method === '$/progress') {
      const v = msg.params?.value ?? {};
      const token = String(msg.params?.token ?? '');
      if (v.kind === 'begin') { this.progress.set(token, v.title ?? ''); this.beginIndexing(v.title ?? ''); }
      else if (v.kind === 'report') this.message = v.message ?? this.message;
      else if (v.kind === 'end') {
        if (/index/i.test(this.progress.get(token) ?? '')) this.indexed = true;
        this.progress.delete(token);
        if (this.progress.size === 0) this.endIndexing();
      }
    }
  }

  private beginIndexing(title: string): void {
    if (this.state === 'dead') return;
    this.state = 'indexing';
    this.indexStart ??= this.now();
    this.message = title;
  }

  private endIndexing(): void {
    if (this.state === 'dead') return;
    this.state = 'ready';
    this.indexMs = this.now() - (this.indexStart ?? this.startedAt);
    this.indexStart = undefined;
    this.message = '';
  }

  private write(msg: unknown): void {
    if (this.state === 'dead') return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.state === 'dead') return Promise.reject(new Error(`${this.spec.id} ${this.message}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }

  /** A server answers about a document only once it has it. The text is the file on disk, read by the daemon. */
  ensureOpen(file: string, languageId: string, text: string): void {
    if (this.open.has(file)) return;
    this.open.add(file);
    this.notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(file).href, languageId, version: 1, text } });
  }

  /**
   * The diagnostics for a document. Servers push them some time after `didOpen`; this waits for the first
   * batch, or gives up after `timeoutMs` with none.
   */
  async diagnosticsFor(file: string, timeoutMs: number, wait: (ms: number) => Promise<void>): Promise<unknown[]> {
    const uri = pathToFileURL(file).href;
    if (!this.diagnostics.has(uri) && this.state !== 'dead') {
      const arrived = new Promise<void>((resolve) => {
        this.diagnosticWaiters.set(uri, [...(this.diagnosticWaiters.get(uri) ?? []), resolve]);
      });
      await Promise.race([arrived, wait(timeoutMs)]);
    }
    return this.diagnostics.get(uri) ?? [];
  }

  status(): LspStatus {
    return { server: this.spec.id, state: this.state, message: this.message, initMs: this.initMs, indexMs: this.indexMs };
  }

  stop(): void {
    try { this.child.kill(); } catch { /* already gone */ }
    this.die('stopped');
  }
}
