import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import os from 'node:os';

// ── exec interception ─────────────────────────────────────────────────────────
// The mock delegates to the REAL exec unless a test installs an override, so
// unit tests (command construction) and integration tests (real tmux) coexist.
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecOpts = { env?: Record<string, string | undefined> } | undefined;
let execOverride: ((cmd: string, cb: ExecCb, opts: ExecOpts) => void) | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    // exec is called as (cmd, cb) or (cmd, options, cb) — normalize both shapes.
    exec: (cmd: string, optsOrCb: ExecOpts | ExecCb, maybeCb?: ExecCb) => {
      const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ExecCb;
      const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
      if (execOverride) { execOverride(cmd, cb, opts); return undefined; }
      return (real.exec as unknown as (c: string, o: ExecOpts, cb: ExecCb) => unknown)(cmd, opts, cb);
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

/** Installs an override that records commands and replies with canned results. */
function captureExec(reply: (cmd: string) => { err?: Error; stdout?: string } = () => ({})) {
  const calls: string[] = [];
  execOptsSeen = [];
  execOverride = (cmd, cb, opts) => {
    calls.push(cmd);
    execOptsSeen.push(opts);
    const r = reply(cmd);
    cb(r.err ?? null, r.stdout ?? '', '');
  };
  return calls;
}

// ── sessionName (pure) ────────────────────────────────────────────────────────

describe('sessionName', () => {
  it('produces a valid tmux session name from a UUID', () => {
    expect(TmuxManager.sessionName('123e4567-e89b-12d3-a456-426614174000'))
      .toBe('unmess-123e4567-e89b-12d3-a456-426614174000');
  });

  it('is deterministic', () => {
    expect(TmuxManager.sessionName('some-id')).toBe(TmuxManager.sessionName('some-id'));
    expect(TmuxManager.sessionName('some-id')).toBe('unmess-some-id');
  });

  it('replaces invalid characters with dashes and collapses runs', () => {
    expect(TmuxManager.sessionName('repo/path worktree_1')).toBe('unmess-repo-path-worktree-1');
    expect(TmuxManager.sessionName('a//b..c')).toBe('unmess-a-b-c');
  });

  it('trims leading/trailing dashes', () => {
    expect(TmuxManager.sessionName('/x/')).toBe('unmess-x');
    expect(TmuxManager.sessionName('--x--')).toBe('unmess-x');
  });

  it('caps the id portion at 50 characters', () => {
    const name = TmuxManager.sessionName('a'.repeat(60));
    expect(name).toBe('unmess-' + 'a'.repeat(50));
    expect(name.length).toBe(57);
  });
});

// ── command construction (mocked exec) ───────────────────────────────────────

describe('command construction', () => {
  const tmux = new TmuxManager();

  it('isAvailable runs `which tmux` and maps success/error to boolean', async () => {
    let calls = captureExec(() => ({}));
    await expect(TmuxManager.isAvailable()).resolves.toBe(true);
    expect(calls).toEqual(['which tmux']);
    calls = captureExec(() => ({ err: new Error('not found') }));
    await expect(TmuxManager.isAvailable()).resolves.toBe(false);
  });

  it('hasSession probes with stderr silenced and maps success/error to boolean', async () => {
    let calls = captureExec(() => ({}));
    await expect(tmux.hasSession('s1')).resolves.toBe(true);
    expect(calls).toEqual(['tmux has-session -t "s1" 2>/dev/null']);
    calls = captureExec(() => ({ err: new Error('no session') }));
    await expect(tmux.hasSession('s1')).resolves.toBe(false);
  });

  it('ensureSession does nothing when the session exists', async () => {
    const calls = captureExec(() => ({}));
    await tmux.ensureSession('s1', '/some/cwd');
    expect(calls).toEqual(['tmux has-session -t "s1" 2>/dev/null']);
  });

  it('ensureSession creates a detached session with -c cwd when missing', async () => {
    const calls = captureExec(cmd => cmd.startsWith('tmux has-session') ? { err: new Error('nope') } : {});
    await tmux.ensureSession('s1', '/some/cwd');
    expect(calls).toEqual([
      'tmux has-session -t "s1" 2>/dev/null',
      'tmux new-session -d -s "s1" -c "/some/cwd"',
    ]);
  });

  it('pins the new window name so tmux cannot rename it out from under us', async () => {
    // reconnect() decides a window holds an agent by matching its name against
    // the provider ids; left to its default tmux renames a window after the
    // running command, and every agent comes back as an unrecognised shell.
    // automatic-rename is a WINDOW option — setting it on the session does not
    // reliably reach windows created afterwards.
    const calls = captureExec(cmd => (cmd.includes('new-window') ? { stdout: '4' } : {}));
    await tmux.newWindow('s1', 'claude', '/cwd');
    expect(calls).toContain('tmux set-window-option -t "s1:4" automatic-rename off');
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
      'tmux new-window -t "s1" -n "claude" -c "/wt" -P -F "#{window_index}"',
      'tmux set-window-option -t "s1:3" automatic-rename off',
    ]);
  });

  it('sendKeys single-quotes the keys and escapes embedded single quotes', async () => {
    const calls = captureExec(() => ({}));
    await tmux.sendKeys('s1:2', "echo 'a'");
    expect(calls).toEqual([`tmux send-keys -t "s1:2" 'echo '\\''a'\\''' Enter`]);
  });

  it('respawnWindow kills the pane and runs the command directly, escaping single quotes', async () => {
    const calls = captureExec(() => ({}));
    await tmux.respawnWindow('s1', 3, "claude; exec 'sh'");
    expect(calls).toEqual([`tmux respawn-window -k -t "s1:3" 'claude; exec '\\''sh'\\'''`]);
  });

  it('selectWindow targets session:index', async () => {
    const calls = captureExec(() => ({}));
    await tmux.selectWindow('s1', 4);
    expect(calls).toEqual(['tmux select-window -t "s1:4"']);
  });

  it('paste loads a temp-file buffer, bracketed-pastes it, then submits with Enter', async () => {
    const calls = captureExec(() => ({}));
    await tmux.paste('s1:2', 'line one\nline two');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/^tmux load-buffer -b "unmess-paste-\d+" ".*unmess-paste-\d+\.txt"$/);
    expect(calls[1]).toMatch(/^tmux paste-buffer -d -p -b "unmess-paste-\d+" -t "s1:2"$/);
    expect(calls[2]).toBe('tmux send-keys -t "s1:2" Enter');
  });

  it('killSession swallows errors (session may not exist)', async () => {
    const calls = captureExec(() => ({ err: new Error('gone') }));
    await expect(tmux.killSession('s1')).resolves.toBeUndefined();
    expect(calls).toEqual(['tmux kill-session -t "s1"']);
  });

  it('detachClients detaches by session and swallows errors', async () => {
    let calls = captureExec(() => ({}));
    await tmux.detachClients('s1');
    expect(calls).toEqual(['tmux detach-client -s "s1"']);
    calls = captureExec(() => ({ err: new Error('no clients') }));
    await expect(tmux.detachClients('s1')).resolves.toBeUndefined();
  });

  it('killWindow targets session:index and swallows errors', async () => {
    const calls = captureExec(() => ({ err: new Error('gone') }));
    await expect(tmux.killWindow('s1', 2)).resolves.toBeUndefined();
    expect(calls).toEqual(['tmux kill-window -t "s1:2"']);
  });

  it('listWindows parses separator-delimited index/name/title lines, keeping spaces in names and titles', async () => {
    const calls = captureExec(() => ({
      stdout: '0|:unmess:|zsh|:unmess:|my-host.local\n1|:unmess:|claude|:unmess:|⠂ Fix login flow bug\n2|:unmess:|my window name|:unmess:|\n',
    }));
    await expect(tmux.listWindows('s1')).resolves.toEqual([
      { index: 0, name: 'zsh', title: 'my-host.local' },
      { index: 1, name: 'claude', title: '⠂ Fix login flow bug' },
      { index: 2, name: 'my window name', title: '' },
    ]);
    expect(calls).toEqual(['tmux list-windows -t "s1" -F "#{window_index}|:unmess:|#{window_name}|:unmess:|#{pane_title}"']);
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
    await expect(tmux.listWindows('s1')).resolves.toEqual([{ index: 3, name: '', title: '' }]);
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
  const SES = `unmess-test-${process.pid}`;
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
