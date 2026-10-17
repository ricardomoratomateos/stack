/**
 * What the Stack MCP bridge and a VS Code window say to each other.
 *
 * The bridge (dist/stack-mcp.js, copied into globalStorage) is the MCP server
 * an agent talks to over stdio. It holds no state of its own: on every tool
 * call it finds the window that owns the repository through a discovery file
 * (`windows/<pid>.json`) and forwards the call to that window's HookServer as
 * `POST /api/<tool>` with the window's token. Shared here so both ends agree
 * on names and shapes; everything in it is plain data — the bridge bundle
 * must not pull in `vscode`.
 */

/** `<globalStorage>/windows/<pid>.json`, one per open window. */
export const WINDOWS_DIR = 'windows';

/** `<globalStorage>/stack-mcp.js`: the bridge at a path that survives extension updates. */
export const BRIDGE_FILE = 'stack-mcp.js';

/** The name the bridge is registered under, in Claude Code and in the workers' --mcp-config. */
export const MCP_SERVER_NAME = 'stack';

/** Set in a worker's MCP server env: the worktree it runs in. */
export const TASK_ENV = 'STACK_TASK_ID';

/** Overrides where the bridge looks for discovery files (tests; normally the bridge's own directory). */
export const STORAGE_ENV = 'STACK_STORAGE_DIR';

/** The most pane lines stack_read_agent returns. */
export const MAX_READ_LINES = 200;

/** stack_wait's ceiling, kept under the two minutes some MCP clients give a tool call. */
export const MAX_WAIT_SECONDS = 110;

export const TOOL_NAMES = [
  'stack_status',
  'stack_create_task',
  'stack_send_to_agent',
  'stack_read_agent',
  'stack_wait',
  'stack_env',
  'stack_request_review',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** The discovery file a window writes (0600) so a bridge can find and reach it. */
export interface WindowFile {
  pid: number;
  port: number;
  /** Bearer token for /api/*; per window, regenerated on every activation. */
  token: string;
  /** The window's repository and its worktrees' paths. */
  repoRoots: string[];
  /** VS Code's workspace folders. */
  workspaceFolders: string[];
  /** Ids of the worktrees the window shows, so a task id finds its window. */
  worktreeIds: string[];
  /** Epoch ms the window last had focus; breaks ties between windows on one repository. */
  focusedAt: number;
}

/** What the bridge knows about where it runs, sent with every call. */
export interface ToolContext {
  /** The bridge's working directory (an agent's project directory). */
  cwd?: string;
  /** $STACK_TASK_ID: set for a worker Stack launched. */
  taskId?: string;
}

/** Body of `POST /api/<tool>`. */
export interface ApiRequest {
  args?: Record<string, unknown>;
  context?: ToolContext;
}

/** Every answer from /api/*, tool errors included: an error is a result the agent should read. */
export type ApiResponse = { ok: true; result: unknown } | { ok: false; error: string };

/** A ticket from the user's tracker, as the manager agent passes it on. */
export interface TicketInput {
  /** Where it comes from: "jira", "linear", "github"… */
  source: string;
  key: string;
  url?: string;
  title?: string;
  /** The ticket's text — handed to the worker as data, never stored. */
  description?: string;
}
