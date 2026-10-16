import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Port slots handed out but not yet in the store, visible to every window.
 *
 * PortAllocator held these in memory, per window, while the store they guard
 * against (globalState) only learns about a worktree after it is added. Two
 * windows creating a worktree at the same moment therefore read the same
 * registry, probed the same free ports and were handed the same slot — two
 * worktrees sharing one block of docker ports, failing minutes later inside
 * `compose up`. The probe cannot catch it: nothing is listening yet.
 */
export interface SharedPortReservations {
  /** Claims `port` for this window; false when another live window holds it. */
  tryReserve(port: number): Promise<boolean>;
  /** Gives up this window's claim on `port`. */
  release(port: number): Promise<void>;
}

interface Entry { pid: number; at: number }

export interface PortReservationFileOptions {
  /** Identifies this window's claims. The extension host is one process per window. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/**
 * A claim outlives its window's crash only this long — far more than the
 * seconds between allocate() and the store write, so a live claim is never
 * expired from under a creation in progress.
 */
const CLAIM_TTL_MS = 10 * 60_000;
/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 5_000;
/** Give up waiting for the lock after this long and fall back to this window alone. */
const LOCK_WAIT_MS = 2_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just is not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SharedPortReservations in a JSON file in globalStorage, guarded by an
 * O_EXCL lockfile. Each read-modify-write takes microseconds; the lock is held
 * for nothing longer.
 *
 * Failure to take the lock (a wedged filesystem) degrades to "reserved": the
 * window keeps its own in-memory reservation and the port probe, which is what
 * it had before. Creating a worktree must not fail over a coordination file.
 */
export class PortReservationFile implements SharedPortReservations {
  private file: string;
  private lock: string;
  private pid: number;
  private isAlive: (pid: number) => boolean;
  private now: () => number;

  constructor(storagePath: string, opts: PortReservationFileOptions = {}) {
    this.file = path.join(storagePath, 'port-reservations.json');
    this.lock = `${this.file}.lock`;
    this.pid = opts.pid ?? process.pid;
    this.isAlive = opts.isAlive ?? processAlive;
    this.now = opts.now ?? Date.now;
  }

  async tryReserve(port: number): Promise<boolean> {
    const result = await this.update((entries) => {
      const holder = entries[port];
      if (holder && holder.pid !== this.pid) return false;
      entries[port] = { pid: this.pid, at: this.now() };
      return true;
    });
    return result ?? true;
  }

  async release(port: number): Promise<void> {
    await this.update((entries) => {
      if (entries[port]?.pid === this.pid) delete entries[port];
      return true;
    });
  }

  /**
   * Runs `fn` on the live entries under the lock and writes the result back.
   * Claims of dead windows, or past their TTL, are dropped on the way.
   * Undefined when the lock could not be had.
   */
  private async update(fn: (entries: Record<number, Entry>) => boolean): Promise<boolean | undefined> {
    const fd = await this.acquire();
    if (fd === undefined) return undefined;
    try {
      const entries = this.read();
      for (const [port, e] of Object.entries(entries)) {
        if (this.now() - e.at > CLAIM_TTL_MS || !this.isAlive(e.pid)) delete entries[Number(port)];
      }
      const result = fn(entries);
      const tmp = `${this.file}.${this.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, this.file);
      return result;
    } catch {
      return undefined;
    } finally {
      fs.closeSync(fd);
      try { fs.rmSync(this.lock, { force: true }); } catch { /* gone */ }
    }
  }

  private read(): Record<number, Entry> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<number, Entry> = {};
      for (const [port, e] of Object.entries(parsed as Record<string, Partial<Entry>>)) {
        if (typeof e?.pid === 'number' && typeof e?.at === 'number') out[Number(port)] = { pid: e.pid, at: e.at };
      }
      return out;
    } catch {
      return {};
    }
  }

  private async acquire(): Promise<number | undefined> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    try {
      fs.mkdirSync(path.dirname(this.lock), { recursive: true });
    } catch {
      return undefined;
    }
    for (;;) {
      try {
        return fs.openSync(this.lock, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      }
      try {
        if (Date.now() - fs.statSync(this.lock).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(this.lock, { force: true });
          continue;
        }
      } catch { /* released meanwhile: retry at once */ continue; }
      if (Date.now() > deadline) return undefined;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    }
  }
}
