import * as net from 'node:net';

/**
 * Whether a TCP port can actually be bound right now, asked the only way that
 * cannot lie: by binding it. The port registry only knows about worktrees
 * Unmess created, so it happily hands out a port already taken by another
 * project's container, a leftover stack from a deleted worktree, or a plain
 * local process — and the failure surfaces minutes later as a cryptic
 * `Bind for 0.0.0.0:8083 failed: port is already allocated` from docker.
 *
 * Probes `0.0.0.0` (what docker's port publishing binds) *and* `127.0.0.1`,
 * because on macOS/BSD a wildcard bind happily coexists with a loopback-only
 * one — so checking the wildcard alone would call a port free while a local dev
 * server already owns localhost on it. The asymmetry justifies the extra
 * syscall: a false "free" costs a full setup run that dies at the last step, a
 * false "taken" costs one slot.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return (await canBind(port, '0.0.0.0')) && (await canBind(port, '127.0.0.1'));
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    // Stays attached so the close() below can never emit an unhandled 'error'.
    server.on('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}
