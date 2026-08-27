import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { AddressInfo } from 'node:net';
import { JsonHookInstaller } from '../../../src/providers/shared/JsonHookInstaller';
import { HookEntry } from '../../../src/types';

/**
 * Runs notify.sh for real.
 *
 * Every other test of this script asserts on its *source text* — that it
 * contains a curl, that the JSON body mentions the right fields. None of them
 * has ever executed a line of it, so the 58 lines of bash standing between an
 * agent and the sidebar were the least-tested code in the project while being
 * the only part that runs on the user's machine outside our control. A quoting
 * mistake, an unset variable, a `cat` that blocks: all of it shipped unverified.
 *
 * So: a real HTTP server, a real bash, and the request body checked on arrival.
 */

let hasBash = false;
let hasCurl = false;
let hasTmux = false;
try { execSync('command -v bash', { stdio: 'ignore' }); hasBash = true; } catch { /* no bash */ }
try { execSync('command -v curl', { stdio: 'ignore' }); hasCurl = true; } catch { /* no curl */ }
try { execSync('command -v tmux', { stdio: 'ignore' }); hasTmux = true; } catch { /* no tmux */ }

/** The script only ever posts; without curl it is a no-op by design. */
const canRun = hasBash && hasCurl;

type Posted = { url: string; body: string };

