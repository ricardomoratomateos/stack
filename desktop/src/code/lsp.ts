/**
 * SPIKE (docs/spikes/code-browser.md). A thin, read-only LSP client: Monaco providers that turn into one
 * request each to the backend (which owns the language servers and the documents' text). ~150 lines instead of
 * `monaco-languageclient` + `@codingame/monaco-vscode-api`: a browser needs no document sync from the client,
 * no diagnostics, no completion, no workspace edits.
 */
import type { CodeBackend } from './api';
import { monaco } from './monaco';
import {
  hoverMarkdown, locationsOf, lspLanguage, monacoSymbolKind, pathOfUri, toLspPosition, toMonacoRange, uriOfPath,
  type LspLocation, type LspRange,
} from './protocol';

interface LspDocumentSymbol { name: string; detail?: string; kind: number; range: LspRange; selectionRange: LspRange; children?: LspDocumentSymbol[] }
interface LspSymbolInformation { name: string; kind: number; containerName?: string; location: LspLocation }
export interface SymbolHit { name: string; container: string; path: string; line: number; column: number; kind: number }

/** Find References on a hot symbol answers thousands of places; the peek list is unusable past a few hundred. */
const MAX_REFERENCES = 500;

const LANGUAGES = ['php', 'typescript', 'javascript'];

export function registerNavigation(backend: CodeBackend, root: () => string, onError: (message: string) => void): monaco.IDisposable {
  const ask = async <T,>(model: monaco.editor.ITextModel, method: string, position?: monaco.Position, extra?: object): Promise<T | null> => {
    const path = model.uri.fsPath;
    const languageId = lspLanguage(path);
    if (!languageId) return null;
    try {
      return await backend.lsp<T>(root(), languageId, method, {
        textDocument: { uri: uriOfPath(path) },
        ...(position ? { position: toLspPosition(position) } : {}),
        ...extra,
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  const toLocations = (result: unknown): monaco.languages.Location[] =>
    locationsOf(result).slice(0, MAX_REFERENCES).map((l) => ({ uri: monaco.Uri.file(pathOfUri(l.uri)), range: toMonacoRange(l.range) }));

  const symbols = (list: LspDocumentSymbol[]): monaco.languages.DocumentSymbol[] => list.map((s) => ({
    name: s.name, detail: s.detail ?? '', kind: monacoSymbolKind(s.kind) as monaco.languages.SymbolKind, tags: [],
    range: toMonacoRange(s.range), selectionRange: toMonacoRange(s.selectionRange), children: symbols(s.children ?? []),
  }));

  const subs = [
    monaco.languages.registerDefinitionProvider(LANGUAGES, {
      provideDefinition: async (model, position) => toLocations(await ask(model, 'textDocument/definition', position)),
    }),
    monaco.languages.registerReferenceProvider(LANGUAGES, {
      provideReferences: async (model, position, context) =>
        toLocations(await ask(model, 'textDocument/references', position, { context: { includeDeclaration: context.includeDeclaration } })),
    }),
    monaco.languages.registerHoverProvider(LANGUAGES, {
      provideHover: async (model, position) => {
        const hover = await ask<{ contents: unknown; range?: LspRange }>(model, 'textDocument/hover', position);
        if (!hover) return null;
        return { contents: hoverMarkdown(hover.contents).map((value) => ({ value })), range: hover.range ? toMonacoRange(hover.range) : undefined };
      },
    }),
    monaco.languages.registerDocumentSymbolProvider(LANGUAGES, {
      provideDocumentSymbols: async (model) => {
        const list = await ask<Array<LspDocumentSymbol | LspSymbolInformation>>(model, 'textDocument/documentSymbol');
        if (!list?.length) return [];
        if ('location' in list[0]) { // the flat, pre-3.10 shape
          return (list as LspSymbolInformation[]).map((s) => ({
            name: s.name, detail: s.containerName ?? '', kind: monacoSymbolKind(s.kind) as monaco.languages.SymbolKind, tags: [],
            range: toMonacoRange(s.location.range), selectionRange: toMonacoRange(s.location.range),
          }));
        }
        return symbols(list as LspDocumentSymbol[]);
      },
    }),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}

/** `workspace/symbol` for the quick-open box (`#query`). Monaco has no UI of its own for it. */
export async function workspaceSymbols(backend: CodeBackend, root: string, languageId: string, query: string): Promise<SymbolHit[]> {
  const list = await backend.lsp<LspSymbolInformation[] | null>(root, languageId, 'workspace/symbol', { query });
  return (list ?? []).slice(0, 80).map((s) => {
    // Phpactor names a class by its full name (`Vendor\Pkg\Thing`): show the short name, keep the namespace beside it.
    const cut = s.name.lastIndexOf('\\');
    return {
    name: cut < 0 ? s.name : s.name.slice(cut + 1), container: s.containerName ?? (cut < 0 ? '' : s.name.slice(0, cut)), kind: s.kind,
    path: pathOfUri(s.location.uri), line: s.location.range.start.line + 1, column: s.location.range.start.character + 1,
    };
  });
}
