import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import { HookServer, EVENT_TO_STATE } from '../../src/server/HookServer';

interface Response {
  status: number;
  body: string;
}

function request(
  baseUrl: string,
  opts: { method?: string; path?: string; body?: string } = {},
): Promise<Response> {
  const { method = 'POST', path = '/hook', body } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function postHook(baseUrl: string, payload: unknown): Promise<Response> {
  return request(baseUrl, { body: JSON.stringify(payload) });
}

describe('EVENT_TO_STATE', () => {
  it('maps exactly the 7 documented events', () => {
    expect(EVENT_TO_STATE).toEqual({
      SessionStart: 'waiting',
      UserPromptSubmit: 'active',
      PreToolUse: 'active',
      PostToolUse: 'active',
      Stop: 'waiting',
      SessionEnd: 'terminated',
      PermissionRequest: 'permission',
    });
  });
});

describe('POST /hook', () => {
  let server: HookServer | undefined;
  const updateState = vi.fn();
  const soundExec = vi.fn();

  async function startServer(platform: NodeJS.Platform = 'linux'): Promise<string> {
    server = new HookServer({ updateState }, platform, soundExec);
    return server.start();
  }

  afterEach(() => {
    server?.dispose();
    server = undefined;
    updateState.mockReset();
    soundExec.mockReset();
  });

  it('maps SessionStart → waiting', async () => {
    const url = await startServer();
    await postHook(url, { event: 'SessionStart', workspaceId: 'ws1' });
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting');
  });

  it('forwards a numeric windowIndex so only the emitting window lights up', async () => {
    const url = await startServer();
    await postHook(url, { event: 'Stop', workspaceId: 'ws1', windowIndex: '4' });
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting', 4);
  });

  it('omits windowIndex when empty or non-numeric (agents launched before UNMESS_WINDOW_INDEX)', async () => {
    const url = await startServer();
    await postHook(url, { event: 'Stop', workspaceId: 'ws1', windowIndex: '' });
    await postHook(url, { event: 'Stop', workspaceId: 'ws1', windowIndex: 'junk' });
    await postHook(url, { event: 'Stop', workspaceId: 'ws1' });
    expect(updateState.mock.calls).toEqual([
      ['ws1', 'waiting'],
      ['ws1', 'waiting'],
      ['ws1', 'waiting'],
    ]);
  });

  it('maps UserPromptSubmit / PreToolUse / PostToolUse → active', async () => {
    const url = await startServer();
    await postHook(url, { event: 'UserPromptSubmit', workspaceId: 'ws1' });
    await postHook(url, { event: 'PreToolUse', workspaceId: 'ws1' });
    await postHook(url, { event: 'PostToolUse', workspaceId: 'ws1' });
    expect(updateState.mock.calls).toEqual([
      ['ws1', 'active'],
      ['ws1', 'active'],
      ['ws1', 'active'],
    ]);
  });

  it('maps Stop → waiting', async () => {
    const url = await startServer();
    await postHook(url, { event: 'Stop', workspaceId: 'ws1' });
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting');
  });

  it('maps SessionEnd → terminated', async () => {
    const url = await startServer();
    await postHook(url, { event: 'SessionEnd', workspaceId: 'ws1' });
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(updateState).toHaveBeenCalledWith('ws1', 'terminated');
  });

  it('maps PermissionRequest → permission', async () => {
    const url = await startServer();
    await postHook(url, { event: 'PermissionRequest', workspaceId: 'ws1' });
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(updateState).toHaveBeenCalledWith('ws1', 'permission');
  });

  it('uses workspaceId as key, falls back to terminalId', async () => {
    const url = await startServer();
    await postHook(url, { event: 'SessionStart', workspaceId: 'ws1', terminalId: 't1' });
    expect(updateState).toHaveBeenLastCalledWith('ws1', 'waiting');
    await postHook(url, { event: 'SessionStart', terminalId: 't1' });
    expect(updateState).toHaveBeenLastCalledWith('t1', 'waiting');
    expect(updateState).toHaveBeenCalledTimes(2);
  });

  it('ignores unknown events (no updateState call)', async () => {
    const url = await startServer();
    const res = await postHook(url, { event: 'Nope', workspaceId: 'ws1' });
    expect(res.status).toBe(200);
    expect(updateState).not.toHaveBeenCalled();
  });

  it('ignores payloads with no event field at all', async () => {
    const url = await startServer();
    const res = await postHook(url, { workspaceId: 'ws1' });
    expect(res.status).toBe(200);
    expect(updateState).not.toHaveBeenCalled();
  });

  it('ignores missing workspaceId and terminalId', async () => {
    const url = await startServer();
    const res = await postHook(url, { event: 'SessionStart' });
    expect(res.status).toBe(200);
    expect(updateState).not.toHaveBeenCalled();
  });

  it('returns 200 on valid payload', async () => {
    const url = await startServer();
    const res = await postHook(url, { event: 'SessionStart', workspaceId: 'ws1' });
    expect(res.status).toBe(200);
  });

  it('returns 200 on malformed JSON (silently ignored — current behavior)', async () => {
    const url = await startServer();
    const res = await request(url, { body: '{not json!!' });
    expect(res.status).toBe(200);
    expect(updateState).not.toHaveBeenCalled();
    expect(soundExec).not.toHaveBeenCalled();
  });

  it('returns 404 on other routes/methods', async () => {
    const url = await startServer();
    const wrongRoute = await request(url, { path: '/notify', body: '{}' });
    expect(wrongRoute.status).toBe(404);
    const wrongMethod = await request(url, { method: 'GET' });
    expect(wrongMethod.status).toBe(404);
    const wrongBoth = await request(url, { method: 'PUT', path: '/', body: '{}' });
    expect(wrongBoth.status).toBe(404);
    expect(updateState).not.toHaveBeenCalled();
  });

  it('plays Glass.aiff on Stop on darwin', async () => {
    const url = await startServer('darwin');
    await postHook(url, { event: 'Stop', workspaceId: 'ws1' });
    expect(soundExec).toHaveBeenCalledTimes(1);
    expect(soundExec).toHaveBeenCalledWith('afplay /System/Library/Sounds/Glass.aiff');
  });

  it('plays the sound on darwin even when ids are missing (state not updated)', async () => {
    const url = await startServer('darwin');
    await postHook(url, { event: 'Stop' });
    expect(updateState).not.toHaveBeenCalled();
    expect(soundExec).toHaveBeenCalledTimes(1);
  });

  it('does NOT play the sound on Stop on linux', async () => {
    const url = await startServer('linux');
    await postHook(url, { event: 'Stop', workspaceId: 'ws1' });
    expect(soundExec).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting');
  });

  it('does NOT play the sound on darwin for non-Stop events', async () => {
    const url = await startServer('darwin');
    await postHook(url, { event: 'SessionStart', workspaceId: 'ws1' });
    expect(soundExec).not.toHaveBeenCalled();
  });

  it('start() resolves with a http://127.0.0.1:<port> base URL', async () => {
    const url = await startServer();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(url.split(':')[2]);
    expect(port).toBeGreaterThan(0);
  });

  it('constructor defaults (platform/sound omitted) still serve /hook', async () => {
    // Uses a non-Stop event so the real afplay default is never triggered.
    server = new HookServer({ updateState });
    const url = await server.start();
    const res = await postHook(url, { event: 'SessionStart', workspaceId: 'ws1' });
    expect(res.status).toBe(200);
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting');
  });

  it('dispose() closes the server (connections refused afterwards)', async () => {
    const url = await startServer();
    server!.dispose();
    server = undefined;
    await expect(postHook(url, { event: 'SessionStart', workspaceId: 'ws1' }))
      .rejects.toThrow();
    expect(updateState).not.toHaveBeenCalled();
  });
});

// ── start() defensive address handling ───────────────────────────────────────
// The listen callback re-checks server.address(); stub it on the real server
// instance (no http internals mocked) to drive the reject paths.

describe('start() defensive address handling', () => {
  it('rejects when address() returns null', async () => {
    const server = new HookServer({ updateState: vi.fn() }, 'linux', vi.fn());
    (server as unknown as { server: { address(): unknown } }).server.address = () => null;
    await expect(server.start()).rejects.toThrow('Failed to get server address');
    server.dispose();
  });

  it('rejects when address() returns a pipe-name string', async () => {
    const server = new HookServer({ updateState: vi.fn() }, 'linux', vi.fn());
    (server as unknown as { server: { address(): unknown } }).server.address = () => '/tmp/fake.sock';
    await expect(server.start()).rejects.toThrow('Failed to get server address');
    server.dispose();
  });
});
