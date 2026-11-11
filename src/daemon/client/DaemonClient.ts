import * as http from 'node:http';
import { Emitter } from '../../core/Emitter';
import type { Snapshot } from '../StackDaemon';
import { callDaemon } from '../api';

/** Parses a Server-Sent-Events stream, handing each `event: state` payload on. */
export function sseParser(onState: (snapshot: Snapshot) => void): (chunk: string) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
      const m = /^event: state\ndata: (.*)$/m.exec(buf.slice(0, i));
      buf = buf.slice(i + 2);
      if (!m) continue;
      try { onState(JSON.parse(m[1]) as Snapshot); } catch { /* a torn frame; the next one carries everything */ }
    }
  };
}

export interface DaemonClientOptions {
  socketPath: string;
  /** Called before each reconnect attempt: the place to start a daemon that went away. */
  revive?: () => Promise<void>;
  retryMs?: number;
}

/**
 * A client of `stackd`'s local API: the latest snapshot, the stream that keeps
 * it current (reconnecting when the daemon goes away), and commands.
 */
export class DaemonClient {
  private latest?: Snapshot;
  private req?: http.ClientRequest;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private up = false;
  private readonly snapshots = new Emitter<Snapshot>();
  private readonly connection = new Emitter<boolean>();

  /** Fires with every snapshot the daemon sends. */
  readonly onSnapshot = this.snapshots.event;
  /** Fires with `true` when the stream connects, `false` when it drops. */
  readonly onConnection = this.connection.event;

  constructor(private readonly opts: DaemonClientOptions) {}

  get socketPath(): string { return this.opts.socketPath; }
  get snapshot(): Snapshot | undefined { return this.latest; }
  get connected(): boolean { return this.up; }

  /** Opens the event stream; resolves with the first snapshot. */
  start(): Promise<Snapshot> {
    return new Promise((resolve, reject) => {
      let first = true;
      const sub = this.onSnapshot((s) => { if (first) { first = false; sub.dispose(); resolve(s); } });
      this.open((e) => { if (first) { first = false; sub.dispose(); reject(e); } });
    });
  }

  private open(onFirstError?: (e: Error) => void): void {
    if (this.stopped) return;
    const feed = sseParser((s) => { this.latest = s; this.snapshots.fire(s); });
    const req = http.request({ socketPath: this.opts.socketPath, path: '/events', method: 'GET' }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      this.setUp(true);
      res.setEncoding('utf8');
      res.on('data', feed);
      res.on('close', () => this.lost());
    });
    req.on('error', (e) => { onFirstError?.(e); this.lost(); });
    req.end();
    this.req = req;
  }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    this.connection.fire(up);
  }

  private lost(): void {
    this.req?.destroy();
    this.req = undefined;
    this.setUp(false);
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void (this.opts.revive?.() ?? Promise.resolve()).catch(() => {}).then(() => this.open());
    }, this.opts.retryMs ?? 1000);
  }

  /** One command; rejects with the daemon's own message. */
  command<T = unknown>(name: string, body: Record<string, unknown> = {}): Promise<T> {
    return callDaemon<T>(this.opts.socketPath, 'POST', `/commands/${name}`, body);
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.req?.destroy();
    this.snapshots.dispose();
    this.connection.dispose();
  }
}
