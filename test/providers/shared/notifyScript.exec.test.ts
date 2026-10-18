import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { JsonHookInstaller } from '../../../src/providers/shared/JsonHookInstaller';
import { HookRoutes } from '../../../src/providers/shared/HookRoutes';
import { HookEntry } from '../../../src/types';

/**
 * Runs notify.sh for real.
 *
 * Every other test of this script asserts on its *source text* — that it
 * contains a curl, that it reads the right files. None of them executes a line
 * of it, and this is the one part of Stack that runs on the user's machine
 * outside our control. A quoting mistake, an unset variable, a `cat` that
 * blocks, a fallback that never falls back: all of it would ship unverified.
 *
 * So: real HTTP servers, a real bash, and the request checked on arrival.
 */

let hasBash = false;
let hasCurl = false;
let hasTmux = false;
try { execSync('command -v bash', { stdio: 'ignore' }); hasBash = true; } catch { /* no bash */ }
try { execSync('command -v curl', { stdio: 'ignore' }); hasCurl = true; } catch { /* no curl */ }
try { execSync('command -v tmux', { stdio: 'ignore' }); hasTmux = true; } catch { /* no tmux */ }

/** The script only ever posts; without curl it is a no-op by design. */
const canRun = hasBash && hasCurl;

type Posted = { server: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** A port nothing listens on: bound once, then closed. */
async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('notify.sh (executed)', () => {
  let received: Posted[] = [];
  /** Status each named server answers with; 'hang' never answers. */
  const behaviour: Record<string, number | 'hang'> = {};
  /** Response body each named server answers with. */
  const replies: Record<string, string> = {};
  const servers: http.Server[] = [];
  const urls: Record<string, string> = {};

  const startServer = async (name: string): Promise<void> => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ server: name, url: req.url ?? '', headers: req.headers, body });
        const b = behaviour[name] ?? 200;
        if (b === 'hang') return;
        res.writeHead(b).end(replies[name] ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    urls[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  let tmpDir: string;
  let storageDir: string;
  let settingsPath: string;
  let scriptPath: string;

  beforeAll(async () => {
    // "fallback" is what hook-url points at (the last window to start);
    // "window" and "other" stand for specific windows.
    for (const name of ['fallback', 'window', 'other']) await startServer(name);
  });

  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    if (hasTmux) {
      for (const name of [TMUX_SESSION, `${TMUX_SESSION}__w5`]) {
        try { execSync(`tmux kill-session -t "=${name}"`, { stdio: 'ignore' }); } catch { /* gone */ }
      }
    }
  });

  const TMUX_SESSION = `stack-notifyexec-${process.pid}`;

  beforeEach(() => {
    received = [];
    for (const k of Object.keys(behaviour)) delete behaviour[k];
    for (const k of Object.keys(replies)) delete replies[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-notifyexec-'));
    // A directory with a space in it, because the real one is
    // "~/Library/Application Support/Code/User/globalStorage/..." on macOS and
    // an unquoted path there is the classic way this breaks for one platform.
    storageDir = path.join(tmpDir, 'Application Support', 'storage');
    settingsPath = path.join(tmpDir, 'agent', 'settings.json');
    scriptPath = path.join(storageDir, 'notify.sh');
    new JsonHookInstaller(storageDir, settingsPath, ['Stop'], 'claude').install(urls['fallback']!);
  });

  const route = (worktreeId: string, url: string) => new HookRoutes(storageDir).claim([worktreeId], url);

  /** Waits for the servers to have logged `n` posts — curl returns before we parse. */
  const waitForPosts = async (n: number, ms = 2000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (received.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  /**
   * Spawns bash and resolves once it exits.
   *
   * Asynchronous on purpose. spawnSync blocks Node's event loop, so the HTTP
   * servers above cannot answer the request the script is making — curl waits
   * for a reply that only arrives once the process it is blocking has exited.
   * The first version of this file deadlocked exactly that way and the posts
   * surfaced in whichever test ran after the kill.
   */
  const spawnBash = (
    argv: string[],
    env: Record<string, string>,
    input: string,
  ): Promise<{ status: number | null; stdout: string; stderr: string; stdinError?: string; ms: number }> =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn('bash', argv, {
        // Deliberately NOT process.env: this suite runs inside a terminal that
        // may well be a tmux pane with STACK_* exported, which would mask
        // exactly the fallbacks under test.
        env: { PATH: process.env['PATH'] ?? '', HOME: os.tmpdir(), ...env },
      });
      let stdout = '';
      let stderr = '';
      let stdinError: string | undefined;
      child.stderr.on('data', (c) => { stderr += c; });
      child.stdout.on('data', (c) => { stdout += c; });
      // Recorded rather than swallowed: whether the script read our stdin to the
      // end is the assertion, not an incidental detail. A script that exits
      // without reading leaves this write half-done and we get EPIPE.
      child.stdin.on('error', (e: Error) => { stdinError = e.message; });
      child.stdin.end(input);
      child.on('close', (status) => resolve({ status, stdout, stderr, stdinError, ms: Date.now() - started }));
    });

  /** Runs the script directly, with a clean environment plus `env`. */
  const run = (args: string[], env: Record<string, string> = {}, input = '') =>
    spawnBash([scriptPath, ...args], env, input);

  it.runIf(canRun)('forwards the payload verbatim, with our ids as headers', async () => {
    const payload = JSON.stringify({
      session_id: 's-1', transcript_path: '/tmp/t.jsonl', hook_event_name: 'Stop', message: 'say "hi" & $HOME',
    });
    const r = await run(['Stop', 'claude'], {
      STACK_WORKSPACE_ID: 'wt-abc',
      STACK_WINDOW_INDEX: '3',
    }, payload);
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);

    expect(received).toHaveLength(1);
    const [post] = received;
    expect(post?.url).toBe('/hook');
    // Byte for byte: no shell expansion, no re-quoting.
    expect(post?.body).toBe(payload);
    expect(post?.headers['x-stack-hook']).toBe('2');
    expect(post?.headers['x-stack-event']).toBe('Stop');
    expect(post?.headers['x-stack-agent']).toBe('claude');
    expect(post?.headers['x-stack-workspace']).toBe('wt-abc');
    expect(post?.headers['x-stack-window']).toBe('3');
  });

  it.runIf(canRun)("prefers the worktree's route over the launch env and the shared file", async () => {
    // Two windows open: hook-url says "fallback" (whichever started last),
    // but this worktree belongs to "window".
    route('wt-abc', urls['window']!);
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'wt-abc', STACK_HOOK_URL: urls['other']! }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    await waitForPosts(2, 200);
    expect(received.map((p) => p.server)).toEqual(['window']);
  });

  it.runIf(canRun)('reaches a reloaded window through its route, though the env still holds the old port', async () => {
    // The agent was launched before the reload: its STACK_HOOK_URL is dead.
    // The reloaded window claimed the route with its new port.
    route('wt-abc', urls['window']!);
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'wt-abc', STACK_HOOK_URL: await deadUrl() }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(received.map((p) => p.server)).toEqual(['window']);
  });

  it.runIf(canRun)('falls through a dead route to the launch env', async () => {
    // The route's window crashed without withdrawing it.
    route('wt-abc', await deadUrl());
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'wt-abc', STACK_HOOK_URL: urls['window']! }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(received.map((p) => p.server)).toEqual(['window']);
  });

  it.runIf(canRun)('moves on when a window answers 404 (not its worktree)', async () => {
    behaviour['other'] = 404;
    route('wt-abc', urls['other']!);
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'wt-abc', STACK_HOOK_URL: urls['window']! }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(2);
    expect(received.map((p) => p.server)).toEqual(['other', 'window']);
  });

  it.runIf(canRun)('posts each endpoint at most once', async () => {
    behaviour['window'] = 404;
    route('wt-abc', urls['window']!);
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'wt-abc', STACK_HOOK_URL: urls['window']! }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(3, 500);
    expect(received.map((p) => p.server)).toEqual(['window', 'fallback']);
  });

  it.runIf(canRun)('gives a stuck window one bounded wait, and does not try the others', async () => {
    // A paused extension host accepts the connection and never answers. The
    // agent is waiting on this hook, so the wait has to be capped — and must
    // not be paid again per fallback.
    behaviour['other'] = 'hang';
    route('wt-abc', urls['other']!);
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'wt-abc', STACK_HOOK_URL: urls['window']! }, '{}');
    expect(r.status, r.stderr).toBe(0);
    expect(r.ms).toBeLessThan(4000);
    expect(received.map((p) => p.server)).toEqual(['other']);
  }, 10_000);

  it.runIf(canRun)('relays a reply that says it is one to the agent, on stdout', async () => {
    replies['fallback'] = 'stack-reply:{"continue":true}';
    const r = await spawnBash([scriptPath, 'Stop'], { STACK_WORKSPACE_ID: 'w' }, '{}');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('{"continue":true}\n');
  });

  it.runIf(canRun)('prints nothing for any other response body', async () => {
    // The agent takes a hook's stdout as context or as a decision; an
    // unrelated process on a reused port must not get to write either.
    replies['fallback'] = '<html>hello</html>';
    const r = await spawnBash([scriptPath, 'Stop'], { STACK_WORKSPACE_ID: 'w' }, '{}');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
  });

  it.runIf(canRun)('ignores a worktree id that is not a plain token instead of using it as a path', async () => {
    fs.mkdirSync(path.join(storageDir, 'evil'), { recursive: true });
    fs.writeFileSync(path.join(storageDir, 'evil', 'x'), urls['other']!);
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: '../evil/x' }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(received.map((p) => p.server)).toEqual(['fallback']);
  });

  it.runIf(canRun)('falls back to HOOK_EVENT_NAME when invoked without an argument', async () => {
    // Claude Code exports it; we pass $1 ourselves, but a user who registered
    // the hook by hand — or an older install — gets here.
    const r = await run([], { HOOK_EVENT_NAME: 'PreToolUse', STACK_WORKSPACE_ID: 'w' });
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(received[0]?.headers['x-stack-event']).toBe('PreToolUse');
  });

  it.runIf(canRun)('drains and forwards a payload far larger than a pipe buffer', async () => {
    // The agent writes the whole event payload to our stdin. A pipe holds ~64KB
    // before the writer blocks, so a script that does not read it hangs the
    // agent — not the hook, the AGENT — until it is killed.
    const big = JSON.stringify({ tool_input: { content: 'x'.repeat(512 * 1024) } });
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'w' }, big);
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    // Every byte accepted — no EPIPE — which is what "drained" means and what
    // an agent blocking on the write would experience as a hang instead.
    expect(r.stdinError).toBeUndefined();
    expect(received[0]?.body).toBe(big);
  });

  it.runIf(canRun)('stays silent and quick when no Stack is listening anywhere', async () => {
    // After the last window closes the hook stays registered in the agent's
    // config and keeps being invoked. It has to be a no-op rather than an
    // error the user sees on every prompt — and must not slow the agent down.
    fs.rmSync(path.join(storageDir, 'hook-url'));
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'w' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    await waitForPosts(1, 300);
    expect(received).toHaveLength(0);
  });

  it.runIf(canRun)('stays silent when the url file is empty', async () => {
    fs.writeFileSync(path.join(storageDir, 'hook-url'), '');
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'w' });
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1, 300);
    expect(received).toHaveLength(0);
  });

  it.runIf(canRun)('succeeds when every endpoint is dead', async () => {
    const dead = await deadUrl();
    fs.writeFileSync(path.join(storageDir, 'hook-url'), dead);
    route('w', dead);
    const r = await run(['Stop'], { STACK_WORKSPACE_ID: 'w', STACK_HOOK_URL: dead });
    expect(r.status, r.stderr).toBe(0);
    expect(r.ms).toBeLessThan(2000);
  });

  it.runIf(canRun)('runs as the command written into the agent settings file', async () => {
    // Not `bash <path>` — the exact string the installer registered, evaluated
    // by a shell, which is how the agent invokes it. This is what the quoting
    // in commandFor() exists for, and storageDir has a space in it.
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, HookEntry[]>;
    };
    const command = settings.hooks['Stop']?.at(-1)?.hooks[0]?.command ?? '';
    expect(command).toContain('Application Support');

    const r = await spawnBash(['-c', command], { STACK_WORKSPACE_ID: 'w' }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(received[0]?.headers['x-stack-event']).toBe('Stop');
    expect(received[0]?.headers['x-stack-agent']).toBe('claude');
  });

  it.runIf(canRun && hasTmux)('asks tmux for the ids when the launcher did not set them', async () => {
    // The case that made hand-started agents invisible: an agent Stack did not
    // launch has no STACK_* in its environment, so every event it sent carried
    // an empty workspace id and was dropped on arrival. tmux knows, because the
    // hook runs inside the pane — and the id it yields picks the route.
    execSync(`tmux new-session -d -s "${TMUX_SESSION}" -c "${os.tmpdir()}"`);
    const pane = execSync(`tmux list-panes -t "${TMUX_SESSION}" -F '#{pane_id}'`, { encoding: 'utf8' })
      .trim().split('\n')[0];
    route(`notifyexec-${process.pid}`, urls['window']!);

    const r = await run(['Stop'], { TMUX_PANE: pane ?? '' });
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);

    // "stack-" stripped back off, which is the round-trip sessionName() relies on.
    expect(received[0]?.server).toBe('window');
    expect(received[0]?.headers['x-stack-workspace']).toBe(`notifyexec-${process.pid}`);
    expect(received[0]?.headers['x-stack-window']).toMatch(/^\d+$/);
    expect(received[0]?.headers['x-stack-pane']).toBe(pane);
  });

  it.runIf(canRun)('falls through a dead STACK_HOOK_URL to the shared file', async () => {
    const r = await run(['Stop'], { STACK_HOOK_URL: await deadUrl() }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(received.map((p) => p.server)).toEqual(['fallback']);
  });

  it.runIf(canRun && hasTmux)('recognises a session tab’s view session when asking tmux', async () => {
    const paneOf = (session: string) => {
      execSync(`tmux new-session -d -s "${session}" -c "${os.tmpdir()}"`);
      return execSync(`tmux list-panes -t "=${session}" -F '#{pane_id}'`, { encoding: 'utf8' }).trim().split('\n')[0] ?? '';
    };
    route(`notifyexec-${process.pid}`, urls['other']!);

    // stack-<id>__w<n>: the "__w5" is the tab's, not part of the worktree id.
    const r = await run(['Stop'], { TMUX_PANE: paneOf(`${TMUX_SESSION}__w5`) });
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(received[0]?.headers['x-stack-workspace']).toBe(`notifyexec-${process.pid}`);
    expect(received[0]?.server).toBe('other');
  });

  it.runIf(canRun)('does not invent ids when there is no tmux to ask', async () => {
    // No TMUX_PANE and no STACK_*: the event still goes out, unattributed,
    // to the shared endpoint. The server decides what to do with it (nothing).
    const r = await run(['Stop']);
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(received[0]?.server).toBe('fallback');
    expect(received[0]?.headers['x-stack-workspace']).toBeUndefined();
    expect(received[0]?.headers['x-stack-window']).toBeUndefined();
  });
});
