import * as http from 'node:http';
import { AgentSessionState } from '../types';

/** Structural interface satisfied by AgentSessionManager. */
export interface AgentStateUpdater {
  updateState(workspaceId: string, state: AgentSessionState, windowIndex?: number): void;
  /**
   * Whether this window tracks the worktree at all. Optional so plain doubles
   * keep working; without it every attributed event is accepted.
   */
  hasTerminals?(workspaceId: string): boolean;
}

export const EVENT_TO_STATE: Record<string, AgentSessionState> = {
  SessionStart:    'waiting',
  UserPromptSubmit:'active',
  PreToolUse:      'active',
  PostToolUse:     'active',
  Stop:            'waiting',
  SessionEnd:      'terminated',
  PermissionRequest: 'permission',
  // Notification is an agent's generic "the agent wants you" signal, which is
  // what the attention badge exists to surface.
  Notification:      'permission',
};

/**
 * One hook event, as received — for consumers that want more than the state.
 *
 * `sessionId`, `transcriptPath` and `message` are lifted out of the agent's own
 * payload when it carries them (Claude Code and Codex send `session_id`,
 * `transcript_path`, and `message` on Notification); nothing consumes them yet.
 * They are surfaced here so per-window metadata (resuming a session, reading
 * its transcript, showing why an agent wants you) can be built on
 * `HookServer.onHookEvent` without touching the hook script again — changing
 * that script costs every Codex user a re-trust.
 */
export interface HookEvent {
  event: string;
  /** Undefined for events that map to no state. */
  state?: AgentSessionState;
  /** Worktree id; '' for an agent running outside any Stack session. */
  workspaceId: string;
  windowIndex?: number;
  /** Provider id the hook was registered for ('claude', 'codex', 'opencode'), when known. */
  agent?: string;
  /** tmux pane id ("%12") the hook ran in, when it ran in one. */
  pane?: string;
  sessionId?: string;
  transcriptPath?: string;
  message?: string;
  /** The agent's payload verbatim; `{}` for the legacy format, which carried none. */
  payload: Record<string, unknown>;
}

/**
 * A payload bigger than this is not parsed (the ids travel in headers, so the
 * event still counts). Claude's PreToolUse for a Write carries the whole file,
 * and nothing we read from the body is worth buffering megabytes for.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * "Not a worktree this window tracks". The hook takes any 4xx as a cue to try
 * its next endpoint, so an agent whose route went stale (its window crashed and
 * another one now sits on the same port) still finds its way instead of being
 * swallowed by the wrong window. 404 rather than the more precise 421, which
 * some HTTP clients (Node's fetch among them) silently retry; and an unrelated
 * server on a reused port answers 404 too, which then means the same thing.
 */
const NOT_MINE = 404;

export class HookServer {
  private server: http.Server;
  private port = 0;
  private listeners = new Set<(e: HookEvent) => void>();

  constructor(private agentManager: AgentStateUpdater) {
    this.server = http.createServer((req, res) => {
      // Always set on a request a server received; only client-side messages lack it.
      const url = new URL(req.url!, 'http://localhost');
      if (req.method !== 'POST' || url.pathname !== '/hook') {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      req.on('end', () => {
        const body = size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString('utf8') : undefined;
        let status = 200;
        try {
          status = this.handle(parseHook(req.headers, url.searchParams, body));
        } catch {
          // A misbehaving listener must not cost the agent its answer.
        }
        res.writeHead(status);
        res.end();
      });
    });
  }

  /** Every hook event this window accepts. Returns a disposable. */
  onHookEvent(listener: (e: HookEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private handle(e: HookEvent | undefined): number {
    // Malformed: nothing to act on, and nothing anyone else could do with it.
    if (!e) return 200;
    // Unattributed — an agent running outside any Stack session, still
    // reaching the hook because it is global. Not ours to paint or notify
    // about; answered 200 so the hook does not keep looking.
    if (!e.workspaceId) return 200;
    if (this.agentManager.hasTerminals && !this.agentManager.hasTerminals(e.workspaceId)) return NOT_MINE;

    if (e.state) {
      if (e.windowIndex !== undefined) this.agentManager.updateState(e.workspaceId, e.state, e.windowIndex);
      else this.agentManager.updateState(e.workspaceId, e.state);
    }
    // No sound here. A chime on every Stop rang for agents the user was
    // watching finish, and with stack.notifyOnAttention off; it now comes with
    // the native notification, from the one place that decides whether the
    // user needs telling (AttentionNotifier).
    for (const listener of this.listeners) listener(e);
    return 200;
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
      this.server.on('error', reject);
    });
  }

  dispose(): void {
    this.listeners.clear();
    this.server.close();
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * Reads either wire format.
 *
 * - v2 (notify.sh from 0.1.1 on, the opencode plugin): Stack's ids in
 *   `X-Stack-*` headers — `X-Foreman-*` from scripts written before the
 *   rename — (or the query string), the body the agent's own payload, untouched.
 * - v1: a body of `{ event, terminalId, workspaceId, windowIndex }` and nothing
 *   else. Still accepted, because an agent started under the old script keeps
 *   whatever hook it had until it restarts — and Codex, until the user
 *   re-trusts the new script, runs none at all.
 *
 * Undefined when there is nothing to act on.
 */
export function parseHook(
  headers: http.IncomingHttpHeaders,
  query: URLSearchParams,
  body: string | undefined,
): HookEvent | undefined {
  // X-Foreman-*: the same headers under the extension's old name, sent by
  // the notify.sh and opencode plugin Foreman installed — which agents it
  // started keep running until they restart.
  const one = (v: string | string[] | undefined) => str(Array.isArray(v) ? v[0] : v);
  const header = (name: string): string | undefined =>
    one(headers[`x-stack-${name}`]) ?? one(headers[`x-foreman-${name}`]) ?? str(query.get(name));

  let json: Record<string, unknown> = {};
  if (body !== undefined && body.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      json = {};
    }
  }

  const v2 = header('hook') !== undefined;
  const event = v2 ? header('event') ?? str(json['hook_event_name']) : str(json['event']);
  if (!event) return undefined;

  const workspaceId = (v2 ? header('workspace') : str(json['workspaceId']) ?? str(json['terminalId'])) ?? '';
  // Empty = an agent launched before STACK_WINDOW_INDEX existed, or one tmux
  // could not place: the event then applies to every agent window of the worktree.
  const rawIndex = v2 ? header('window') : str(json['windowIndex']);
  const index = rawIndex !== undefined ? Number(rawIndex) : NaN;
  const payload = v2 ? json : {};

  return {
    event,
    state: EVENT_TO_STATE[event],
    workspaceId,
    windowIndex: Number.isInteger(index) && index >= 0 ? index : undefined,
    agent: v2 ? header('agent') : undefined,
    pane: v2 ? header('pane') : undefined,
    sessionId: str(payload['session_id']),
    transcriptPath: str(payload['transcript_path']),
    message: str(payload['message']),
    payload,
  };
}
