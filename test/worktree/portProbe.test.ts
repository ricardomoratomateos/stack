import * as net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { isPortFree } from '../../src/worktree/portProbe';

const servers: net.Server[] = [];

/** Bind a real listener and return its port — the only honest way to test this. */
async function listen(host = '0.0.0.0'): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, host, done));
  return (server.address() as net.AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

describe('isPortFree', () => {
  it('reports a port nothing is listening on as free', async () => {
    // Bind then release: the port is known-valid and known-unused right after.
    const port = await listen();
    await new Promise<void>((done) => servers.pop()!.close(() => done()));
    await expect(isPortFree(port)).resolves.toBe(true);
  });

  it('reports a port with a live listener as taken', async () => {
    const port = await listen();
    await expect(isPortFree(port)).resolves.toBe(false);
  });

  it('sees a loopback-only listener as taken, which a wildcard-only probe would miss', async () => {
    // On macOS/BSD binding 0.0.0.0 succeeds while 127.0.0.1 is held, so the
    // loopback probe is the only thing standing between this and a false "free".
    const port = await listen('127.0.0.1');
    await expect(isPortFree(port)).resolves.toBe(false);
  });

  it('leaves nothing bound behind, so the same port probes free twice in a row', async () => {
    const port = await listen();
    await new Promise<void>((done) => servers.pop()!.close(() => done()));
    await expect(isPortFree(port)).resolves.toBe(true);
    await expect(isPortFree(port)).resolves.toBe(true);
  });

  it.each([0, -1, 65536, 1.5, NaN])('rejects %s as unbindable rather than probing it', async (port) => {
    await expect(isPortFree(port)).resolves.toBe(false);
  });
});
