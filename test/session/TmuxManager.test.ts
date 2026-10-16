import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// ── exec interception ─────────────────────────────────────────────────────────
// The mock delegates to the REAL exec/execFile unless a test installs an
// override, so unit tests (command construction) and integration tests (real
// tmux) coexist. Both report an argv: exec's is its one shell string.
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecOpts = { env?: Record<string, string | undefined> } | undefined;
let execOverride: ((argv: string[], cb: ExecCb, opts: ExecOpts) => void) | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    // exec is called as (cmd, cb) or (cmd, options, cb) — normalize both shapes.
    exec: (cmd: string, optsOrCb: ExecOpts | ExecCb, maybeCb?: ExecCb) => {
      const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ExecCb;
      const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
      if (execOverride) { execOverride([cmd], cb, opts); return undefined; }
      return (real.exec as unknown as (c: string, o: ExecOpts, cb: ExecCb) => unknown)(cmd, opts, cb);
    },
    execFile: (file: string, args: string[], opts: ExecOpts, cb: ExecCb) => {
      if (execOverride) { execOverride([file, ...args], cb, opts); return undefined; }
      return (real.execFile as unknown as (f: string, a: string[], o: ExecOpts, cb: ExecCb) => unknown)(file, args, opts, cb);
    },
  };
});

import { execSync } from 'node:child_process'; // real (spread from original module)
import { TmuxManager, utf8LocaleFor } from '../../src/session/TmuxManager';

let hasTmux = false;
try { execSync('which tmux', { stdio: 'ignore' }); hasTmux = true; } catch { /* no tmux in CI */ }

afterEach(() => { execOverride = null; });

/** Options seen by the exec override, in call order (reset by captureExec). */
let execOptsSeen: ExecOpts[] = [];

/**
 * Installs an override that records each call's argv and replies with canned
 * results. `reply` sees the argv joined with spaces, for easy matching.
 */
function captureExec(reply: (cmd: string) => { err?: Error; stdout?: string } = () => ({})) {
  const calls: string[][] = [];
  execOptsSeen = [];
  execOverride = (argv, cb, opts) => {
    calls.push(argv);
    execOptsSeen.push(opts);
    const r = reply(argv.join(' '));
    cb(r.err ?? null, r.stdout ?? '', '');
  };
  return calls;
}

// ── sessionName (pure) ────────────────────────────────────────────────────────

describe('sessionName', () => {
  it('produces a valid tmux session name from a UUID', () => {
    expect(TmuxManager.sessionName('123e4567-e89b-12d3-a456-426614174000'))
      .toBe('foreman-123e4567-e89b-12d3-a456-426614174000');
  });

  it('is deterministic', () => {
    expect(TmuxManager.sessionName('some-id')).toBe(TmuxManager.sessionName('some-id'));
    expect(TmuxManager.sessionName('some-id')).toBe('foreman-some-id');
  });

  it('replaces invalid characters with dashes and collapses runs', () => {
    expect(TmuxManager.sessionName('repo/path worktree_1')).toBe('foreman-repo-path-worktree-1');
    expect(TmuxManager.sessionName('a//b..c')).toBe('foreman-a-b-c');
  });

  it('trims leading/trailing dashes', () => {
    expect(TmuxManager.sessionName('/x/')).toBe('foreman-x');
    expect(TmuxManager.sessionName('--x--')).toBe('foreman-x');
  });

  it('caps the id portion at 50 characters', () => {
    const name = TmuxManager.sessionName('a'.repeat(60));
    expect(name).toBe('foreman-' + 'a'.repeat(50));
    expect(name.length).toBe(58);
  });
});

// ── command construction (mocked exec) ───────────────────────────────────────

