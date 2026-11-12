import type { LspChild, SpawnLsp } from '../../src/code/LspProcess';

interface Incoming { id?: number; method?: string; params?: unknown; result?: unknown }

/**
 * A language server that never leaves the test: it answers `initialize`, records what it is sent, and lets
 * the test speak as the server (responses, notifications, requests to the client).
 */
export class FakeServer {
  readonly received: Incoming[] = [];
  killed = false;
  private buf = Buffer.alloc(0);
  private out?: (chunk: Buffer) => void;
  private exit?: (code: number | null) => void;
  /** How to answer a request; default `null`. */
  answer: (method: string, params: unknown) => unknown = () => null;
  /** Requests are left unanswered while true (to test what happens when the server dies or lags). */
  silent = false;

  readonly child: LspChild = {
    pid: 4242,
    stdin: { write: (chunk) => { this.onInput(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; } },
    stdout: { on: (_e, cb) => { this.out = cb; } },
    stderr: { on: () => {} },
    on: ((event: string, cb: (arg: never) => void) => { if (event === 'exit') this.exit = cb as (code: number | null) => void; }) as LspChild['on'],
    kill: () => { this.killed = true; },
  };

  private onInput(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const len = Number(/Content-Length: (\d+)/.exec(this.buf.subarray(0, head).toString())?.[1] ?? 0);
      if (this.buf.length < head + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(head + 4, head + 4 + len).toString()) as Incoming;
      this.buf = this.buf.subarray(head + 4 + len);
      this.received.push(msg);
      if (msg.method && msg.id !== undefined && (msg.method === 'initialize' || !this.silent)) {
        const result = msg.method === 'initialize' ? { capabilities: {} } : this.answer(msg.method, msg.params);
        queueMicrotask(() => this.send({ jsonrpc: '2.0', id: msg.id, result }));
      }
    }
  }

  /** Speaks as the server. `split` sends the frame in two chunks, as a pipe may. */
  send(msg: unknown, split = false): void {
    const body = Buffer.from(JSON.stringify(msg));
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    if (!split) { this.out?.(frame); return; }
    this.out?.(frame.subarray(0, 10));
    this.out?.(frame.subarray(10));
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }); }
  die(code = 1): void { this.exit?.(code); }
  sent(method: string): Incoming[] { return this.received.filter((m) => m.method === method); }
}

/** A spawn that hands out FakeServers and remembers how each was started. */
export function fakeSpawn(): { spawn: SpawnLsp; servers: FakeServer[]; calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> } {
  const servers: FakeServer[] = [];
  const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const spawn: SpawnLsp = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const s = new FakeServer();
    servers.push(s);
    return s.child;
  };
  return { spawn, servers, calls };
}

export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
