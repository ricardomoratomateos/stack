import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { socketPathFor } from '../../src/daemon/api';
import { DaemonClient } from '../../src/daemon/client/DaemonClient';
import { daemonRunning, ensureDaemon, spawnDaemon } from '../../src/daemon/client/launch';
import type { Snapshot } from '../../src/daemon/StackDaemon';
import { removeTmuxServer } from '../helpers/tmuxSocket';

const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const script = path.resolve(__dirname, '../../dist/stackd.js');
const built = fs.existsSync(script);

const TMUX = `stackd-client-${process.pid}`;
const until = async (check: () => Promise<boolean> | boolean, ms = 15000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** What the extension does at activation, against the built daemon in a sandbox (own config dir, tmux server and home). */
describe.skipIf(!hasTmux || !built)('the extension as a stackd client (built dist/stackd.js, sandboxed)', () => {
  let root: string;
  let repo: string;
  let configDir: string;
  let sock: string;
  let pid: number | undefined;
  const pids: number[] = [];
  let client: DaemonClient;
  const start = () => {
    pid = spawnDaemon({
      node: process.execPath, script, configDir,
      env: { STACKD_CONFIG_DIR: configDir, STACKD_TMUX_SOCKET: TMUX, STACKD_HOME: path.join(root, 'home'), ELECTRON_RUN_AS_NODE: '' },
    });
    if (pid) pids.push(pid);
  };

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdc-')));
    repo = path.join(root, 'repo');
    configDir = path.join(root, 'cfg');
    sock = socketPathFor(configDir);
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(root, 'home'));
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
    git('init', '-b', 'main');
    git('commit', '--allow-empty', '-m', 'init');
  });

  afterAll(() => {
    client?.dispose();
    for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    removeTmuxServer(TMUX);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts the daemon once, detached, and reuses it', async () => {
    expect(await ensureDaemon({ socketPath: sock, start })).toBe(true);
    expect(await ensureDaemon({ socketPath: sock, start: () => { throw new Error('must not start another'); } })).toBe(false);
    expect(pid && alive(pid)).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'stackd.log'))).toBe(true);
  }, 30000);

  it('does not read any state until the extension hands its own over, and then never again', async () => {
    const stateFile = path.join(configDir, 'state.json');
    expect(fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8') || '{}')['stackd.imported'] : undefined).toBeUndefined();
    client = new DaemonClient({ socketPath: sock, retryMs: 200, revive: () => ensureDaemon({ socketPath: sock, start }).then(() => undefined) });
    const r = await client.command<{ copied: number }>('importState', {
      global: { 'stack.mine': 1, 'other': 2 }, workspace: { 'stack.sel': 'x', nope: 1 }, repo,
    });
    expect(r.copied).toBe(2);
    const file = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(file['stack.mine']).toBe(1);
    expect(file['other']).toBeUndefined();
    expect(file[`repo:${fs.realpathSync(repo)}:stack.sel`]).toBe('x');
    expect(file['stackd.imported']).toBe(true);
    // Never overwrites, once.
    expect((await client.command<{ copied: number }>('importState', { global: { 'stack.mine': 9, 'stack.new': 1 }, repo })).copied).toBe(0);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))['stack.mine']).toBe(1);
  });

  it('follows the stream and runs a task through the commands the extension uses', async () => {
    // The VS Code settings the user made, as pushed. A script that ignores the agent's flags and just echoes stands in for it.
    const fake = path.join(root, 'agent.sh');
    fs.writeFileSync(fake, '#!/bin/sh\nexec cat\n', { mode: 0o755 });
    await client.command('setSettings', { values: { claudeCommand: fake, notifyOnAttention: false } });
    const first = await client.start();
    expect(client.connected).toBe(true);
    expect(first.tmux.socket).toBe(TMUX);
    const state = () => client.snapshot!.repos.find((r) => r.repoRoot === repo)?.state;

    await client.command('addRepo', { repo });
    await until(() => state()?.worktrees.some((w) => w.branch === 'main') === true);

    const { worktree } = await client.command<{ worktree: { id: string; path: string } }>('createTask', { repo, branch: 'feat-c', title: 'C' });
    const id = worktree.id;
    await until(() => state()?.worktrees.find((w) => w.id === id)?.sessions.some((s) => s.kind === 'agent') === true);
    const agent = state()!.worktrees.find((w) => w.id === id)!.sessions.find((s) => s.kind === 'agent')!;

    // The agent line has been typed and `cat` is in front.
    await until(() => execFileSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' }).includes(`STACK_WORKSPACE_ID="${id}" ${fake}`));
    await new Promise((r) => setTimeout(r, 300));
    await client.command('renameTask', { worktreeId: id, alias: 'Renamed' });
    await until(() => state()?.worktrees.find((w) => w.id === id)?.alias === 'Renamed');
    await client.command('renameSession', { worktreeId: id, windowIndex: agent.index, name: 'main agent' });
    await until(() => state()?.worktrees.find((w) => w.id === id)?.sessions.find((s) => s.index === agent.index)?.alias === 'main agent');

    // Review panel: the diff, and comments typed into the live agent.
    fs.writeFileSync(path.join(worktree.path, 'new.txt'), 'hello\n');
    execFileSync('git', ['add', '-N', 'new.txt'], { cwd: worktree.path });
    expect((await client.command<{ unified: string }>('getDiff', { worktreeId: id, base: 'working' })).unified).toContain('new.txt');
    const sent = await client.command<{ went: string | false }>('sendComments', {
      worktreeId: id, destination: 'live', comments: [{ file: 'new.txt', side: 'new', line: 1, body: 'zzcomment' }],
    });
    expect(sent.went).toBe('live');
    await until(async () => execFileSync('tmux', ['-L', TMUX, 'capture-pane', '-p', '-t', `=stack-${id}:${agent.index}`], { encoding: 'utf8' }).includes('zzcomment'));

    // A paste (an image dropped on the terminal) lands unsent in the pane.
    await client.command('paste', { worktreeId: id, text: "'/tmp/shot.png' ", windowIndex: agent.index });
    await until(async () => execFileSync('tmux', ['-L', TMUX, 'capture-pane', '-p', '-t', `=stack-${id}:${agent.index}`], { encoding: 'utf8' }).includes('shot.png'));

    // The sidebar's messages the daemon runs itself; others are refused.
    await client.command('message', { message: { type: 'reorderSessions', worktreeId: id, orderedIndexes: [agent.index] } });
    await expect(client.command('message', { message: { type: 'openTerminal', worktreeId: id } })).rejects.toThrow(/Not a daemon message/);

    // The new-task panel's branch list.
    const init = await client.command<{ branches: string[]; baseBranch: string }>('newTaskInit', { repo });
    expect(init.branches).toContain('main');

    await client.command('deleteTask', { worktreeId: id, deleteBranch: true });
    await until(() => state()?.worktrees.some((w) => w.id === id) === false);
  }, 90000);

  it('reconnects when the daemon goes away and is started again, keeping its state', async () => {
    const downs: boolean[] = [];
    client.onConnection((up) => downs.push(up));
    process.kill(pid!, 'SIGTERM');
    await until(() => !alive(pid!), 10000);
    await until(() => downs.includes(false));
    expect(await daemonRunning(sock)).toBe(false);
    // `revive` starts it again; the stream comes back on its own, with the repo still managed.
    await until(() => client.connected, 30000);
    await until(() => client.snapshot?.repos.some((r) => r.repoRoot === repo) === true, 30000);
  }, 90000);
});
