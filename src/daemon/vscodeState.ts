import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { KeyValueStore } from '../core/KeyValueStore';
import { EXTENSION_ID } from '../constants';

const execFileAsync = promisify(execFile);

/** Where VS Code (and forks) keep the extension's `globalState`, newest-first guess. */
export function vscodeStateDbCandidates(home = os.homedir(), platform = process.platform): string[] {
  const roots = platform === 'darwin'
    ? ['Code', 'Code - Insiders', 'Cursor'].map((n) => path.join(home, 'Library', 'Application Support', n))
    : ['Code', 'Code - Insiders', 'Cursor'].map((n) => path.join(home, '.config', n));
  return roots.map((r) => path.join(r, 'User', 'globalStorage', 'state.vscdb'));
}

/**
 * What the extension's globalState holds, read straight from VS Code's sqlite
 * file with `sqlite3 -readonly`: never written, never locked for writing, so a
 * running window is not disturbed. `{}` when there is no such file, no sqlite3
 * or nothing stored.
 */
export async function readVsCodeGlobalState(
  candidates: string[] = vscodeStateDbCandidates(),
  extensionId: string = EXTENSION_ID,
): Promise<Record<string, unknown>> {
  for (const db of candidates) {
    if (!fs.existsSync(db)) continue;
    try {
      const { stdout } = await execFileAsync(
        'sqlite3',
        ['-readonly', db, `select value from ItemTable where key='${extensionId.replace(/'/g, "''")}'`],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      if (!stdout.trim()) continue;
      const parsed: unknown = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return {};
}

/** An in-memory KeyValueStore seeded from a snapshot; writes never leave the process. */
export class MemoryStore implements KeyValueStore {
  private data: Record<string, unknown>;
  constructor(seed: Record<string, unknown> = {}) {
    this.data = structuredClone(seed);
  }
  get<T>(key: string, defaultValue: T): T {
    return key in this.data ? (structuredClone(this.data[key]) as T) : defaultValue;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else this.data[key] = structuredClone(value);
    return Promise.resolve();
  }
}
