/**
 * SPIKE (docs/spikes/code-browser.md). What the code browser asks of its backend. In the prototype it is
 * `desktop/scripts/code-dev-server.mjs` over localhost HTTP; in the app it would be stackd commands
 * (`codeTree`, `codeFile`, `codeFiles`, `codeLsp`, `codeLspStatus`) through the existing Tauri bridge.
 */
export interface TreeEntry { name: string; dir: boolean }
export interface FileContent { path: string; size: number; text: string; binary?: boolean; tooLarge?: boolean }
export interface FileMatches { total: number; walkMs: number; files: string[] }
export interface LspStatus {
  server: string; root: string; state: 'starting' | 'indexing' | 'ready' | 'dead'; message: string;
  initMs?: number; indexMs?: number; indexingForMs?: number; rssMb: number;
}

/** An LSP diagnostic as the linter publishes it (0-based positions). */
export interface LintDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number; code?: string | number; source?: string; message: string;
}

export interface CodeBackend {
  roots(): Promise<Array<{ root: string; name: string }>>;
  tree(dir: string): Promise<TreeEntry[]>;
  file(path: string): Promise<FileContent>;
  files(root: string, query: string): Promise<FileMatches>;
  /** One navigation request to the language server of `languageId` for `root` (started on first use). */
  lsp<T = unknown>(root: string, languageId: string, method: string, params: unknown): Promise<T>;
  lspStatus(): Promise<LspStatus[]>;
  /** Lint findings for one JS/TS file (oxlint); empty when the backend has no linter. */
  lint(root: string, path: string): Promise<{ ms: number; diagnostics: LintDiagnostic[] }>;
}

export function httpBackend(base: string): CodeBackend {
  const call = async <T,>(route: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + route, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
    const answer = (await res.json()) as { ok: boolean; result?: T; error?: string };
    if (!answer.ok) throw new Error(answer.error ?? `HTTP ${res.status}`);
    return answer.result as T;
  };
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  return {
    roots: () => call('/roots'),
    tree: (dir) => call(`/tree?${q({ dir })}`),
    file: (path) => call(`/file?${q({ path })}`),
    files: (root, query) => call(`/files?${q({ root, q: query })}`),
    lsp: async <T,>(root: string, languageId: string, method: string, params: unknown) =>
      (await call<{ result: T; ms: number }>('/lsp', { root, languageId, method, params })).result,
    lspStatus: () => call('/lsp/status'),
    lint: (root, path) => call(`/lint?${q({ root, path })}`),
  };
}
