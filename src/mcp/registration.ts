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
 * "Stack: Enable Manager (MCP)": registers the bridge with Claude Code at
 * user scope, so every Claude Code session — the VS Code panel included —
 * has the Stack tools. Any earlier `stack` entry is removed first: `mcp add`
 * refuses a name that exists, and an old entry may point at an old path.
 */
export async function enableManager(run: Run, claude: string, bridge: BridgeCommand): Promise<{ ok: boolean; message: string }> {
  await run(claude, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
  const added = await run(claude, ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', bridge.command, ...bridge.args]);
  if (added.code === 0) {
    return {
      ok: true,
      message: 'Stack: manager tools registered with Claude Code (user scope, "stack"). Start a new Claude Code session — the panel included — and ask it to create Stack tasks.',
    };
  }
  if (added.code === null) {
    return { ok: false, message: `Stack: could not run "${claude}" (${detail(added) || 'not found'}). Install Claude Code or set stack.claudeCommand.` };
  }
  return { ok: false, message: `Stack: "claude mcp add" failed: ${detail(added) || `exit code ${added.code}`}` };
}

/** "Stack: Disable Manager (MCP)": removes the user-scope `stack` server. */
export async function disableManager(run: Run, claude: string): Promise<{ ok: boolean; message: string }> {
  const removed = await run(claude, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
  if (removed.code === 0) return { ok: true, message: 'Stack: manager tools removed from Claude Code.' };
  if (removed.code === null) {
    return { ok: false, message: `Stack: could not run "${claude}" (${detail(removed) || 'not found'}).` };
  }
  return { ok: false, message: `Stack: nothing to remove — ${detail(removed) || `exit code ${removed.code}`}` };
}

/**
 * Whether Claude Code has the user-scope `stack` server — what the settings
 * panel's switch shows. Read from ~/.claude.json rather than `claude mcp get`,
 * which health-checks the server and takes seconds; the panel only needs to
 * know the entry is there. Unreadable or unparsable config reads as "off".
 */
export function managerEnabled(readText: (file: string) => string | undefined, claudeConfigPath: string): boolean {
  try {
    const text = readText(claudeConfigPath);
    if (!text) return false;
    const servers = (JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers;
    return !!servers && Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_NAME);
  } catch {
    return false;
  }
}
