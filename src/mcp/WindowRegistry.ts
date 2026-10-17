import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WINDOWS_DIR, type WindowFile } from './protocol';
import { isPidAlive, readWindows } from './discovery';

type Fields = Partial<Pick<WindowFile, 'port' | 'repoRoots' | 'workspaceFolders' | 'worktreeIds'>>;

/**
 * This window's discovery file: `<globalStorage>/windows/<pid>.json`, 0600 in
 * a 0700 directory, holding the port and the token a bridge needs to call it.
 *
 * Rewritten whenever what it says changes (activation, folders, worktrees)
 * and on focus — the bridge breaks ties between two windows on one repository
 * by `focusedAt`. Removed on dispose; a window that dies without disposing
 * leaves a file whose pid is gone, which readers ignore and sweep.
 */
export class WindowRegistry {
  readonly token: string;

  readonly dir: string;

  readonly file: string;

  private state: WindowFile;

  private disposed = false;

  constructor(
    storagePath: string,
    private readonly opts: { pid?: number; now?: () => number; token?: string; isAlive?: (pid: number) => boolean } = {},
  ) {
    const pid = opts.pid ?? process.pid;
    this.token = opts.token ?? randomBytes(32).toString('hex');
    this.dir = path.join(storagePath, WINDOWS_DIR);
    this.file = path.join(this.dir, `${pid}.json`);
    this.state = { pid, port: 0, token: this.token, repoRoots: [], workspaceFolders: [], worktreeIds: [], focusedAt: this.now() };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Changes what the file says and writes it. Unchanged content is not rewritten (focus aside). */
  update(fields: Fields): void {
    const next = { ...this.state, ...fields };
    if (JSON.stringify(next) === JSON.stringify(this.state) && fs.existsSync(this.file)) return;
    this.state = next;
    this.write();
  }

  /** The window got focus: it becomes the preferred one for its repository. */
  focus(): void {
    this.state = { ...this.state, focusedAt: this.now() };
    this.write();
  }

  /** Removes files of windows whose process is gone. */
  sweep(): void {
    readWindows(this.dir, this.opts.isAlive ?? isPidAlive);
  }

  dispose(): void {
    this.disposed = true;
    try { fs.rmSync(this.file, { force: true }); } catch { /* best effort */ }
  }

  private write(): void {
    // Nothing to reach before the server listens, and nothing after dispose.
    if (this.disposed || this.state.port === 0) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Atomic, and 0600 from the first byte: the token is a key to this window.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}
