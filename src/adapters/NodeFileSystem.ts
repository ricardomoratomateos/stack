import * as fs from 'node:fs';
import { IFileSystem } from '../ports/IFileSystem';

/** IFileSystem implementation backed by node:fs (sync, matching the port). */
export class NodeFileSystem implements IFileSystem {
  exists(path: string): boolean {
    return fs.existsSync(path);
  }

  mkdir(path: string): void {
    fs.mkdirSync(path, { recursive: true });
  }
}
