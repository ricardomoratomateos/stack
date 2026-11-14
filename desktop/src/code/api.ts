/**
 * What the code browser asks of its backend. In the app it is stackd (`code*` commands through the Tauri
 * bridge, see src/code/CodeService.ts). `?dev=code` reaches the same service through
 * `desktop/scripts/code-dev-backend.mjs`.
 */
import type { StackdApi } from '../stackd/api';

export interface TreeEntry { name: string; dir: boolean }
export interface FileContent { path: string; size: number; text: string; binary?: boolean; tooLarge?: boolean }
export interface FileMatches { total: number; walkMs?: number; files: string[] }
/** A file of the task's diff against its base. */
export interface ChangedFile { path: string; status: 'A' | 'M' | 'D' | 'R' }
export interface LspStatus {
  server: string; root?: string; state: 'starting' | 'indexing' | 'ready' | 'dead'; message: string;
  initMs?: number; indexMs?: number; indexingForMs?: number; rssMb?: number;
}

/** An LSP diagnostic as the linter publishes it (0-based positions). */
export interface LintDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number; code?: string | number; source?: string; message: string;
}

export interface CodeBackend {
  tree(dir: string): Promise<TreeEntry[]>;
  file(path: string): Promise<FileContent>;
  files(root: string, query: string): Promise<FileMatches>;
  /** One navigation request to the language server of `languageId` for `root` (started on first use). */
  lsp<T = unknown>(root: string, languageId: string, method: string, params: unknown): Promise<T>;
  lspStatus(): Promise<LspStatus[]>;
  /** Lint findings for one JS/TS file (oxlint); empty when the backend has no linter. */
  lint(root: string, path: string): Promise<{ ms: number; diagnostics: LintDiagnostic[] }>;
  /** Find in Path: a fixed-string search over the worktree (paths relative to it). */
  search(root: string, query: string, opts?: { caseSensitive?: boolean; wholeWord?: boolean }): Promise<TextSearchResult>;
}

/** One matching line (1-based line and column, path relative to the worktree). */
export interface TextHit { path: string; line: number; column: number; text: string }
export interface TextSearchResult { hits: TextHit[]; truncated: boolean }

/** The app's backend: stackd, for one task. Paths are absolute; stackd refuses what lies outside the task's worktree. */
export function stackdBackend(api: StackdApi, worktreeId: string): CodeBackend {
  const call = <T,>(name: string, body: Record<string, unknown> = {}) => api.command<T>(name, { worktreeId, ...body });
  return {
    tree: (dir) => call('codeTree', { dir }),
    file: (path) => call('codeRead', { path }),
    files: (_root, query) => call('codeFiles', { query }),
    lsp: async <T,>(_root: string, languageId: string, method: string, params: unknown) =>
      (await call<{ result: T }>('codeLsp', { languageId, method, params })).result,
    lspStatus: () => call('codeStatus'),
    lint: async (_root, path) => ({ ms: 0, ...(await call<{ diagnostics: LintDiagnostic[] }>('codeDiagnostics', { path })) }),
    search: (_root, query, opts = {}) => call('codeSearch', { query, ...opts }),
  };
}

/** What `codeOpen` answers: the worktree's real path and the files the task changed. */
export const openTask = (api: StackdApi, worktreeId: string): Promise<{ root: string; changed: ChangedFile[] }> =>
  api.command('codeOpen', { worktreeId });
