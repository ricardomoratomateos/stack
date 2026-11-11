import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { StackDaemon, type Snapshot } from '../../src/daemon/StackDaemon';
import { ApiServer, callDaemon, socketPathFor } from '../../src/daemon/api';
import { removeTmuxServer } from '../helpers/tmuxSocket';

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

const SOCKET = `stackd-test-${process.pid}`;
const tmuxOut = (...args: string[]) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
const until = async (check: () => Promise<boolean> | boolean, ms = 10000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

/** One hook, as notify.sh would send it, straight at the daemon's hook server. */
function hook(url: string, event: string, workspace: string, window: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url}/hook`, {
      method: 'POST',
      headers: { 'X-Stack-Hook': '1', 'X-Stack-Event': event, 'X-Stack-Workspace': workspace, 'X-Stack-Window': String(window), 'X-Stack-Agent': 'claude' },
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end('{}');
  });
}

describe.skipIf(!hasTmux)('stackd serve (real tmux on an isolated socket)', () => {
  let root: string;
  let repo: string;
  let configDir: string;
  let daemon: StackDaemon;
  let api: ApiServer;
  let sock: string;
  const call = <T = unknown>(method: 'GET' | 'POST', route: string, body?: unknown) => callDaemon<T>(sock, method, route, body);
  const cmd = <T = unknown>(name: string, body: unknown) => call<T>('POST', `/commands/${name}`, body);
  const state = async () => (await call<Snapshot>('GET', '/state')).repos[0].state;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-')));
    repo = path.join(root, 'repo');
    configDir = path.join(root, 'cfg');
    fs.mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
    git('init', '-b', 'main');
    git('commit', '--allow-empty', '-m', 'init');
    fs.mkdirSync(configDir, { recursive: true });
    // `cat` stands in for the agent: it just sits in the pane, echoing what is typed.
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ claudeCommand: 'cat', notifyOnAttention: false }));
    daemon = new StackDaemon({
      configDir,
      home: path.join(root, 'home'),
      tmuxSocket: SOCKET,
      installHooks: false,
      importState: () => Promise.resolve({ 'stack.imported-marker': 42, other: 1 }),
      notify: () => {},
    });
    sock = socketPathFor(configDir);
    api = new ApiServer(daemon, sock);
    await api.start();
    await daemon.start();
  }, 30000);

  afterAll(async () => {
    await api?.stop();
    await daemon?.stop();
    removeTmuxServer(SOCKET);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('imports the extension state once, into state.json', () => {
    const file = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
    expect(file['stack.imported-marker']).toBe(42);
    expect(file['other']).toBeUndefined();
    expect(file['stackd.imported']).toBe(true);
  });

  it('refuses a second daemon on the same socket', async () => {
    await expect(new ApiServer(daemon, sock).start()).rejects.toThrow(/already running/);
  });

  it('manages a repo and runs a task through its whole life', async () => {
    await cmd('addRepo', { repo });
    let s = await state();
    expect(s.worktrees.map((w) => w.branch)).toEqual(['main']);
    expect(s.controlSession?.sessions.some((x) => x.kind === 'agent')).toBe(true);

    const { worktree } = await cmd<{ worktree: { id: string; branch: string; path: string } }>('createTask', { repo, branch: 'feat-x', title: 'Feature X' });
    expect(fs.existsSync(worktree.path)).toBe(true);
    await until(async () => (await state()).worktrees.find((w) => w.id === worktree.id)?.sessions.some((x) => x.kind === 'agent') === true);
    const id = worktree.id;
    expect(tmuxOut('list-sessions', '-F', '#{session_name}')).toContain(`stack-${id}`);
    const agent = (await state()).worktrees.find((w) => w.id === id)!.sessions.find((x) => x.kind === 'agent')!;

    // spawnShell / killWindow
    const { windowIndex: shell } = await cmd<{ windowIndex: number }>('spawnShell', { worktreeId: id });
    expect(typeof shell).toBe('number');
    expect((await state()).worktrees.find((w) => w.id === id)!.sessions.some((x) => x.index === shell)).toBe(true);
    await cmd('killWindow', { worktreeId: id, windowIndex: shell });
    expect((await state()).worktrees.find((w) => w.id === id)!.sessions.some((x) => x.index === shell)).toBe(false);

    // A hook from the agent reaches the daemon and moves the state, which the event stream reports.
    const events: Snapshot[] = [];
    const sse = http.request({ socketPath: sock, path: '/events' }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c: string) => {
        buf += c;
        for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
          const m = /^event: state\ndata: (.*)$/m.exec(buf.slice(0, i));
          if (m) events.push(JSON.parse(m[1]) as Snapshot);
          buf = buf.slice(i + 2);
        }
      });
    });
    sse.end();
    await until(() => events.length >= 1);
    const hooksUrl = `http://127.0.0.1:${daemon.hooks.listeningPort}`;
    expect(await hook(hooksUrl, 'PermissionRequest', id, agent.index)).toBe(200);
    await until(() => events.some((e) => e.repos[0].state.worktrees.find((w) => w.id === id)?.agent === 'permission'));
    expect((await state()).worktrees.find((w) => w.id === id)!.agent).toBe('permission');
    sse.destroy();

    // respondPermission sends keys to the pane (cat echoes them).
    await cmd('respondPermission', { worktreeId: id, windowIndex: agent.index, keys: ['q', 'w'] });
    await until(async () => (await daemon.agents.capturePane(id, agent.index, 10)).includes('qw'));
    await expect(cmd('respondPermission', { worktreeId: id, windowIndex: agent.index })).rejects.toThrow(/answer/);

    // attachTarget
    const target = await cmd<{ socket: string; session: string; command: string[] }>('attachTarget', { worktreeId: id, windowIndex: agent.index });
    expect(target.session).toBe(`stack-${id}`);
    expect(target.command).toEqual(['tmux', '-L', SOCKET, 'attach', '-t', `=stack-${id}`]);

    // deleteTask tears down the session and the worktree.
    await cmd('deleteTask', { worktreeId: id });
    s = await state();
    expect(s.worktrees.some((w) => w.id === id)).toBe(false);
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(tmuxOut('list-sessions', '-F', '#{session_name}')).not.toContain(`stack-${id}`);
  }, 60000);

  it('answers errors as errors', async () => {
    await expect(cmd('nope', {})).rejects.toThrow(/Unknown command/);
    await expect(cmd('killWindow', { worktreeId: 'ghost', windowIndex: 0 })).rejects.toThrow(/No worktree/);
    await expect(call('GET', '/nowhere')).rejects.toThrow(/Not found/);
  });

  it('routes the manager MCP tools through the same API as the agents', async () => {
    const res = await new Promise<{ ok: boolean; result?: { repo?: string } }>((resolve, reject) => {
      const body = JSON.stringify({ args: { repo }, context: {} });
      const req = http.request(`http://127.0.0.1:${daemon.hooks.listeningPort}/api/stack_status`, {
        method: 'POST', headers: { Authorization: `Bearer ${daemon.registry.token}`, 'Content-Type': 'application/json' },
      }, (r) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString()))); });
      req.on('error', reject);
      req.end(body);
    });
    expect(res.ok).toBe(true);
    expect(res.result?.repo).toBe(repo);
    // And the bridge finds the daemon through the discovery file in the config dir.
    expect(fs.readdirSync(path.join(configDir, 'windows'))).toContain(`${process.pid}.json`);
  });
});

describe('stackd state import', () => {
  it('does not import twice, and never overwrites', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
    try {
      const mk = (seed: Record<string, unknown>) => new StackDaemon({ configDir: dir, installHooks: false, importState: () => Promise.resolve(seed), notify: () => {} });
      const a = mk({ 'stack.k': 1 });
      await a.start();
      await a.stop();
      const b = mk({ 'stack.k': 2, 'stack.j': 3 });
      await b.start();
      await b.stop();
      const file = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      expect(file['stack.k']).toBe(1);
      expect(file['stack.j']).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stackd hooks', () => {
  it('installs the agents\' hooks under the given home and points the default route at itself', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    const daemon = new StackDaemon({ configDir: path.join(dir, 'cfg'), home, installHooks: true, importState: () => Promise.resolve({}), notify: () => {} });
    try {
      await daemon.start();
      const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
      expect(settings).toContain(path.join(dir, 'cfg'));
      expect(fs.readFileSync(path.join(dir, 'cfg', 'hook-url'), 'utf8')).toBe(`http://127.0.0.1:${daemon.hooks.listeningPort}`);
    } finally {
      await daemon.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
