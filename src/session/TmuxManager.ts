import { exec, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ISessionManager, TmuxWindow } from '../ports/ISessionManager';

/**
 * A UTF-8 locale that actually exists on the given platform.
 *
 * `en_US.UTF-8` is the macOS one and is frequently NOT generated on Linux —
 * setting LC_ALL to a locale the system does not have leaves the process in C,
 * which is the very state forcing a locale exists to avoid. glibc ships
 * `C.UTF-8`. Exported so both branches can be exercised from one machine.
 */
export function utf8LocaleFor(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

export class TmuxManager implements ISessionManager {
  static sessionName(worktreeId: string): string {
    return 'foreman-' + worktreeId
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  private static readonly UTF8_LOCALE = utf8LocaleFor(process.platform);

  /** Per-process paste counter; with the pid and a random suffix, a buffer name nobody else holds. */
  private static pasteSeq = 0;

  /**
   * Run a program with an argument vector — no shell in between.
   *
   * Every call used to be one string handed to `exec`, i.e. to `/bin/sh -c`,
   * with values spliced into double quotes — where `$(...)` and backticks
   * still expand. The worktree path carries the branch name, and branches
   * adopted from `git worktree list` are not validated, so a branch called
   * `$(touch x)` ran `touch x` the moment Foreman opened a terminal in it.
   * Arguments passed as a vector are never parsed, so there is nothing to
   * escape and nothing to get wrong.
   */
  private runFile(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      // Force a UTF-8 locale: the VSCode extension host has no LANG/LC_ALL, and
      // under the C locale tmux replaces every non-printable/non-ASCII byte of
      // its output with '_' — destroying the \x01 field separator in
      // listWindows and any non-ASCII pane title.
      const locale = TmuxManager.UTF8_LOCALE;
      execFile(file, args, { env: { ...process.env, LC_ALL: locale, LANG: locale } }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  }

  private tmux(...args: string[]): Promise<string> {
    return this.runFile('tmux', args);
  }

  static isAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      exec('which tmux', err => resolve(!err));
    });
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.tmux('has-session', '-t', name);
      return true;
    } catch { return false; }
  }

  async ensureSession(name: string, cwd: string): Promise<void> {
    if (!(await this.hasSession(name))) {
      try {
        await this.tmux('new-session', '-d', '-s', name, '-c', cwd);
      } catch (e) {
        // Two launches into one worktree can both see no session and both
        // create it; the second fails with "duplicate session". The session
        // exists, which is all this promised — only a session that is still
        // missing makes the failure real.
        if (!(await this.hasSession(name))) throw e;
      }
    }
    // Foreman keys everything on window indexes — its window map, the
    // FOREMAN_WINDOW_INDEX baked into each agent's environment, the hook
    // routing built on it — so a ~/.tmux.conf with `renumber-windows on`
    // would shift them under a running agent the first time a window closed,
    // and every later hook would land on the wrong session. Pinned per
    // session, like automatic-rename per window; the user's other sessions
    // keep their setting. (`base-index` needs no pin: indexes are read back
    // from tmux, and reconnect finds the session's first window wherever it
    // starts.) Best-effort, on every call so sessions from older versions
    // get it too.
    await this.tmux('set-option', '-t', name, 'renumber-windows', 'off').catch(() => {});
  }

  /** Creates a new window and returns its index. */
  async newWindow(session: string, name: string, cwd: string): Promise<number> {
    const out = await this.tmux('new-window', '-t', session, '-n', name, '-c', cwd, '-P', '-F', '#{window_index}');
    const index = parseInt(out, 10);
    // Pin the name we just gave it. Window names are Foreman's identity for a
    // session — reconnect() decides a window holds an agent by matching its
    // name against the provider ids — and tmux otherwise renames a window after
    // whatever command is running in it, so every agent window would come back
    // as an unrecognised shell. Set on the window itself: automatic-rename is a
    // WINDOW option, and setting it on the session does not reliably reach
    // windows created afterwards (it does not on the Linux runners).
    // Best-effort, because a naming quirk must never block a launch.
    try {
      await this.tmux('set-window-option', '-t', `${session}:${index}`, 'automatic-rename', 'off');
    } catch { /* worst case the name drifts, exactly as it did before */ }
    return index;
  }

  async sendKeys(target: string, keys: string): Promise<void> {
    await this.tmux('send-keys', '-t', target, keys, 'Enter');
  }

  /**
   * Leaves the text unsent. Submitting used to happen here, with an Enter sent
   * the instant paste-buffer returned — which is before the receiving app has
   * processed the paste: Claude Code takes a large bracketed paste in
   * asynchronously (it becomes "[Pasted text #1 +N lines]"), and an Enter that
   * arrives meanwhile is absorbed, so the prompt sat in the input unsent.
   * AgentSessionManager now owns submitting, with a settle delay and an
   * acknowledgement; pressEnter is the primitive it uses.
   */
  async paste(target: string, text: string): Promise<void> {
    // Route the text through a tmux buffer loaded from a temp file: this keeps
    // a large multi-line payload off the command line, and paste-buffer -p wraps
    // it in bracketed-paste markers so the receiving app (e.g. Claude Code)
    // treats the whole block as one input instead of submitting on every newline.
    //
    // Both names are unique PER CALL. They used to be `foreman-paste-<pid>`,
    // shared by every paste this extension host made — so two in flight at
    // once (two image drops, a launch's prompt and a review send) loaded into
    // the same buffer and the same file: one agent received the other's text,
    // and whichever finished first unlinked the file the other was still
    // loading. tmux buffers are server-wide, so the name also has to be unique
    // across windows; the pid keeps two VS Code windows apart.
    const bufferName = `foreman-paste-${process.pid}-${++TmuxManager.pasteSeq}-${randomBytes(4).toString('hex')}`;
    // A private directory rather than a guessable name in the shared tmpdir:
    // mkdtemp makes it 0700 and unique, and the prompt never sits world-readable.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'foreman-paste-'));
    const tmpFile = path.join(dir, 'paste.txt');
    try {
      await fs.promises.writeFile(tmpFile, text, 'utf8');
      await this.tmux('load-buffer', '-b', bufferName, tmpFile);
      try {
        await this.tmux('paste-buffer', '-d', '-p', '-b', bufferName, '-t', target);
      } catch (e) {
        // -d only deletes on success; a failed paste would leave the prompt
        // sitting in a server-wide buffer for the life of the tmux server.
        await this.tmux('delete-buffer', '-b', bufferName).catch(() => {});
        throw e;
      }
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async pressEnter(target: string): Promise<void> {
    await this.tmux('send-keys', '-t', target, 'Enter');
  }

  /**
   * `command` is a shell command on purpose — tmux runs it through the
   * default shell, which is what lets a launch line set env vars and chain
   * `; exec $SHELL`. Only the tmux invocation itself is shell-free.
   */
  async respawnWindow(session: string, windowIndex: number, command: string): Promise<void> {
    await this.tmux('respawn-window', '-k', '-t', `${session}:${windowIndex}`, command);
  }

  async selectWindow(session: string, windowIndex: number): Promise<void> {
    await this.tmux('select-window', '-t', `${session}:${windowIndex}`);
  }

  async killSession(name: string): Promise<void> {
    try { await this.tmux('kill-session', '-t', name); } catch { /* may not exist */ }
  }

  /** Detaches all VSCode viewer clients from the session (session keeps running). */
  async detachClients(sessionName: string): Promise<void> {
    try { await this.tmux('detach-client', '-s', sessionName); } catch { /* no clients attached */ }
  }

  async killWindow(session: string, windowIndex: number): Promise<void> {
    try { await this.tmux('kill-window', '-t', `${session}:${windowIndex}`); } catch { /* may not exist */ }
  }

  async listWindows(session: string): Promise<TmuxWindow[]> {
    // A PRINTABLE separator, deliberately.
    //
    // This used to be \x01, guarded by forcing a UTF-8 locale — because under
    // the C locale tmux replaces every non-printable byte of its output with
    // '_'. That guard is not reliable: the locale must exist on the machine
    // (en_US.UTF-8 usually does not on Linux) and, worse, it is the tmux
    // SERVER's locale that formats the output, and the server may already be
    // running from an earlier command. When it failed, the damage was silent:
    // parseInt still read the leading digits so the index looked right, while
    // name and title came back empty — every agent window then classified as an
    // unrecognised shell, which is what reconnect() uses to find agents.
    // Printable ASCII survives any locale, so the parse no longer has a way to
    // half-fail.
    const SEP = '|:foreman:|';
    try {
      const out = await this.tmux(
        'list-windows', '-t', session,
        '-F', `#{window_index}${SEP}#{window_name}${SEP}#{pane_title}${SEP}#{pane_current_command}${SEP}#{pane_pid}`,
      );
      return out.split('\n').filter(Boolean).map(line => {
        const [index, name, title, command, pid] = line.split(SEP);
        const pane = parseInt(pid ?? '', 10);
        return {
          index: parseInt(index, 10), name: name ?? '', title: title ?? '', command: command ?? '',
          ...(Number.isNaN(pane) ? {} : { pid: pane }),
        };
      });
    } catch { return []; }
  }

  /**
   * `pgrep -P` rather than tmux: `pane_current_command` names the pane's
   * process-group leader, and a command run through a non-interactive shell
   * (`zsh -c "claude; exec zsh"`, which is what respawn-window does) keeps its
   * child in the same group — so tmux reports `zsh` for as long as the agent
   * runs. The child list is the only thing that actually changes.
   */
  async hasChildProcess(pid: number): Promise<boolean> {
    try {
      return (await this.runFile('pgrep', ['-P', String(pid)])).trim().length > 0;
    } catch {
      return false; // pgrep exits 1 when there is nothing to list
    }
  }

  /** `ps` with -ww so a long launch line is not cut at the terminal width. Rejects when the pid is gone. */
  async processCommandLine(pid: number): Promise<string> {
    return this.runFile('ps', ['-ww', '-o', 'args=', '-p', String(pid)]);
  }
}
