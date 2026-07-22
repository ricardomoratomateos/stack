import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import { exec } from 'node:child_process';
import { HookServer } from '../../src/server/HookServer';

// Intercept the child_process module so the DEFAULT soundExec
// (`(cmd) => { exec(cmd); }`) runs for real without playing a sound.
vi.mock('node:child_process', () => ({ exec: vi.fn() }));

function postHook(baseUrl: string, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/hook`, { method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

describe('HookServer default soundExec', () => {
  let server: HookServer | undefined;

  afterEach(() => {
    server?.dispose();
    server = undefined;
    vi.mocked(exec).mockReset();
  });

  it('shells out to afplay on Stop on darwin when soundExec is not injected', async () => {
    const updateState = vi.fn();
    server = new HookServer({ updateState }, 'darwin'); // default soundExec
    const url = await server.start();

    const status = await postHook(url, { event: 'Stop', workspaceId: 'ws1' });

    expect(status).toBe(200);
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exec).mock.calls[0][0]).toBe('afplay /System/Library/Sounds/Glass.aiff');
  });
});
