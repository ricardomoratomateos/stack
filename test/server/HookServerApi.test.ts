import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import { HookServer, apiRejection, type ApiEndpoint } from '../../src/server/HookServer';

describe('apiRejection', () => {
  const ok = { host: '127.0.0.1:4000', authorization: 'Bearer secret' };

  it('lets in a local client with the token', () => {
    expect(apiRejection(ok, 4000, 'secret')).toBeUndefined();
  });

  it('refuses anything a browser sends (an Origin), and any other Host — DNS rebinding included', () => {
    expect(apiRejection({ ...ok, origin: 'https://evil.example' }, 4000, 'secret')).toBe(403);
    expect(apiRejection({ ...ok, origin: 'null' }, 4000, 'secret')).toBe(403);
    expect(apiRejection({ ...ok, host: 'evil.example:4000' }, 4000, 'secret')).toBe(403);
    expect(apiRejection({ ...ok, host: 'localhost:4000' }, 4000, 'secret')).toBe(403);
    expect(apiRejection({ ...ok, host: '127.0.0.1:4001' }, 4000, 'secret')).toBe(403);
    expect(apiRejection({ authorization: 'Bearer secret' }, 4000, 'secret')).toBe(403);
  });

  it('refuses a missing, malformed or wrong token, and any token when none is set', () => {
    expect(apiRejection({ host: ok.host }, 4000, 'secret')).toBe(401);
    expect(apiRejection({ ...ok, authorization: 'secret' }, 4000, 'secret')).toBe(401);
    expect(apiRejection({ ...ok, authorization: 'Bearer secreT' }, 4000, 'secret')).toBe(401);
    expect(apiRejection({ ...ok, authorization: 'Bearer longer-secret' }, 4000, 'secret')).toBe(401);
    expect(apiRejection({ ...ok, authorization: 'Bearer ' }, 4000, '')).toBe(401);
  });
});

describe('POST /api/<tool>', () => {
  let server: HookServer | undefined;
  afterEach(() => { server?.dispose(); server = undefined; handle.mockClear(); });

  async function start(api?: ApiEndpoint): Promise<number> {
    server = new HookServer({ updateState: vi.fn() });
    if (api) server.setApi(api);
    await server.start();
    return server.listeningPort;
  }

  function call(
    port: number,
    tool: string,
    opts: { body?: string; headers?: Record<string, string>; method?: string } = {},
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: `/api/${tool}`, method: opts.method ?? 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json', ...opts.headers },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined });
        });
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  const handle = vi.fn(async (tool: string, request: unknown) => ({ ok: true as const, result: { tool, request } }));

  it('reports its port once listening', async () => {
    const s = new HookServer({ updateState: vi.fn() });
    expect(s.listeningPort).toBe(0);
    await s.start();
    expect(s.listeningPort).toBeGreaterThan(0);
    s.dispose();
  });

  it('hands the tool and the parsed body to the endpoint and answers its result as JSON', async () => {
    const port = await start({ token: 'tok', handle });
    const res = await call(port, 'stack_status', { body: JSON.stringify({ args: { a: 1 }, context: { cwd: '/x' } }) });
    expect(res).toEqual({ status: 200, json: { ok: true, result: { tool: 'stack_status', request: { args: { a: 1 }, context: { cwd: '/x' } } } } });
  });

  it('takes an empty body as no arguments', async () => {
    const port = await start({ token: 'tok', handle });
    expect((await call(port, 'stack_status')).json).toEqual({ ok: true, result: { tool: 'stack_status', request: {} } });
  });

  it('is off (404) until an endpoint is set', async () => {
    const port = await start();
    expect(await call(port, 'stack_status', { body: '{}' })).toEqual({ status: 404, json: { ok: false, error: 'The Stack window API is off.' } });
    server!.setApi(undefined);
  });

  it('refuses a browser (Origin), a foreign Host and a bad token before reading anything', async () => {
    const port = await start({ token: 'tok', handle });
    expect((await call(port, 'x', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call(port, 'x', { headers: { Host: `localhost:${port}` } })).status).toBe(403);
    expect(await call(port, 'x', { headers: { Authorization: 'Bearer nope' } })).toEqual({ status: 401, json: { ok: false, error: 'Bad or missing token.' } });
    expect(handle).not.toHaveBeenCalled();
  });

  it('answers 405 to anything but POST, 400 to a body that is not a JSON object, 413 to a huge one', async () => {
    const port = await start({ token: 'tok', handle });
    expect((await call(port, 'x', { method: 'GET' })).status).toBe(405);
    expect((await call(port, 'x', { body: '{nope' })).status).toBe(400);
    expect((await call(port, 'x', { body: '[1]' })).json).toEqual({ ok: false, error: 'The body must be a JSON object.' });
    expect((await call(port, 'x', { body: 'null' })).status).toBe(400);
    expect((await call(port, 'x', { body: `{"a":"${'x'.repeat(1024 * 1024 + 10)}"}` })).status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
  });

  it('turns an endpoint that throws into a tool error, never a 500', async () => {
    const port = await start({ token: 'tok', handle: async () => { throw new Error('boom'); } });
    expect(await call(port, 'x', { body: '{}' })).toEqual({ status: 200, json: { ok: false, error: 'boom' } });
    server!.setApi({ token: 'tok', handle: () => Promise.reject('plain') });
    expect((await call(port, 'x', { body: '{}' })).json).toEqual({ ok: false, error: 'plain' });
  });

  it('leaves /hook as it was: no token needed', async () => {
    const updateState = vi.fn();
    server = new HookServer({ updateState });
    server.setApi({ token: 'tok', handle });
    const url = await server.start();
    const status = await new Promise<number>((resolve) => {
      const req = http.request(`${url}/hook`, { method: 'POST', headers: { 'X-Stack-Hook': '2', 'X-Stack-Event': 'Stop', 'X-Stack-Workspace': 'w' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.end('{}');
    });
    expect(status).toBe(200);
    expect(updateState).toHaveBeenCalledWith('w', 'waiting');
  });
});
