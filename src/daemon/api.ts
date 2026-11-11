import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { CommandError, type StackDaemon } from './StackDaemon';

/** `<configDir>/stackd.sock`. */
export function socketPathFor(configDir: string): string {
  return path.join(configDir, 'stackd.sock');
}

const MAX_BODY = 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new CommandError('Request too large.', 413));
      if (size === 0) return resolve({});
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new CommandError('The body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The local API, HTTP over a Unix socket (mode 0600 in the 0700 config dir:
 * only this user's processes can connect, so there is no token to leak).
 *
 *   GET  /state            the snapshot: every repo, its worktrees, sessions, states
 *   GET  /events           SSE; `event: state` with the snapshot on connect and after every change
 *   POST /commands/<name>  createTask deleteTask spawnAgent spawnShell killWindow
 *                          sendToAgent respondPermission attachTarget addRepo
 *
 * Answers are `{ok: true, result}` / `{ok: false, error}`.
 */
export class ApiServer {
  private server: http.Server;
  private streams = new Set<http.ServerResponse>();
  private sub?: { dispose(): void };
  private keepAlive?: ReturnType<typeof setInterval>;

  constructor(private readonly daemon: StackDaemon, readonly socketPath: string) {
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
  }

  /** Listens; refuses when another daemon already owns the socket, replaces a dead one's leftover. */
  async start(): Promise<void> {
    if (fs.existsSync(this.socketPath)) {
      const alive = await new Promise<boolean>((resolve) => {
        const probe = net.connect(this.socketPath);
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => resolve(false));
      });
      if (alive) throw new Error(`stackd is already running (${this.socketPath}).`);
      fs.rmSync(this.socketPath, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => resolve());
    });
    fs.chmodSync(this.socketPath, 0o600);
    this.sub = this.daemon.onChange(() => this.push());
    this.daemon.clients = () => this.streams.size;
    this.keepAlive = setInterval(() => { for (const s of this.streams) s.write(': keep-alive\n\n'); }, 15000);
  }

  async stop(): Promise<void> {
    this.sub?.dispose();
    if (this.keepAlive) clearInterval(this.keepAlive);
    for (const s of this.streams) s.end();
    this.streams.clear();
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections?.(); });
    fs.rmSync(this.socketPath, { force: true });
  }

  private writeState(res: http.ServerResponse): void {
    res.write(`event: state\ndata: ${JSON.stringify(this.daemon.snapshot())}\n\n`);
  }

  private push(): void {
    for (const s of this.streams) this.writeState(s);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://stackd');
      if (req.method === 'GET' && url.pathname === '/state') {
        return send(res, 200, { ok: true, result: this.daemon.snapshot() });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        this.streams.add(res);
        res.on('close', () => this.streams.delete(res));
        this.writeState(res);
        return;
      }
      const m = /^\/commands\/([A-Za-z]+)$/.exec(url.pathname);
      if (m) {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only.' });
        const result = await this.daemon.command(m[1], await readBody(req));
        return send(res, 200, { ok: true, result });
      }
      send(res, 404, { ok: false, error: 'Not found.' });
    } catch (e) {
      const status = e instanceof CommandError ? e.status : 500;
      if (!res.headersSent) send(res, status, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** One request to a running daemon. Rejects with the daemon's own error message, or a connection error when it is not running. */
export function callDaemon<T = unknown>(
  socketPath: string, method: 'GET' | 'POST', route: string, body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath, path: route, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const answer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; result?: T; error?: string };
            if (answer.ok) resolve(answer.result as T);
            else reject(new Error(answer.error ?? `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`Unreadable answer from stackd (HTTP ${res.statusCode}).`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
