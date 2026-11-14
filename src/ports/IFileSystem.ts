export interface IFileSystem {
  exists(path: string): boolean;
  mkdir(path: string): void;
}
