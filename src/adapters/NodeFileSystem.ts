import * as fs from 'node:fs';
import { IFileSystem } from '../ports/IFileSystem';

/** IFileSystem implementation backed by node:fs (sync, matching the port). */
export class NodeFileSystem implements IFileSystem {
  exists(path: string): boolean {
    return fs.existsSync(path);
  }

  readFile(path: string): string {
    return fs.readFileSync(path, 'utf8');
  }

  writeFile(path: string, content: string, options?: { mode?: number }): void {
    if (options?.mode !== undefined) {
      fs.writeFileSync(path, content, { mode: options.mode });
    } else {
      fs.writeFileSync(path, content);
    }
  }

  mkdir(path: string): void {
    fs.mkdirSync(path, { recursive: true });
  }
}
