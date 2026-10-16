import { exec, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ISessionManager, TmuxClient, TmuxSession, TmuxWindow } from '../ports/ISessionManager';

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
    return 'stack-' + worktreeId
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  /**
   * The tmux session behind ONE session tab: a session of its own holding a
   * LINK to that one window of the worktree's session (link-window shares the
   * window, it does not copy it). Two terminals attached to the same session
   * would mirror each other — tmux has one current window per session, shared
   * by all its clients — which is why one terminal per worktree was all there
   * could be.
   *
   * Linked rather than grouped (`new-session -t base`), deliberately: a view
   * that holds nothing but its window is destroyed by tmux the moment that
   * window dies — the agent exited, the shell was `exit`ed — and its client
   * with it, so the tab closes by itself. A grouped view shares every window
   * and just moves on to another one, mirroring a session that has its own
   * tab; the hooks that could catch that are not delivered reliably to group
   * members. It also leaves nothing to navigate to from inside the tab, and
   * no group to keep window numbering in sync with.
   *
   * `__w` cannot occur in a base name (sessionName keeps only [a-zA-Z0-9-]), so
   * a view name always parses back to exactly one base and window.
   */
  static viewSessionName(base: string, windowIndex: number): string {
    return `${base}${TmuxManager.VIEW_MARK}${windowIndex}`;
  }

  /** The base session and window a view session belongs to; undefined for any other session. */
  static parseViewSessionName(name: string): { base: string; windowIndex: number } | undefined {
    const m = /^(stack-[a-zA-Z0-9-]+)__w(\d+)$/.exec(name);
    return m ? { base: m[1], windowIndex: Number(m[2]) } : undefined;
  }

  private static readonly VIEW_MARK = '__w';

  /**
   * The argv a single-mode viewer terminal runs as `tmux …` — no shell in
   * between. `=` makes the target exact: tmux otherwise also accepts a unique
   * PREFIX, and every view session's name starts with its base's.
   */
  static attachArgs(base: string): string[] {
    return ['attach-session', '-t', `=${base}`];
  }

  /**
   * The argv a session tab runs as `tmux …`: one tmux command sequence (`;` as
   * its own argument separates commands; no shell parses any of it) that
   * creates the view if it is missing and attaches to it either way.
   *
   * Self-contained on purpose. VS Code revives editor terminals after a
   * restart by running their command again, and by then the old view is gone
   * (destroy-unattached, below) — a plain `attach -t view` would die with "no
   * such session" and leave a dead tab; `new-session -A` re-creates it.
   *
   * A session cannot be created empty, so it starts with a placeholder window,
   * the window is linked in, and the lowest window is unlinked — the
   * placeholder, which `-k` then kills as linked nowhere else. Attaching to a
   * view that already exists (a second VS Code window on the same session)
   * links the window a second time and unlinks one of the two links again:
   * `-k` never kills a window still linked into the base. If the window is
   * gone the link fails, the sequence stops there, and the placeholder's
   * short `sleep` ends the view — and the tab — on its own.
   *
   * - `status off`: the tab title and the sidebar name the session; there is
   *   nothing else in the view to list.
   * - `destroy-unattached on`, on the VIEW only: when its last terminal goes
   *   (tab closed, VS Code quit), the view goes too. Killing a session only
   *   unlinks the windows that are linked elsewhere; the window lives on in
   *   the base.
   */
  static viewAttachArgs(base: string, windowIndex: number): string[] {
    const view = TmuxManager.viewSessionName(base, windowIndex);
    return [
      'new-session', '-A', '-s', view, '-n', 'stack-placeholder', 'sleep 5',
      ';', 'link-window', '-d', '-s', `=${base}:${windowIndex}`, '-t', `=${view}:`,
      ';', 'unlink-window', '-k', '-t', `=${view}:^`,
      ';', 'set-option', '-t', `=${view}:`, 'status', 'off',
      ';', 'set-option', '-t', `=${view}:`, 'destroy-unattached', 'on',
    ];
  }

  /**
   * Which session a Stack terminal attaches to, read back from its launch
   * argv — exact, where matching the terminal's NAME is a guess. Also reads
   * the `/bin/sh -c 'tmux attach -t "…"'` form viewers were launched with
   * before, so a reload into this version still recognises them.
   */
  static sessionOfAttachArgs(shellArgs: unknown): string | undefined {
    if (typeof shellArgs === 'string') {
      return /tmux attach(?:-session)? -t "=?([^"]+)"/.exec(shellArgs)?.[1];
    }
    if (!Array.isArray(shellArgs)) return undefined;
    const args = shellArgs as unknown[];
    if (args[0] === 'attach-session' && args[1] === '-t' && typeof args[2] === 'string') return args[2].replace(/^=/, '');
    if (args[0] === 'new-session' && args[1] === '-A' && args[2] === '-s' && typeof args[3] === 'string') return args[3];
    if (args[0] === '-c' && typeof args[1] === 'string') return TmuxManager.sessionOfAttachArgs(args[1]);
    return undefined;
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
   * `$(touch x)` ran `touch x` the moment Stack opened a terminal in it.
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

  /**
   * Exact (`=`): a bare name is also matched as a unique prefix, so with the
   * base session gone a single view session would answer for it — and
   * ensureSession would then open windows in the view, where they die with it.
   */
  async hasSession(name: string): Promise<boolean> {
    try {
      await this.tmux('has-session', '-t', `=${name}`);
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
    // Stack keys everything on window indexes — its window map, the
    // STACK_WINDOW_INDEX baked into each agent's environment, the hook
    // routing built on it — so a ~/.tmux.conf with `renumber-windows on`
    // would shift them under a running agent the first time a window closed,
    // and every later hook would land on the wrong session. Pinned per
    // session, like automatic-rename per window; the user's other sessions
    // keep their setting. (`base-index` needs no pin: indexes are read back
    // from tmux, and reconnect finds the session's first window wherever it
    // starts.) Best-effort, on every call so sessions from older versions
    // get it too.
    await this.tmux('set-option', '-t', `=${name}:`, 'renumber-windows', 'off').catch(() => {});
  }

  /** Creates a new window and returns its index. */
  async newWindow(session: string, name: string, cwd: string): Promise<number> {
    const out = await this.tmux('new-window', '-t', session, '-n', name, '-c', cwd, '-P', '-F', '#{window_index}');
    const index = parseInt(out, 10);
    // Pin the name we just gave it. Window names are Stack's identity for a
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
    // Both names are unique PER CALL. They used to be `stack-paste-<pid>`,
    // shared by every paste this extension host made — so two in flight at
    // once (two image drops, a launch's prompt and a review send) loaded into
    // the same buffer and the same file: one agent received the other's text,
    // and whichever finished first unlinked the file the other was still
    // loading. tmux buffers are server-wide, so the name also has to be unique
    // across windows; the pid keeps two VS Code windows apart.
    const bufferName = `stack-paste-${process.pid}-${++TmuxManager.pasteSeq}-${randomBytes(4).toString('hex')}`;
    // A private directory rather than a guessable name in the shared tmpdir:
    // mkdtemp makes it 0700 and unique, and the prompt never sits world-readable.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stack-paste-'));
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

  /** Exact, like hasSession: a prefix match would kill some other session. */
  async killSession(name: string): Promise<void> {
    try { await this.tmux('kill-session', '-t', `=${name}`); } catch { /* may not exist */ }
  }

  /** Detaches all VSCode viewer clients from the session (session keeps running). */
  async detachClients(sessionName: string): Promise<void> {
    try { await this.tmux('detach-client', '-s', `=${sessionName}`); } catch { /* no clients attached */ }
  }

  /** Every session on the server, with how many clients each has; [] when there is no server. */
  async listSessions(): Promise<TmuxSession[]> {
    const SEP = '|:stack:|';
    try {
      const out = await this.tmux('list-sessions', '-F', `#{session_name}${SEP}#{session_attached}`);
      return out.split('\n').filter(Boolean).map((line) => {
        const [name, attached] = line.split(SEP);
        return { name, attached: parseInt(attached ?? '', 10) || 0 };
      });
    } catch { return []; }
  }

  /** Every attached client: its process (a terminal's processId) and the session it shows. */
  async listClients(): Promise<TmuxClient[]> {
    const SEP = '|:stack:|';
    try {
      const out = await this.tmux('list-clients', '-F', `#{client_pid}${SEP}#{session_name}`);
      return out.split('\n').filter(Boolean).flatMap((line) => {
        const [pid, session] = line.split(SEP);
        const n = parseInt(pid, 10);
        return Number.isNaN(n) || !session ? [] : [{ pid: n, session }];
      });
    } catch { return []; }
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
    const SEP = '|:stack:|';
    try {
      const out = await this.tmux(
        'list-windows', '-t', `=${session}`,
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
