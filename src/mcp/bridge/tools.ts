import { z } from 'zod';
import { MAX_READ_LINES, MAX_WAIT_SECONDS, type ToolName } from '../protocol';

/**
 * The tools the bridge advertises: descriptions written for the agent that
 * reads them, input schemas the MCP client validates against, and annotations
 * (read-only where nothing changes).
 */

const repo = z.string().optional()
  .describe('Path of the repository (or a folder inside it) whose Stack window to use. Defaults to where this agent runs.');
const taskId = z.string().describe('Task id, from stack_status or stack_create_task.');
const session = z.union([z.number().int(), z.string()]).optional()
  .describe('Session to use: its index or name from stack_status. Defaults to the task\'s main agent.');

export interface ToolDef {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** How long the bridge waits for the window, in ms, given the call's arguments. */
  timeoutMs(args: Record<string, unknown>): number;
}

const quick = () => 30_000;

export const TOOLS: ToolDef[] = [
  {
    name: 'stack_status',
    title: 'Stack: status',
    description:
      'Every task (git worktree) in the Stack window: id, name, branch, base, group (needs = an agent is asking you, review = done and ready for review, working, idle, missing), '
      + 'its sessions with state and any pending question, diff (+added −removed), PR with CI, ports, linked ticket and review summary. Pass task_id for one task.',
    inputSchema: { task_id: taskId.optional(), repo },
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: quick,
  },
  {
    name: 'stack_create_task',
    title: 'Stack: create task',
    description:
      'Create a task: a new branch and git worktree with a coding agent started in it on `prompt`. '
      + 'With `ticket`, the branch defaults to <KEY>-<slug of title>, the ticket shows on the task in VS Code, and its content (title, url, description) is handed to the worker as reference data below your prompt. '
      + 'Idempotent per ticket: a task for the same ticket key (stored, or a branch starting with the key) is returned as "existing" instead of creating another. '
      + 'Returns task_id; follow up with stack_wait / stack_status.',
    inputSchema: {
      title: z.string().describe('Short name for the task, shown in the sidebar.'),
      prompt: z.string().describe('What the worker agent should do. Self-contained: it has not seen this conversation.'),
      base_branch: z.string().optional().describe('Branch to start from. Defaults to the repository\'s configured base (develop/main).'),
      agent: z.enum(['claude', 'codex', 'opencode']).optional().describe('Agent to run. Defaults to the user\'s default.'),
      branch: z.string().optional().describe('Branch name. Defaults to <KEY>-<slug> with a ticket, else a slug of the title.'),
      ticket: z.object({
        source: z.string().describe('Tracker: jira, linear, github…'),
        key: z.string().describe('Ticket key, e.g. AS-1234.'),
        url: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional().describe('The ticket\'s text, passed to the worker as data.'),
      }).optional(),
      repo,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    timeoutMs: () => 180_000,
  },
  {
    name: 'stack_send_to_agent',
    title: 'Stack: send to agent',
    description:
      'Type a message into a task\'s running agent and submit it, the way a person would at its prompt. '
      + 'If the agent is showing a permission prompt, this answers that prompt (Enter accepts the highlighted option). '
      + 'Answers delivered, or refused with the reason when the task has no live agent.',
    inputSchema: { task_id: taskId, message: z.string().describe('The message.'), session, repo },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    timeoutMs: () => 60_000,
  },
  {
    name: 'stack_read_agent',
    title: 'Stack: read agent',
    description: `The last lines of a task's agent terminal (plain text): what it is doing or asking right now. lines ≤ ${MAX_READ_LINES}, default 80.`,
    inputSchema: {
      task_id: taskId,
      session,
      lines: z.number().int().min(1).max(MAX_READ_LINES).optional(),
      repo,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: quick,
  },
  {
    name: 'stack_wait',
    title: 'Stack: wait',
    description:
      'Block until one of the tasks\' agents goes idle (finished its turn), needs input (permission or question), or the timeout passes — whichever comes first. '
      + `Returns which task and what happened (idle, needs_input, failed, timeout). Returns at once if one already matches. timeout_s ≤ ${MAX_WAIT_SECONDS}; call again to keep waiting.`,
    inputSchema: {
      task_ids: z.array(z.string()).min(1).describe('Tasks to watch.'),
      until: z.enum(['idle', 'needs_input', 'any']).optional().describe('What to wait for. Default any.'),
      timeout_s: z.number().min(0).max(MAX_WAIT_SECONDS).optional().describe(`Seconds, default ${MAX_WAIT_SECONDS}.`),
      repo,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: (args) => (typeof args.timeout_s === 'number' ? Math.min(args.timeout_s, MAX_WAIT_SECONDS) : MAX_WAIT_SECONDS) * 1000 + 15_000,
  },
  {
    name: 'stack_env',
    title: 'Stack: task environment',
    description:
      'For the agent working in a Stack task: its worktree path, branch and base, its ports by name with URLs, the Docker Compose project with ready-made `docker compose … logs` and `ps` commands, '
      + 'the setup/teardown scripts, and the test command when the repository has one. task_id defaults to this agent\'s own task.',
    inputSchema: { task_id: taskId.optional(), repo },
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: quick,
  },
  {
    name: 'stack_request_review',
    title: 'Stack: request review',
    description:
      'Say the task is done: marks it ready for review in VS Code with your one-line summary and opens its Review panel for the user. task_id defaults to this agent\'s own task.',
    inputSchema: { task_id: taskId.optional(), summary: z.string().describe('One line: what changed.'), repo },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    timeoutMs: quick,
  },
];

/** What the bridge tells an MCP client about itself. */
export const INSTRUCTIONS =
  'Stack runs coding agents in parallel git worktrees ("tasks") inside VS Code. '
  + 'Typical manager loop: read the ticket elsewhere (Jira, Linear…), stack_create_task with the ticket, stack_wait on the task ids, '
  + 'then stack_status / stack_read_agent to see where they are and stack_send_to_agent to answer questions or give feedback. '
  + 'Workers inside a task: stack_env for ports, logs and test commands; stack_request_review when done.';
