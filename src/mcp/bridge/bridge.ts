import * as http from 'node:http';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readWindows, resolveWindow, isPidAlive } from '../discovery';
import { TASK_ENV, WINDOWS_DIR, type ApiRequest, type ApiResponse, type WindowFile } from '../protocol';
import { INSTRUCTIONS, TOOLS } from './tools';

export interface BridgeOptions {
  /** globalStorage: where `windows/` is. */
  storageDir: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  version: string;
  isAlive?: (pid: number) => boolean;
}

/** A tool result an MCP client renders: JSON text, or an error the agent reads. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * POST one call to a window's /api and read its ApiResponse. Never rejects: a
 * window that is not there, too slow or answering nonsense comes back as
 * `{ ok: false }` with a sentence the agent can act on.
 */
export function callWindow(window: WindowFile, tool: string, request: ApiRequest, timeoutMs: number): Promise<ApiResponse> {
  const where = window.repoRoots[0] ?? window.workspaceFolders[0] ?? `pid ${window.pid}`;
  return new Promise((resolve) => {
    const body = JSON.stringify(request);
    const req = http.request({
      // The literal address, never "localhost": the window only answers a
      // Host of 127.0.0.1:<port> (see HookServer.apiRejection).
      host: '127.0.0.1',
      port: window.port,
      path: `/api/${tool}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${window.token}`,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(text) as ApiResponse;
          if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return resolve(parsed);
        } catch { /* below */ }
        resolve({ ok: false, error: `The Stack window for ${where} answered HTTP ${res.statusCode} without a result.` });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, error: `The Stack window for ${where} did not answer within ${Math.round(timeoutMs / 1000)}s.` });
    });
    req.on('error', (e: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        error: e.code === 'ECONNREFUSED'
          ? `The Stack window for ${where} is not answering — it may be reloading. Try again in a moment.`
          : `Could not reach the Stack window for ${where}: ${e.message}`,
      });
    });
    req.end(body);
  });
}

/**
 * Runs one tool call: finds the window (fresh, every call), forwards the call,
 * and turns the answer into an MCP result. Never throws.
 */
export async function forward(opts: BridgeOptions, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const def = TOOLS.find((t) => t.name === tool);
    if (!def) return fail(`Unknown tool "${tool}".`);
    const { repo, ...rest } = args;
    const ownTask = opts.env[TASK_ENV] || undefined;
    const named = typeof rest.task_id === 'string' && rest.task_id
      ? rest.task_id
      : Array.isArray(rest.task_ids) && typeof rest.task_ids[0] === 'string' ? rest.task_ids[0] : undefined;
    const windows = readWindows(path.join(opts.storageDir, WINDOWS_DIR), opts.isAlive ?? isPidAlive);
    const resolved = resolveWindow(windows, {
      repo: typeof repo === 'string' && repo ? path.resolve(opts.cwd, repo) : undefined,
      taskId: named ?? ownTask,
      paths: [opts.env.CLAUDE_PROJECT_DIR, opts.cwd].filter((p): p is string => !!p),
    });
    if ('error' in resolved) return fail(resolved.error);
    const answer = await callWindow(
      resolved.window,
      tool,
      { args: rest, context: { cwd: opts.cwd, ...(ownTask ? { taskId: ownTask } : {}) } },
      def.timeoutMs(rest),
    );
    if (!answer.ok) return fail(answer.error);
    return { content: [{ type: 'text', text: JSON.stringify(answer.result) }] };
  } catch (e) {
    return fail(`Stack bridge error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The MCP server: every tool forwards to the window that owns the repository. */
export function createBridgeServer(opts: BridgeOptions): McpServer {
  const server = new McpServer({ name: 'stack', version: opts.version }, { instructions: INSTRUCTIONS });
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
      (args: Record<string, unknown>) => forward(opts, def.name, args),
    );
  }
  return server;
}
