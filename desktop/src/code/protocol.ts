/**
 * SPIKE (docs/spikes/code-browser.md). The pure half of the code browser: paths, language ids and the
 * LSP <-> Monaco shape conversions. No Monaco import, so it runs under vitest.
 */

/** LSP is 0-based on both axes; Monaco is 1-based on both. */
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspLocationLink { targetUri: string; targetRange: LspRange; targetSelectionRange?: LspRange }
export interface MonacoRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

export const toLspPosition = (p: { lineNumber: number; column: number }): LspPosition =>
  ({ line: p.lineNumber - 1, character: p.column - 1 });

export const toMonacoRange = (r: LspRange): MonacoRange => ({
  startLineNumber: r.start.line + 1, startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1, endColumn: r.end.character + 1,
});

/** `textDocument/definition` answers a Location, a list of them, a list of LocationLinks, or null. */
export function locationsOf(result: unknown): LspLocation[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const item of list as Array<Partial<LspLocation & LspLocationLink>>) {
    if (item.uri && item.range) out.push({ uri: item.uri, range: item.range });
    else if (item.targetUri && item.targetRange) out.push({ uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange });
  }
  return out;
}

/** Hover contents: MarkupContent, a MarkedString, or a list of MarkedStrings — as markdown strings. */
export function hoverMarkdown(contents: unknown): string[] {
  const one = (c: unknown): string => {
    if (typeof c === 'string') return c;
    const o = c as { kind?: string; language?: string; value?: string } | null;
    if (!o || typeof o.value !== 'string') return '';
    return o.language ? '```' + o.language + '\n' + o.value + '\n```' : o.value;
  };
  return (Array.isArray(contents) ? contents.map(one) : [one(contents)]).filter(Boolean);
}

/** `file:///a/b%20c.php` -> `/a/b c.php`. */
export const pathOfUri = (uri: string): string => decodeURIComponent(new URL(uri).pathname);
export const uriOfPath = (p: string): string => 'file://' + p.split('/').map(encodeURIComponent).join('/');

/** `root`-relative when inside it, else the absolute path (a PHP stub, lib.d.ts). */
export const relativeTo = (root: string, p: string): string => (p.startsWith(root + '/') ? p.slice(root.length + 1) : p);

const BY_EXT: Record<string, string> = {
  php: 'php', phtml: 'php',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', twig: 'twig',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', xml: 'xml', sh: 'shell', sql: 'sql', go: 'go', py: 'python', rs: 'rust',
};

/** Monaco's language id for a file (syntax colouring). */
export function monacoLanguage(p: string): string {
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (name === 'Dockerfile') return 'dockerfile';
  return BY_EXT[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'plaintext';
}

/** The LSP `languageId` for a file, or undefined when no language server covers it. */
export function lspLanguage(p: string): string | undefined {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'php' || ext === 'phtml') return 'php';
  if (ext === 'tsx') return 'typescriptreact';
  if (ext === 'jsx') return 'javascriptreact';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'typescript';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  return undefined;
}

/** LSP SymbolKind is 1-based (File = 1); Monaco's enum is the same list, 0-based. */
export const monacoSymbolKind = (lspKind: number): number => Math.max(0, lspKind - 1);

/** A bounded back/forward list of places, the way an editor's "Go Back" works. */
export interface Place { path: string; line: number; column: number }
export interface History { places: Place[]; at: number }
export const emptyHistory: History = { places: [], at: -1 };

export function pushPlace(h: History, p: Place, max = 50): History {
  const cur = h.places[h.at];
  if (cur && cur.path === p.path && cur.line === p.line) return h;
  const places = [...h.places.slice(0, h.at + 1), p].slice(-max);
  return { places, at: places.length - 1 };
}
export const canGo = (h: History, delta: number): boolean => h.at + delta >= 0 && h.at + delta < h.places.length;
export const go = (h: History, delta: number): History => (canGo(h, delta) ? { places: h.places, at: h.at + delta } : h);
