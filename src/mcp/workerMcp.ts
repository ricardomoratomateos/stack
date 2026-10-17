import * as fs from 'node:fs';
import * as path from 'node:path';
import { shellQuote } from '../shell/shellQuote';
import { resolveOnPath } from '../providers/commandLookup';
import { BRIDGE_FILE, MCP_SERVER_NAME, TASK_ENV } from './protocol';

/** How to start the bridge: `node <globalStorage>/stack-mcp.js`. */
export interface BridgeCommand {
  command: string;
  args: string[];
}

/**
 * The bridge's command line. Node by absolute path when it can be found, so
 * a Claude Code or a worker started with a thinner PATH still finds it; bare
 * `node` otherwise.
 */
export function bridgeCommand(bridgePath: string, env: NodeJS.ProcessEnv = process.env): BridgeCommand {
  return { command: resolveOnPath('node', env) ?? 'node', args: [bridgePath] };
}

/**
 * Copies the bundled bridge (dist/stack-mcp.js) to `<globalStorage>/stack-mcp.js`,
 * the path registered with Claude Code: stable across extension updates,
 * where the extension's own directory is versioned. Rewritten only when the
 * content changed — and atomically, since an MCP client may be starting it.
 * Returns the installed path; undefined when there is no bridge to install
 * (a development build that has not bundled one).
 */
export function installBridge(source: string, storagePath: string): string | undefined {
  const target = path.join(storagePath, BRIDGE_FILE);
  let content: Buffer;
  try {
    content = fs.readFileSync(source);
  } catch {
    return fs.existsSync(target) ? target : undefined;
  }
  try {
    if (fs.readFileSync(target).equals(content)) return target;
  } catch { /* not installed yet */ }
  fs.mkdirSync(storagePath, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Claude Code's `--mcp-config '<json>'` for a worker: the bridge, told which
 * task it is. Not `--strict-mcp-config` — the worker keeps the user's own MCP
 * servers.
 */
export function claudeMcpArgs(bridge: BridgeCommand, worktreeId: string): string {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: { type: 'stdio', command: bridge.command, args: bridge.args, env: { [TASK_ENV]: worktreeId } },
    },
  };
  return `--mcp-config ${shellQuote(JSON.stringify(config))}`;
}

/**
 * Codex's `-c key=value` overrides for the same server. Values are TOML;
 * a JSON string literal is a valid TOML basic string.
 */
export function codexMcpArgs(bridge: BridgeCommand, worktreeId: string): string {
  const key = `mcp_servers.${MCP_SERVER_NAME}`;
  const pairs = [
    `${key}.command=${JSON.stringify(bridge.command)}`,
    `${key}.args=[${bridge.args.map((a) => JSON.stringify(a)).join(',')}]`,
    `${key}.env={${TASK_ENV}=${JSON.stringify(worktreeId)}}`,
  ];
  return pairs.map((p) => `-c ${shellQuote(p)}`).join(' ');
}
