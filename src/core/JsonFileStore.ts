import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KeyValueStore } from './KeyValueStore';

/**
 * A KeyValueStore backed by one JSON file (for `stackd`). The whole file is
 * loaded once and rewritten atomically (temp file + rename) on every update.
 * A missing or unreadable file starts empty; values are JSON round-tripped.
 */
export class JsonFileStore implements KeyValueStore {
  private data: Record<string, unknown> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(private filePath: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, unknown>;
      }
    } catch {
      /* missing or corrupt: start empty */
    }
  }

  get<T>(key: string, defaultValue: T): T {
    return key in this.data ? (structuredClone(this.data[key]) as T) : defaultValue;
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else this.data[key] = structuredClone(value);
    const json = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(() => {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.filePath);
    });
    return this.writing;
  }
}
