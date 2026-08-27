import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ISessionManager } from '../ports/ISessionManager';

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
    return 'unmess-' + worktreeId
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  private static readonly UTF8_LOCALE = utf8LocaleFor(process.platform);

  private run(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Force a UTF-8 locale: the VSCode extension host has no LANG/LC_ALL, and
      // under the C locale tmux replaces every non-printable/non-ASCII byte of
      // its output with '_' — destroying the \x01 field separator in
      // listWindows and any non-ASCII pane title.
      const locale = TmuxManager.UTF8_LOCALE;
      exec(cmd, { env: { ...process.env, LC_ALL: locale, LANG: locale } }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  }

  static isAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      exec('which tmux', err => resolve(!err));
    });
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(`tmux has-session -t "${name}" 2>/dev/null`);
      return true;
    } catch { return false; }
  }

  async ensureSession(name: string, cwd: string): Promise<void> {
    if (!(await this.hasSession(name))) {
      await this.run(`tmux new-session -d -s "${name}" -c "${cwd}"`);
    }
  }

  /** Creates a new window and returns its index. */
  async newWindow(session: string, name: string, cwd: string): Promise<number> {
    const out = await this.run(
      `tmux new-window -t "${session}" -n "${name}" -c "${cwd}" -P -F "#{window_index}"`,
    );
    const index = parseInt(out, 10);
    // Pin the name we just gave it. Window names are Unmess's identity for a
    // session — reconnect() decides a window holds an agent by matching its
    // name against the provider ids — and tmux otherwise renames a window after
    // whatever command is running in it, so every agent window would come back
    // as an unrecognised shell. Set on the window itself: automatic-rename is a
    // WINDOW option, and setting it on the session does not reliably reach
    // windows created afterwards (it does not on the Linux runners).
    // Best-effort, because a naming quirk must never block a launch.
    try {
      await this.run(`tmux set-window-option -t "${session}:${index}" automatic-rename off`);
    } catch { /* worst case the name drifts, exactly as it did before */ }
    return index;
  }

  async sendKeys(target: string, keys: string): Promise<void> {
    const escaped = keys.replace(/'/g, "'\\''");
    await this.run(`tmux send-keys -t "${target}" '${escaped}' Enter`);
  }

  async paste(target: string, text: string, submit = true): Promise<void> {
    // Route the text through a tmux buffer loaded from a temp file: this avoids
    // shell-escaping a large multi-line payload, and paste-buffer -p wraps it in
    // bracketed-paste markers so the receiving app (e.g. Claude Code) treats the
    // whole block as one input instead of submitting on every newline.
    const bufferName = `unmess-paste-${process.pid}`;
    const tmpFile = path.join(os.tmpdir(), `${bufferName}.txt`);
    await fs.promises.writeFile(tmpFile, text, 'utf8');
    try {
      await this.run(`tmux load-buffer -b "${bufferName}" "${tmpFile}"`);
      await this.run(`tmux paste-buffer -d -p -b "${bufferName}" -t "${target}"`);
      // Submit once, after the paste has landed — unless the caller wants to
      // leave the text unsent (e.g. an image path the user still adds a prompt to).
      if (submit) await this.run(`tmux send-keys -t "${target}" Enter`);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  }

  async respawnWindow(session: string, windowIndex: number, command: string): Promise<void> {
    const escaped = command.replace(/'/g, "'\\''");
    await this.run(`tmux respawn-window -k -t "${session}:${windowIndex}" '${escaped}'`);
  }

  async selectWindow(session: string, windowIndex: number): Promise<void> {
    await this.run(`tmux select-window -t "${session}:${windowIndex}"`);
  }

  async killSession(name: string): Promise<void> {
    try { await this.run(`tmux kill-session -t "${name}"`); } catch { /* may not exist */ }
  }

  /** Detaches all VSCode viewer clients from the session (session keeps running). */
  async detachClients(sessionName: string): Promise<void> {
    try { await this.run(`tmux detach-client -s "${sessionName}"`); } catch { /* no clients attached */ }
  }

  async killWindow(session: string, windowIndex: number): Promise<void> {
    try { await this.run(`tmux kill-window -t "${session}:${windowIndex}"`); } catch { /* may not exist */ }
  }

  async listWindows(session: string): Promise<Array<{ index: number; name: string; title: string }>> {
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
    const SEP = '|:unmess:|';
    try {
      const out = await this.run(
        `tmux list-windows -t "${session}" -F "#{window_index}${SEP}#{window_name}${SEP}#{pane_title}"`,
      );
      return out.split('\n').filter(Boolean).map(line => {
        const [index, name, title] = line.split(SEP);
        return { index: parseInt(index, 10), name: name ?? '', title: title ?? '' };
      });
    } catch { return []; }
  }
}
