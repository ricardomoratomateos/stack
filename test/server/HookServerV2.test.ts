import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import { HookServer, parseHook, type HookEvent } from '../../src/server/HookServer';

// ── v2 wire format: Stack's ids in headers, the agent's payload as the body ──

describe('POST /hook (v2: X-Stack-* headers)', () => {
  let server: HookServer | undefined;
  const updateState = vi.fn();

  afterEach(() => {
    server?.dispose();
    server = undefined;
    updateState.mockReset();
  });

  async function start(hasTerminals?: (id: string) => boolean): Promise<string> {
    server = new HookServer(hasTerminals ? { updateState, hasTerminals } : { updateState });
    return server.start();
  }

  function post(
    baseUrl: string,
    headers: Record<string, string>,
    body: string,
    path = '/hook',
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stack-Hook': '2', ...headers },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      req.end(body);
    });
  }

  const claudePayload = JSON.stringify({
    session_id: 'abc-123',
    transcript_path: '/Users/me/.claude/projects/x/abc-123.jsonl',
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
    cwd: '/repo',
  });

  it('takes a post from the notify.sh Foreman installed, X-Foreman-* headers and all', async () => {
    const url = await start();
    const status = await post(url, {
      'X-Foreman-Hook': '2', 'X-Foreman-Event': 'Stop', 'X-Foreman-Workspace': 'ws-old', 'X-Foreman-Window': '1',
    }, '{}');
    expect(status).toBe(200);
    expect(updateState).toHaveBeenCalledWith('ws-old', 'waiting', 1);
  });

  it('reads the ids from headers and maps the event to a state', async () => {
    const url = await start();
    const status = await post(url, {
      'X-Stack-Event': 'Stop', 'X-Stack-Workspace': 'ws1', 'X-Stack-Window': '4',
    }, '{"session_id":"s"}');
    expect(status).toBe(200);
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting', 4);
  });

  it("surfaces the agent's session id, transcript and message to listeners", async () => {
    const url = await start();
    const seen: HookEvent[] = [];
    server!.onHookEvent((e) => seen.push(e));
    await post(url, {
      'X-Stack-Event': 'Notification', 'X-Stack-Agent': 'claude',
      'X-Stack-Workspace': 'ws1', 'X-Stack-Window': '2', 'X-Stack-Pane': '%7',
    }, claudePayload);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      event: 'Notification',
      state: 'permission',
      workspaceId: 'ws1',
      windowIndex: 2,
      agent: 'claude',
      pane: '%7',
      sessionId: 'abc-123',
      transcriptPath: '/Users/me/.claude/projects/x/abc-123.jsonl',
      message: 'Claude needs your permission to use Bash',
    });
    expect(seen[0]?.payload['cwd']).toBe('/repo');
  });

  it('a listener can be disposed', async () => {
    const url = await start();
    const listener = vi.fn();
    server!.onHookEvent(listener).dispose();
    await post(url, { 'X-Stack-Event': 'Stop', 'X-Stack-Workspace': 'ws1' }, '{}');
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener does not cost the agent its answer', async () => {
    const url = await start();
    server!.onHookEvent(() => { throw new Error('boom'); });
    const status = await post(url, { 'X-Stack-Event': 'Stop', 'X-Stack-Workspace': 'ws1' }, '{}');
    expect(status).toBe(200);
    expect(updateState).toHaveBeenCalledTimes(1);
  });

  it('takes the event from the payload when the header is missing', async () => {
    const url = await start();
    await post(url, { 'X-Stack-Workspace': 'ws1' }, '{"hook_event_name":"PreToolUse"}');
    expect(updateState).toHaveBeenCalledWith('ws1', 'active');
  });

  it('accepts the ids in the query string as well', async () => {
    const url = await start();
    await post(url, {}, '{}', '/hook?event=Stop&workspace=ws1&window=3');
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting', 3);
  });

  it('still counts an event whose payload is not JSON', async () => {
    const url = await start();
    await post(url, { 'X-Stack-Event': 'Stop', 'X-Stack-Workspace': 'ws1' }, 'not json');
    expect(updateState).toHaveBeenCalledWith('ws1', 'waiting');
  });

  it('still counts an event whose payload is too large to parse', async () => {
    const url = await start();
    const seen: HookEvent[] = [];
    server!.onHookEvent((e) => seen.push(e));
    const huge = JSON.stringify({ session_id: 's', tool_input: { content: 'x'.repeat(2 * 1024 * 1024) } });
    await post(url, { 'X-Stack-Event': 'PreToolUse', 'X-Stack-Workspace': 'ws1' }, huge);
    expect(updateState).toHaveBeenCalledWith('ws1', 'active');
    expect(seen[0]?.payload).toEqual({});
  });

  it('answers 404 for a worktree this window does not track, touching nothing', async () => {
    // The hook takes 404 as "try your next endpoint": a stale route whose port
    // another window now holds must not swallow the event.
    const url = await start((id) => id === 'mine');
    const status = await post(url, { 'X-Stack-Event': 'Stop', 'X-Stack-Workspace': 'theirs' }, '{}');
    expect(status).toBe(404);
    expect(updateState).not.toHaveBeenCalled();

    expect(await post(url, { 'X-Stack-Event': 'Stop', 'X-Stack-Workspace': 'mine' }, '{}')).toBe(200);
    expect(updateState).toHaveBeenCalledWith('mine', 'waiting');
  });

  it('answers 200 to an unattributed event, and does nothing with it', async () => {
    // Every Claude session on the machine runs the global hook, including ones
    // started in a plain terminal. No state, no notification.
    const url = await start(() => true);
    const listener = vi.fn();
    server!.onHookEvent(listener);
    expect(await post(url, { 'X-Stack-Event': 'Stop' }, claudePayload)).toBe(200);
    expect(updateState).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('parseHook', () => {
  it('reads the v1 body format', () => {
    const e = parseHook({}, new URLSearchParams(), JSON.stringify({ event: 'Stop', workspaceId: 'w', windowIndex: '1' }));
    expect(e).toMatchObject({ event: 'Stop', state: 'waiting', workspaceId: 'w', windowIndex: 1, payload: {} });
  });

  it('keeps an event that maps to no state, for listeners', () => {
    const e = parseHook({ 'x-stack-hook': '2', 'x-stack-event': 'SubagentStop' }, new URLSearchParams(), '{}');
    expect(e?.event).toBe('SubagentStop');
    expect(e?.state).toBeUndefined();
  });

  it('rejects a negative or fractional window index', () => {
    const h = (w: string) =>
      parseHook({ 'x-stack-hook': '2', 'x-stack-event': 'Stop', 'x-stack-window': w }, new URLSearchParams(), '');
    expect(h('-1')?.windowIndex).toBeUndefined();
    expect(h('1.5')?.windowIndex).toBeUndefined();
    expect(h('0')?.windowIndex).toBe(0);
  });

  it('takes the first of a header sent twice', () => {
    const e = parseHook(
      { 'x-stack-hook': '2', 'x-stack-event': 'Stop', 'x-stack-workspace': ['wt-1', 'wt-2'] },
      new URLSearchParams(),
      '',
    );
    expect(e?.workspaceId).toBe('wt-1');
  });

  it("reads Foreman's X-Foreman-* headers — what agents started before the rename still send", () => {
    const e = parseHook({
      'x-foreman-hook': '2', 'x-foreman-event': 'PermissionRequest', 'x-foreman-agent': 'codex',
      'x-foreman-workspace': 'wt-old', 'x-foreman-window': '2', 'x-foreman-pane': '%7',
    }, new URLSearchParams(), '{"session_id":"s"}');
    expect(e).toMatchObject({
      event: 'PermissionRequest', state: 'permission', agent: 'codex',
      workspaceId: 'wt-old', windowIndex: 2, pane: '%7', sessionId: 's',
    });
  });

  it('prefers X-Stack-* when both names arrive', () => {
    const e = parseHook(
      { 'x-stack-hook': '2', 'x-stack-event': 'Stop', 'x-foreman-event': 'SessionEnd', 'x-foreman-workspace': ['wt-old'] },
      new URLSearchParams(),
      '',
    );
    expect(e?.event).toBe('Stop');
    expect(e?.workspaceId).toBe('wt-old');
  });

  it('is undefined without an event', () => {
    expect(parseHook({ 'x-stack-hook': '2' }, new URLSearchParams(), '{}')).toBeUndefined();
    expect(parseHook({}, new URLSearchParams(), undefined)).toBeUndefined();
  });
});
