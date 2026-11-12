import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { MCP_SERVER_NAME } from './protocol';
import type { BridgeCommand } from './workerMcp';

export interface RunResult {
  /** Exit code; null when the program could not be started at all. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program with an argument vector — no shell — and never rejects. */
export type Run = (file: string, args: string[]) => Promise<RunResult>;

export const execRun: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      // A program that ran and failed has its exit code here; one that could
      // not be started has a string (ENOENT) — or nothing, when it was killed.
      const raw = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof raw === 'number' ? raw : null;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (code === null ? err!.message : '') });
    });
  });

/** The `claude` binary of a configured command line ("claude --flag" → "claude"). */
export function claudeBinary(claudeCommand: string): string {
  return claudeCommand.trim().split(/\s+/)[0] || 'claude';
}

const detail = (r: RunResult) => (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ');

/**
 * Registers the bridge with Claude Code at user scope, so every Claude Code
 * session has the Stack tools. Any earlier `stack` entry is removed first:
 * `mcp add` refuses a name that exists, and an old entry may point at an old
 * path (the VS Code extension's globalStorage).
 */
export async function enableManager(run: Run, claude: string, bridge: BridgeCommand): Promise<{ ok: boolean; message: string }> {
  await run(claude, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
  const added = await run(claude, ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', bridge.command, ...bridge.args]);
  if (added.code === 0) {
    return { ok: true, message: 'Stack tools registered with Claude Code. Start a new Claude Code session (or /mcp → reconnect "stack").' };
  }
  if (added.code === null) {
    return { ok: false, message: `Could not run "${claude}" (${detail(added) || 'not found'}). Install Claude Code or set claudeCommand.` };
  }
  return { ok: false, message: `"claude mcp add" failed: ${detail(added) || `exit code ${added.code}`}` };
}

export type ManagerState = 'registered' | 'elsewhere' | 'missing';

/**
 * Whether Claude Code's user-scope `stack` server is this stackd's bridge.
 * Read from ~/.claude.json rather than `claude mcp get`, which health-checks
 * the server and takes seconds. `elsewhere`: an entry exists but runs another
 * file (the extension's old copy) or a node that is gone; `detail` says what.
 */
export function managerStatus(claudeConfigPath: string, bridgePath: string | undefined): { state: ManagerState; detail?: string } {
  let entry: { command?: unknown; args?: unknown } | undefined;
  try {
    const servers = (JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')) as { mcpServers?: Record<string, typeof entry> }).mcpServers;
    entry = servers && Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_NAME) ? servers[MCP_SERVER_NAME] ?? {} : undefined;
  } catch {
    entry = undefined;
  }
  if (!entry) return { state: 'missing' };
  const command = typeof entry.command === 'string' ? entry.command : '';
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const nodeThere = command !== '' && (!command.includes('/') || fs.existsSync(command));
  if (bridgePath && args[0] === bridgePath && nodeThere) return { state: 'registered' };
  return { state: 'elsewhere', detail: [command, ...args].join(' ').trim() };
}