describe('command construction', () => {
  const tmux = new TmuxManager();

  it('isAvailable runs `which tmux` and maps success/error to boolean', async () => {
    let calls = captureExec(() => ({}));
    await expect(TmuxManager.isAvailable()).resolves.toBe(true);
    expect(calls).toEqual([['which tmux']]);
    calls = captureExec(() => ({ err: new Error('not found') }));
    await expect(TmuxManager.isAvailable()).resolves.toBe(false);
  });

  it('hasSession probes the session and maps success/error to boolean', async () => {
    let calls = captureExec(() => ({}));
    await expect(tmux.hasSession('s1')).resolves.toBe(true);
    expect(calls).toEqual([['tmux', 'has-session', '-t', 's1']]);
    calls = captureExec(() => ({ err: new Error('no session') }));
    await expect(tmux.hasSession('s1')).resolves.toBe(false);
  });

  const RENUMBER_OFF = ['tmux', 'set-option', '-t', 's1', 'renumber-windows', 'off'];

  it('ensureSession creates nothing when the session exists, but still pins renumber-windows off', async () => {
    const calls = captureExec(() => ({}));
    await tmux.ensureSession('s1', '/some/cwd');
    expect(calls).toEqual([['tmux', 'has-session', '-t', 's1'], RENUMBER_OFF]);
  });

  it('ensureSession creates a detached session with -c cwd when missing', async () => {
    const calls = captureExec(cmd => cmd.startsWith('tmux has-session') ? { err: new Error('nope') } : {});
    await tmux.ensureSession('s1', '/some/cwd');
    expect(calls).toEqual([
      ['tmux', 'has-session', '-t', 's1'],
      ['tmux', 'new-session', '-d', '-s', 's1', '-c', '/some/cwd'],
      RENUMBER_OFF,
    ]);
  });

  it('ensureSession accepts losing the creation race: "duplicate session" means it exists', async () => {
    // Two launches into one worktree both saw no session and both created it.
    let probes = 0;
    captureExec(cmd =>
      cmd.startsWith('tmux has-session') ? (probes++ === 0 ? { err: new Error('no session') } : {})
      : cmd.startsWith('tmux new-session') ? { err: new Error('duplicate session: s1') }
      : {});
    await expect(tmux.ensureSession('s1', '/some/cwd')).resolves.toBeUndefined();
  });

  it('ensureSession still fails when the session really could not be created', async () => {
    captureExec(cmd =>
      cmd.startsWith('tmux has-session') ? { err: new Error('no session') }
      : cmd.startsWith('tmux new-session') ? { err: new Error('no server running') }
      : {});
    await expect(tmux.ensureSession('s1', '/some/cwd')).rejects.toThrow('no server running');
  });

  it('ensureSession tolerates a tmux that rejects the renumber option', async () => {
    captureExec(cmd => (cmd.includes('renumber-windows') ? { err: new Error('unknown option') } : {}));
    await expect(tmux.ensureSession('s1', '/some/cwd')).resolves.toBeUndefined();
  });

  it('pins the new window name so tmux cannot rename it out from under us', async () => {
    // reconnect() decides a window holds an agent by matching its name against
    // the provider ids; left to its default tmux renames a window after the
    // running command, and every agent comes back as an unrecognised shell.
    // automatic-rename is a WINDOW option — setting it on the session does not
    // reliably reach windows created afterwards.
    const calls = captureExec(cmd => (cmd.includes('new-window') ? { stdout: '4' } : {}));
    await tmux.newWindow('s1', 'claude', '/cwd');
    expect(calls).toContainEqual(['tmux', 'set-window-option', '-t', 's1:4', 'automatic-rename', 'off']);
  });

  it('still returns the window index when tmux rejects the option', async () => {
    // An older tmux must not turn a naming quirk into a failed launch.
    const calls = captureExec(cmd =>
      cmd.includes('new-window') ? { stdout: '7' }
      : cmd.includes('automatic-rename') ? { err: new Error('unknown option') }
      : {});
    await expect(tmux.newWindow('s1', 'claude', '/cwd')).resolves.toBe(7);
    expect(calls.some(c => c.includes('new-window'))).toBe(true);
  });

  it('newWindow passes name/cwd and parses the printed window index (trimmed)', async () => {
    const calls = captureExec(() => ({ stdout: ' 3\n' }));
    await expect(tmux.newWindow('s1', 'claude', '/wt')).resolves.toBe(3);
    expect(calls).toEqual([
      ['tmux', 'new-window', '-t', 's1', '-n', 'claude', '-c', '/wt', '-P', '-F', '#{window_index}'],
      ['tmux', 'set-window-option', '-t', 's1:3', 'automatic-rename', 'off'],
    ]);
  });

  it('hands a path with $(...) in it to tmux as one inert argument — no shell sees it', async () => {
    // The worktree path carries the branch name, and adopted branches are not
    // validated: inside the old `-c "${cwd}"` this ran `touch x`.
    const calls = captureExec(cmd => (cmd.includes('new-window') ? { stdout: '1' } : cmd.includes('has-session') ? { err: new Error('no') } : {}));
    await tmux.ensureSession('s1', '/repo/$(touch x)`id`');
    await tmux.newWindow('s1', 'claude', '/repo/$(touch x)`id`');
    expect(calls).toContainEqual(['tmux', 'new-session', '-d', '-s', 's1', '-c', '/repo/$(touch x)`id`']);
    expect(calls).toContainEqual(['tmux', 'new-window', '-t', 's1', '-n', 'claude', '-c', '/repo/$(touch x)`id`', '-P', '-F', '#{window_index}']);
  });

  it('sendKeys passes the keys as one argument, quotes and all, then Enter', async () => {
    const calls = captureExec(() => ({}));
    await tmux.sendKeys('s1:2', "echo 'a'");
    expect(calls).toEqual([['tmux', 'send-keys', '-t', 's1:2', "echo 'a'", 'Enter']]);
  });

  it('respawnWindow kills the pane and hands tmux the command as one argument', async () => {
    const calls = captureExec(() => ({}));
    await tmux.respawnWindow('s1', 3, "claude; exec 'sh'");
    expect(calls).toEqual([['tmux', 'respawn-window', '-k', '-t', 's1:3', "claude; exec 'sh'"]]);
  });

  it('selectWindow targets session:index', async () => {
    const calls = captureExec(() => ({}));
    await tmux.selectWindow('s1', 4);
    expect(calls).toEqual([['tmux', 'select-window', '-t', 's1:4']]);
  });

  it('paste loads a temp-file buffer and bracketed-pastes it, leaving it unsent', async () => {
    // Submitting is AgentSessionManager's job now: an Enter sent the moment
    // paste-buffer returns lands while the agent is still taking the paste in.
    const calls = captureExec(() => ({}));
    await tmux.paste('s1:2', 'line one\nline two');
    expect(calls).toHaveLength(2);
    const [load, paste] = calls;
    expect(load.slice(0, 3)).toEqual(['tmux', 'load-buffer', '-b']);
    expect(load[3]).toMatch(/^foreman-paste-\d+-\d+-[0-9a-f]+$/);
    expect(load[4]).toMatch(/foreman-paste-[^/]+\/paste\.txt$/);
    expect(paste).toEqual(['tmux', 'paste-buffer', '-d', '-p', '-b', load[3], '-t', 's1:2']);
  });

  it('pressEnter sends a single Enter key to the target', async () => {
    const calls = captureExec(() => ({}));
    await tmux.pressEnter('s1:2');
    expect(calls).toEqual([['tmux', 'send-keys', '-t', 's1:2', 'Enter']]);
  });

  it('gives every paste its own buffer and file, so concurrent pastes cannot swap or delete each other\'s text', async () => {
    // Both used to be `foreman-paste-<pid>`: a launch's prompt and a review send
    // in flight together loaded into one buffer, and the agent of one received
    // the other's text.
    const loaded = new Map<string, string>(); // buffer name → file contents at load time
    const pasted: Array<{ buffer: string; target: string }> = [];
    captureExec((cmd) => {
      const load = cmd.match(/^tmux load-buffer -b (\S+) (\S+)$/);
      if (load) loaded.set(load[1], fs.readFileSync(load[2], 'utf8'));
      const paste = cmd.match(/^tmux paste-buffer -d -p -b (\S+) -t (\S+)$/);
      if (paste) pasted.push({ buffer: paste[1], target: paste[2] });
      return {};
    });
    await Promise.all([tmux.paste('s1:1', 'for agent one'), tmux.paste('s2:1', 'for agent two')]);

    expect(loaded.size).toBe(2);
    expect(pasted).toHaveLength(2);
    for (const { buffer, target } of pasted) {
      expect(loaded.get(buffer)).toBe(target === 's1:1' ? 'for agent one' : 'for agent two');
    }
  });

  it('removes its temp file, and drops the buffer when the paste itself fails', async () => {
    let file = '';
    const calls = captureExec((cmd) => {
      const load = cmd.match(/^tmux load-buffer -b \S+ (\S+)$/);
      if (load) file = load[1];
      return cmd.startsWith('tmux paste-buffer') ? { err: new Error("can't find pane") } : {};
    });
    await expect(tmux.paste('s1:9', 'x')).rejects.toThrow("can't find pane");
    expect(calls[2].slice(0, 3)).toEqual(['tmux', 'delete-buffer', '-b']);
    expect(calls[2][3]).toBe(calls[0][3]);
    expect(file).not.toBe('');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it('killSession swallows errors (session may not exist)', async () => {
    const calls = captureExec(() => ({ err: new Error('gone') }));
    await expect(tmux.killSession('s1')).resolves.toBeUndefined();
    expect(calls).toEqual([['tmux', 'kill-session', '-t', 's1']]);
  });

  it('detachClients detaches by session and swallows errors', async () => {
    let calls = captureExec(() => ({}));
    await tmux.detachClients('s1');
    expect(calls).toEqual([['tmux', 'detach-client', '-s', 's1']]);
    calls = captureExec(() => ({ err: new Error('no clients') }));
    await expect(tmux.detachClients('s1')).resolves.toBeUndefined();
  });

  it('killWindow targets session:index and swallows errors', async () => {
    const calls = captureExec(() => ({ err: new Error('gone') }));
    await expect(tmux.killWindow('s1', 2)).resolves.toBeUndefined();
    expect(calls).toEqual([['tmux', 'kill-window', '-t', 's1:2']]);
  });

  it('listWindows parses separator-delimited index/name/title/command lines, keeping spaces in names and titles', async () => {
    const calls = captureExec(() => ({
      stdout:
        '0|:foreman:|zsh|:foreman:|my-host.local|:foreman:|zsh|:foreman:|100\n' +
        '1|:foreman:|claude|:foreman:|⠂ Fix login flow bug|:foreman:|node|:foreman:|200\n' +
        '2|:foreman:|my window name|:foreman:||:foreman:|npm|:foreman:|300\n',
    }));
    await expect(tmux.listWindows('s1')).resolves.toEqual([
      { index: 0, name: 'zsh', title: 'my-host.local', command: 'zsh', pid: 100 },
      { index: 1, name: 'claude', title: '⠂ Fix login flow bug', command: 'node', pid: 200 },
      { index: 2, name: 'my window name', title: '', command: 'npm', pid: 300 },
    ]);
    expect(calls).toEqual([[
      'tmux', 'list-windows', '-t', 's1',
      '-F', '#{window_index}|:foreman:|#{window_name}|:foreman:|#{pane_title}|:foreman:|#{pane_current_command}|:foreman:|#{pane_pid}',
    ]]);
  });

  it('run() forces a UTF-8 locale — the extension host has no LANG, and C-locale tmux mangles non-ASCII titles to "_"', async () => {
    captureExec(() => ({}));
    await tmux.hasSession('s1');
    expect(execOptsSeen).toHaveLength(1);
    // Platform-dependent on purpose: en_US.UTF-8 is the macOS one and is often
    // NOT generated on Linux, where setting LC_ALL to a missing locale leaves
    // the process in C — the exact state this exists to avoid. glibc has C.UTF-8.
    const expected = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
    expect(execOptsSeen[0]?.env?.LC_ALL).toBe(expected);
    expect(execOptsSeen[0]?.env?.LANG).toBe(expected);
  });

  it('listWindows tolerates lines missing name/title fields', async () => {
    captureExec(() => ({ stdout: '3\n' }));
    await expect(tmux.listWindows('s1')).resolves.toEqual([{ index: 3, name: '', title: '', command: '' }]);
  });

  it('hasChildProcess asks pgrep for the pid\'s children and reads its exit status', async () => {
    let calls = captureExec(() => ({ stdout: '4243\n' }));
    await expect(tmux.hasChildProcess(4242)).resolves.toBe(true);
    expect(calls).toEqual([['pgrep', '-P', '4242']]);
    // pgrep exits 1 (an error to exec) when there is nothing to list.
    calls = captureExec(() => ({ err: new Error('exit 1') }));
    await expect(tmux.hasChildProcess(4242)).resolves.toBe(false);
    captureExec(() => ({ stdout: '\n' }));
    await expect(tmux.hasChildProcess(4242)).resolves.toBe(false);
  });

  it('processCommandLine reads the full, untruncated command line of a pid', async () => {
    const calls = captureExec(() => ({ stdout: 'zsh -c FOREMAN_WINDOW_INDEX="1" claude; exec zsh\n' }));
    await expect(tmux.processCommandLine(4242)).resolves.toBe('zsh -c FOREMAN_WINDOW_INDEX="1" claude; exec zsh');
    expect(calls).toEqual([['ps', '-ww', '-o', 'args=', '-p', '4242']]);
    captureExec(() => ({ err: new Error('exit 1') }));
    await expect(tmux.processCommandLine(4242)).rejects.toThrow();
  });

  it('listWindows returns [] on error or empty output', async () => {
    captureExec(() => ({ err: new Error('no session') }));
    await expect(tmux.listWindows('s1')).resolves.toEqual([]);
    captureExec(() => ({ stdout: '' }));
    await expect(tmux.listWindows('s1')).resolves.toEqual([]);
  });
});

// ── integration (real tmux, guarded) ─────────────────────────────────────────

describe('TmuxManager (integration)', () => {
  const SES = `foreman-test-${process.pid}`;
  const tmux = new TmuxManager();

  afterAll(() => {
    if (!hasTmux) return;
    try { execSync(`tmux kill-session -t "${SES}"`, { stdio: 'ignore' }); } catch { /* already gone */ }
  });

  it.runIf(hasTmux)('isAvailable resolves true when tmux is installed', async () => {
    await expect(TmuxManager.isAvailable()).resolves.toBe(true);
  });

  it.runIf(hasTmux)('ensureSession creates a new session (idempotently)', async () => {
    expect(await tmux.hasSession(SES)).toBe(false);
    await tmux.ensureSession(SES, os.tmpdir());
    expect(await tmux.hasSession(SES)).toBe(true);
    await tmux.ensureSession(SES, os.tmpdir()); // second call must not throw
    expect(await tmux.hasSession(SES)).toBe(true);
    expect(execSync(`tmux show-options -t "${SES}" -v renumber-windows`).toString().trim()).toBe('off');
  });

  it.runIf(hasTmux)('newWindow/listWindows/selectWindow/killWindow round-trip', async () => {
    const idx = await tmux.newWindow(SES, 'testwin', os.tmpdir());
    expect(Number.isInteger(idx)).toBe(true);
    const windows = await tmux.listWindows(SES);
    // Spell out what tmux actually returned. This assertion failed on the Linux
    // runners for weeks while passing locally, and a bare `false` said nothing
    // about which half was wrong: a mangled separator (every field junk) reads
    // identically to a renamed window.
    const detail = `idx=${idx} windows=${JSON.stringify(windows)}`;
    const found = windows.find(w => w.index === idx);
    expect(found, detail).toBeDefined();
    expect(found?.name, detail).toBe('testwin');
    await tmux.selectWindow(SES, idx);
    await tmux.sendKeys(`${SES}:${idx}`, "echo 'hi'");
    await tmux.killWindow(SES, idx);
    const after = await tmux.listWindows(SES);
    expect(after.some(w => w.index === idx)).toBe(false);
  });

  it.runIf(hasTmux)('listWindows reports what a window is actually running', async () => {
    // The whole point of the shell label: idle reports the shell itself (which
    // the UI drops), busy reports the command.
    const idx = await tmux.newWindow(SES, 'cmdwin', os.tmpdir());

    /** Polls until `want` matches, rather than sleeping a guessed interval. */
    const settle = async (want: (c: string) => boolean): Promise<string> => {
      for (let i = 0; i < 40; i++) {
        const w = (await tmux.listWindows(SES)).find(x => x.index === idx);
        if (w && want(w.command ?? '')) return w.command ?? '';
        await new Promise(r => setTimeout(r, 100));
      }
      const w = (await tmux.listWindows(SES)).find(x => x.index === idx);
      return w?.command ?? '<gone>';
    };

    // A shell takes a moment to exec; send-keys before then is swallowed, which
    // is why this waits for the shell rather than assuming it is up.
    expect(await settle(c => /sh$/.test(c))).toMatch(/sh$/); // zsh / bash / sh

    await tmux.sendKeys(`${SES}:${idx}`, 'sleep 30');
    expect(await settle(c => c === 'sleep')).toBe('sleep');

    await tmux.killWindow(SES, idx);
  });

  it.runIf(hasTmux)('the pane process runs `<shell> -c` while the launched command lives, and a bare shell after', async () => {
    // What AgentSessionManager's liveness check rests on: the launch line ends
    // in `exec $SHELL`, which replaces the wrapper under the same pid.
    const idx = await tmux.newWindow(SES, 'livewin', os.tmpdir());
    await tmux.respawnWindow(SES, idx, 'sleep 1; exec /bin/sh');
    const pid = async () => (await tmux.listWindows(SES)).find((w) => w.index === idx)?.pid;
    const args = async () => { const p = await pid(); return p === undefined ? '<gone>' : tmux.processCommandLine(p).catch(() => '<gone>'); };

    expect(await args()).toMatch(/(^|\s)-c\s/);
    let after = '';
    for (let i = 0; i < 40; i++) {
      after = await args();
      if (!/(^|\s)-c\s/.test(after)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(after).toMatch(/(^|\/)sh$/);

    await tmux.killWindow(SES, idx);
  });

  it.runIf(hasTmux)('opens a window in a directory named `$(touch …)` without running it', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-inject-'));
    const marker = path.join(base, 'ran');
    // No slash inside the substitution, so this is one directory name; the
    // env var points the would-be command at a file we can look for.
    const dir = path.join(base, '$(touch "$FOREMAN_INJECT_MARKER")');
    fs.mkdirSync(dir);
    process.env.FOREMAN_INJECT_MARKER = marker;
    try {
      const idx = await tmux.newWindow(SES, 'injwin', dir);
      expect((await tmux.listWindows(SES)).some((w) => w.index === idx)).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      await tmux.killWindow(SES, idx);
    } finally {
      delete process.env.FOREMAN_INJECT_MARKER;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.runIf(hasTmux)('two launches creating the same session at once both succeed', async () => {
    const name = `foreman-race-${process.pid}`;
    try {
      await Promise.all([tmux.ensureSession(name, os.tmpdir()), tmux.ensureSession(name, os.tmpdir())]);
      expect(await tmux.hasSession(name)).toBe(true);
    } finally {
      await tmux.killSession(name);
    }
  });

  it.runIf(hasTmux)('detachClients succeeds with no clients attached', async () => {
    await expect(tmux.detachClients(SES)).resolves.toBeUndefined();
  });

  it.runIf(hasTmux)('killSession removes the session', async () => {
    await tmux.killSession(SES);
    expect(await tmux.hasSession(SES)).toBe(false);
    await expect(tmux.killSession(SES)).resolves.toBeUndefined(); // idempotent
    expect(await tmux.listWindows(SES)).toEqual([]);
  });
});

describe('utf8LocaleFor', () => {
  it('uses the macOS locale on darwin', () => {
    expect(utf8LocaleFor('darwin')).toBe('en_US.UTF-8');
  });

  it('uses C.UTF-8 everywhere else — en_US.UTF-8 is often not generated on Linux', () => {
    // Setting LC_ALL to a locale the system lacks leaves the process in C, and
    // C-locale tmux replaces non-ASCII bytes with '_'.
    expect(utf8LocaleFor('linux')).toBe('C.UTF-8');
    expect(utf8LocaleFor('win32')).toBe('C.UTF-8');
  });
});
