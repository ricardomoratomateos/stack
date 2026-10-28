import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callWindow, createBridgeServer, forward, type BridgeOptions } from '../../src/mcp/bridge/bridge';
import { TOOLS } from '../../src/mcp/bridge/tools';
import { TOOL_NAMES, type WindowFile } from '../../src/mcp/protocol';

/** A stand-in window: records what it was sent and answers whatever `reply` says. */
async function stubWindow(reply: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url!, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      reply(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { server, port, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const json = (res: http.ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

const win = (over: Partial<WindowFile>): WindowFile => ({
  pid: process.pid, port: 1, token: 'tok', repoRoots: ['/code/a'], workspaceFolders: ['/code/a'], worktreeIds: ['ta'], focusedAt: 1, ...over,
});

/** A closed port: nothing listens there. */
async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('TOOLS', () => {
  it('advertises every tool, read-only where nothing changes', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    const readOnly = TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual(['stack_status', 'stack_read_agent', 'stack_wait', 'stack_env']);
  });

  it('gives slow tools room: creation, sending, and waiting beyond its own timeout', () => {
    const t = (name: string) => TOOLS.find((d) => d.name === name)!;
    expect(t('stack_status').timeoutMs({})).toBe(30_000);
    expect(t('stack_create_task').timeoutMs({})).toBe(180_000);
    expect(t('stack_delete_task').timeoutMs({})).toBe(60_000);
    expect(t('stack_send_to_agent').timeoutMs({})).toBe(60_000);
    expect(t('stack_wait').timeoutMs({})).toBe(125_000);
    expect(t('stack_wait').timeoutMs({ timeout_s: 10 })).toBe(25_000);
    expect(t('stack_wait').timeoutMs({ timeout_s: 500 })).toBe(125_000);
  });
});

describe('callWindow', () => {
  let stub: Awaited<ReturnType<typeof stubWindow>> | undefined;
  afterEach(async () => { await stub?.close(); stub = undefined; });

  it('posts the call to 127.0.0.1 with the token and returns the window\'s answer', async () => {
    stub = await stubWindow((_req, _body, res) => json(res, { ok: true, result: { n: 1 } }));
    const answer = await callWindow(win({ port: stub.port }), 'stack_status', { args: { x: 1 }, context: { cwd: '/c' } }, 5000);
    expect(answer).toEqual({ ok: true, result: { n: 1 } });
    expect(stub.seen[0].url).toBe('/api/stack_status');
    expect(stub.seen[0].headers.host).toBe(`127.0.0.1:${stub.port}`);
    expect(stub.seen[0].headers.authorization).toBe('Bearer tok');
    expect(stub.seen[0].headers.origin).toBeUndefined();
    expect(stub.seen[0].body).toEqual({ args: { x: 1 }, context: { cwd: '/c' } });
  });

  it('turns an answer that is not an ApiResponse into an error naming the status', async () => {
    stub = await stubWindow((_req, _body, res) => { res.writeHead(502); res.end('<html>'); });
    expect(await callWindow(win({ port: stub.port }), 't', {}, 5000)).toEqual({ ok: false, error: 'The Stack window for /code/a answered HTTP 502 without a result.' });
    await stub.close();
    stub = await stubWindow((_req, _body, res) => json(res, { nope: true }));
    expect((await callWindow(win({ port: stub.port, repoRoots: [] }), 't', {}, 5000))).toEqual({ ok: false, error: 'The Stack window for /code/a answered HTTP 200 without a result.' });
    await stub.close();
    stub = await stubWindow((_req, _body, res) => json(res, null));
    expect((await callWindow(win({ port: stub.port, repoRoots: [], workspaceFolders: [] }), 't', {}, 5000))).toEqual({
      ok: false, error: `The Stack window for pid ${process.pid} answered HTTP 200 without a result.`,
    });
  });

  it('gives up on a window that does not answer in time', async () => {
    stub = await stubWindow(() => { /* never answers */ });
    expect(await callWindow(win({ port: stub.port }), 't', {}, 100)).toEqual({ ok: false, error: 'The Stack window for /code/a did not answer within 0s.' });
  });

  it('says a refused connection is a window that may be reloading, and passes other errors on', async () => {
    expect(await callWindow(win({ port: await deadPort() }), 't', {}, 5000)).toEqual({
      ok: false, error: 'The Stack window for /code/a is not answering — it may be reloading. Try again in a moment.',
    });
    stub = await stubWindow((req) => { req.socket.destroy(); });
    const answer = await callWindow(win({ port: stub.port }), 't', {}, 5000);
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error).toMatch(/^Could not reach the Stack window for \/code\/a: /);
  });
});

describe('forward', () => {
  let dir: string;
  let stub: Awaited<ReturnType<typeof stubWindow>> | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-fwd-')); fs.mkdirSync(path.join(dir, 'windows')); });
  afterEach(async () => { await stub?.close(); stub = undefined; fs.rmSync(dir, { recursive: true, force: true }); });

  const opts = (over: Partial<BridgeOptions> = {}): BridgeOptions => ({
    storageDir: dir, env: {}, cwd: '/code/a/src', version: 't', isAlive: () => true, ...over,
  });
  const writeWindow = (w: WindowFile) => fs.writeFileSync(path.join(dir, 'windows', `${w.pid}.json`), JSON.stringify(w));

  it('rejects a tool it does not have', async () => {
    expect(await forward(opts(), 'nope', {})).toEqual({ content: [{ type: 'text', text: 'Unknown tool "nope".' }], isError: true });
  });

  it('says to open Stack when no window has the repository', async () => {
    const res = await forward(opts(), 'stack_status', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Open Stack on \/code\/a\/src in VS Code/);
  });

  it('forwards to the window of the cwd, with the cwd and $STACK_TASK_ID as context, minus the repo argument', async () => {
    stub = await stubWindow((_req, _body, res) => json(res, { ok: true, result: { fine: true } }));
    writeWindow(win({ pid: 10, port: stub.port }));
    const res = await forward(opts({ env: { STACK_TASK_ID: 'ta' } }), 'stack_env', {});
    expect(res).toEqual({ content: [{ type: 'text', text: '{"fine":true}' }] });
    expect(stub.seen[0].body).toEqual({ args: {}, context: { cwd: '/code/a/src', taskId: 'ta' } });
  });

  it('routes by repo (relative to the cwd), by task id, and by $CLAUDE_PROJECT_DIR', async () => {
    stub = await stubWindow((req, _body, res) => json(res, { ok: true, result: req.url }));
    const other = await stubWindow((req, _body, res) => json(res, { ok: true, result: `other${req.url}` }));
    try {
      writeWindow(win({ pid: 10, port: stub.port }));
      writeWindow(win({ pid: 11, port: other.port, repoRoots: ['/code/b'], workspaceFolders: ['/code/b'], worktreeIds: ['tb'] }));
      const text = async (o: BridgeOptions, tool: string, args: Record<string, unknown>) => (await forward(o, tool, args)).content[0].text;
      expect(await text(opts(), 'stack_status', { repo: '../../b' })).toBe('"other/api/stack_status"');
      expect(stub.seen).toHaveLength(0);
      expect(other.seen[0].body).toEqual({ args: {}, context: { cwd: '/code/a/src' } });
      expect(await text(opts(), 'stack_read_agent', { task_id: 'tb' })).toBe('"other/api/stack_read_agent"');
      expect(await text(opts(), 'stack_wait', { task_ids: ['tb'] })).toBe('"other/api/stack_wait"');
      expect(await text(opts(), 'stack_wait', { task_ids: [3] })).toBe('"/api/stack_wait"');
      expect(await text(opts({ env: { STACK_TASK_ID: 'tb' } }), 'stack_env', {})).toBe('"other/api/stack_env"');
      expect(await text(opts({ cwd: '/', env: { CLAUDE_PROJECT_DIR: '/code/b' } }), 'stack_status', { repo: '' })).toBe('"other/api/stack_status"');
    } finally {
      await other.close();
    }
  });

  it('passes a tool error from the window on as an MCP error', async () => {
    stub = await stubWindow((_req, _body, res) => json(res, { ok: false, error: 'No task "x" in this window.' }));
    writeWindow(win({ pid: 10, port: stub.port }));
    expect(await forward(opts(), 'stack_status', {})).toEqual({ content: [{ type: 'text', text: 'No task "x" in this window.' }], isError: true });
  });

  it('never throws', async () => {
    const env = new Proxy({}, { get: () => { throw new Error('env exploded'); } });
    expect(await forward(opts({ env }), 'stack_status', {})).toEqual({
      content: [{ type: 'text', text: 'Stack bridge error: env exploded' }], isError: true,
    });
    const env2 = new Proxy({}, { get: () => { throw 'plain'; } });
    expect((await forward(opts({ env: env2 }), 'stack_status', {})).content[0].text).toBe('Stack bridge error: plain');
  });

  it('checks for real that the window\'s process is alive by default', async () => {
    writeWindow(win({ pid: 999_999_999 }));
    const res = await forward({ storageDir: dir, env: {}, cwd: '/code/a', version: 't' }, 'stack_status', {});
    expect(res.content[0].text).toMatch(/No VS Code window with Stack is open/);
  });
});

describe('createBridgeServer', () => {
  let dir: string;
  let stub: Awaited<ReturnType<typeof stubWindow>>;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-srv-'));
    fs.mkdirSync(path.join(dir, 'windows'));
    stub = await stubWindow((_req, body, res) => json(res, { ok: true, result: JSON.parse(body) }));
    fs.writeFileSync(path.join(dir, 'windows', '10.json'), JSON.stringify(win({ pid: 10, port: stub.port })));
  });
  afterEach(async () => { await stub.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists the tools with schemas and annotations, and forwards a call', async () => {
    const server = createBridgeServer({ storageDir: dir, env: {}, cwd: '/code/a', version: '9.9.9', isAlive: () => true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'stack', version: '9.9.9' });
      expect(client.getInstructions()).toMatch(/stack_create_task/);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      const create = tools.find((t) => t.name === 'stack_create_task')!;
      expect(create.inputSchema.required).toEqual(['title', 'prompt']);
      expect(create.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
      expect(tools.find((t) => t.name === 'stack_status')!.annotations).toMatchObject({ readOnlyHint: true });

      const res = await client.callTool({ name: 'stack_status', arguments: { task_id: 'ta' } });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toEqual({ args: { task_id: 'ta' }, context: { cwd: '/code/a' } });
      // Called with no arguments at all, too.
      const bare = await client.callTool({ name: 'stack_env' });
      expect(bare.isError).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
