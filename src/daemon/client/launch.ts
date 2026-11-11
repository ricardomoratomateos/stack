import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { callDaemon } from '../api';

/** `~/.config/stack` (or STACKD_CONFIG_DIR): where the daemon keeps its state and its socket. */
export const daemonConfigDir = (): string => process.env.STACKD_CONFIG_DIR || path.join(os.homedir(), '.config', 'stack');

/** Whether a daemon answers on this socket. */
export async function daemonRunning(socketPath: string): Promise<boolean> {
  try {
    await callDaemon(socketPath, 'GET', '/state');
    return true;
  } catch {
    return false;
  }
}

export interface SpawnOptions {
  /** The node to run it with: the user's, or VS Code's own (`process.execPath` with ELECTRON_RUN_AS_NODE). */
  node: string;
  /** `dist/stackd.js`. */
  script: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Starts `stackd serve` detached: it outlives the window that started it (that
 * is the point), logs to `<configDir>/stackd.log`, and waits for a client's
 * importState before it reads any state.
 */
export function spawnDaemon(o: SpawnOptions): number | undefined {
  fs.mkdirSync(o.configDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(o.configDir, 'stackd.log'), 'a');
  try {
    const child = spawn(o.node, [o.script, 'serve'], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STACKD_DEFER_IMPORT: '1', ...o.env },
    });
    child.on('error', () => {});
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

/** Connects to the running daemon, or starts one and waits until it answers. True when it had to start it. */
export async function ensureDaemon(o: {
  socketPath: string;
  start: () => void;
  timeoutMs?: number;
}): Promise<boolean> {
  if (await daemonRunning(o.socketPath)) return false;
  o.start();
  const end = Date.now() + (o.timeoutMs ?? 10000);
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    if (await daemonRunning(o.socketPath)) return true;
  }
  throw new Error(`stackd did not start (see ${path.join(path.dirname(o.socketPath), 'stackd.log')}).`);
}