describe('notify.sh (executed)', () => {
  let server: http.Server;
  let hookUrl: string;
  let received: Posted[] = [];

  let tmpDir: string;
  let storageDir: string;
  let settingsPath: string;
  let scriptPath: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url ?? '', body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (hasTmux) {
      try { execSync(`tmux kill-session -t "${TMUX_SESSION}"`, { stdio: 'ignore' }); } catch { /* gone */ }
    }
  });

  const TMUX_SESSION = `unmess-notifyexec-${process.pid}`;

  beforeEach(() => {
    received = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmess-notifyexec-'));
    // A directory with a space in it, because the real one is
    // "~/Library/Application Support/Code/User/globalStorage/..." on macOS and
    // an unquoted path there is the classic way this breaks for one platform.
    storageDir = path.join(tmpDir, 'Application Support', 'storage');
    settingsPath = path.join(tmpDir, 'agent', 'settings.json');
    scriptPath = path.join(storageDir, 'notify.sh');
    new JsonHookInstaller(storageDir, settingsPath, ['Stop']).install(hookUrl);
  });

  /** Waits for the server to have logged `n` posts — curl returns before we parse. */
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
   * server above cannot answer the request the script is making — curl waits
   * for a reply that only arrives once the process it is blocking has exited.
   * The first version of this file deadlocked exactly that way and the posts
   * surfaced in whichever test ran after the kill.
   */
  const spawnBash = (
    argv: string[],
    env: Record<string, string>,
    input: string,
  ): Promise<{ status: number | null; stderr: string; stdinError?: string }> =>
    new Promise((resolve) => {
      const child = spawn('bash', argv, {
        // Deliberately NOT process.env: this suite runs inside a terminal that
        // may well be a tmux pane with UNMESS_* exported, which would mask
        // exactly the fallbacks under test.
        env: { PATH: process.env['PATH'] ?? '', HOME: os.tmpdir(), ...env },
      });
      let stderr = '';
      let stdinError: string | undefined;
      child.stderr.on('data', (c) => { stderr += c; });
      child.stdout.resume();
      // Recorded rather than swallowed: whether the script read our stdin to the
      // end is the assertion, not an incidental detail. A script that exits
      // without reading leaves this write half-done and we get EPIPE.
      child.stdin.on('error', (e: Error) => { stdinError = e.message; });
      child.stdin.end(input);
      child.on('close', (status) => resolve({ status, stderr, stdinError }));
    });

  /** Runs the script directly, with a clean environment plus `env`. */
  const run = (args: string[], env: Record<string, string> = {}, input = '') =>
    spawnBash([scriptPath, ...args], env, input);

  it.runIf(canRun)('posts the ids it was handed, to the url in the sibling file', async () => {
    const r = await run(['Stop'], {
      UNMESS_TERMINAL_ID: 'term-7',
      UNMESS_WORKSPACE_ID: 'wt-abc',
      UNMESS_WINDOW_INDEX: '3',
    });
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);

    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe('/hook');
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual({
      event: 'Stop',
      terminalId: 'term-7',
      workspaceId: 'wt-abc',
      windowIndex: '3',
    });
  });

  it.runIf(canRun)('falls back to HOOK_EVENT_NAME when invoked without an argument', async () => {
    // Claude Code exports it; we pass $1 ourselves, but a user who registered
    // the hook by hand — or an older install — gets here.
    const r = await run([], { HOOK_EVENT_NAME: 'PreToolUse', UNMESS_WORKSPACE_ID: 'w' });
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(JSON.parse(received[0]?.body ?? '{}').event).toBe('PreToolUse');
  });

  it.runIf(canRun)('drains a payload far larger than a pipe buffer', async () => {
    // The agent writes the whole event payload to our stdin. A pipe holds ~64KB
    // before the writer blocks, so a script that does not read it hangs the
    // agent — not the hook, the AGENT — until it is killed. `PAYLOAD=$(cat)`
    // is the line that prevents it, and this is the only thing that proves it.
    const big = 'x'.repeat(512 * 1024);
    const r = await run(['Stop'], { UNMESS_WORKSPACE_ID: 'w' }, JSON.stringify({ transcript: big }));
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    // Every byte accepted — no EPIPE — which is what "drained" means and what
    // an agent blocking on the write would experience as a hang instead.
    expect(r.stdinError).toBeUndefined();
    // Drained, not forwarded: the body stays the four small fields.
    expect(received[0]?.body.length).toBeLessThan(200);
  });

  it.runIf(canRun)('stays silent when the url file is missing', async () => {
    fs.rmSync(path.join(storageDir, 'hook-url'));
    const r = await run(['Stop'], { UNMESS_WORKSPACE_ID: 'w' });
    // Exit 0 and no request: after the extension shuts down, the hook stays
    // registered in the agent's config and keeps being invoked. It has to be a
    // no-op rather than an error the user sees on every prompt.
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1, 300);
    expect(received).toHaveLength(0);
  });

  it.runIf(canRun)('stays silent when the url file is empty', async () => {
    fs.writeFileSync(path.join(storageDir, 'hook-url'), '');
    const r = await run(['Stop'], { UNMESS_WORKSPACE_ID: 'w' });
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1, 300);
    expect(received).toHaveLength(0);
  });

  it.runIf(canRun)('succeeds when nothing is listening on the endpoint', async () => {
    // The server is up but this port is not it. curl fails; the agent must not.
    fs.writeFileSync(path.join(storageDir, 'hook-url'), 'http://127.0.0.1:1');
    const r = await run(['Stop'], { UNMESS_WORKSPACE_ID: 'w' });
    expect(r.status, r.stderr).toBe(0);
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

    const r = await spawnBash(['-c', command], { UNMESS_WORKSPACE_ID: 'w' }, '{}');
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(JSON.parse(received[0]?.body ?? '{}').event).toBe('Stop');
  });

  it.runIf(canRun && hasTmux)('asks tmux for the ids when the launcher did not set them', async () => {
    // The case that made hand-started agents invisible: an agent Unmess did not
    // launch has no UNMESS_* in its environment, so every event it sent carried
    // an empty workspace id and was dropped on arrival. tmux knows, because the
    // hook runs inside the pane.
    execSync(`tmux new-session -d -s "${TMUX_SESSION}" -c "${os.tmpdir()}"`);
    const pane = execSync(`tmux list-panes -t "${TMUX_SESSION}" -F '#{pane_id}'`, { encoding: 'utf8' })
      .trim().split('\n')[0];

    const r = await run(['Stop'], { TMUX_PANE: pane ?? '' });
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);

    const body = JSON.parse(received[0]?.body ?? '{}');
    // "unmess-" stripped back off, which is the round-trip sessionName() relies on.
    expect(body.workspaceId).toBe(`notifyexec-${process.pid}`);
    expect(body.windowIndex).toMatch(/^\d+$/);
  });

  it.runIf(canRun)('does not invent ids when there is no tmux to ask', async () => {
    // No TMUX_PANE and no UNMESS_*: the fields go out empty rather than the
    // script failing. The server decides what to do with an unattributed event.
    const r = await run(['Stop']);
    expect(r.status, r.stderr).toBe(0);
    await waitForPosts(1);
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual({
      event: 'Stop',
      terminalId: '',
      workspaceId: '',
      windowIndex: '',
    });
  });
});
