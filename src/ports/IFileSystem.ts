export interface IFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string, options?: { mode?: number }): void;
  mkdir(path: string): void;
}
