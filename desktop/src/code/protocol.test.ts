import { describe, expect, it } from 'vitest';
import {
  canGo, emptyHistory, go, hoverMarkdown, locationsOf, lspLanguage, monacoLanguage, monacoSymbolKind,
  pathOfUri, pillOf, progressOf, pushPlace, relativeTo, toLspPosition, toMonacoRange, uriOfPath,
} from './protocol';

const range = { start: { line: 4, character: 9 }, end: { line: 4, character: 21 } };

describe('code browser protocol', () => {
  it('converts positions and ranges between Monaco (1-based) and LSP (0-based)', () => {
    expect(toLspPosition({ lineNumber: 5, column: 10 })).toEqual({ line: 4, character: 9 });
    expect(toMonacoRange(range)).toEqual({ startLineNumber: 5, startColumn: 10, endLineNumber: 5, endColumn: 22 });
  });

  it('reads every shape a definition answer takes', () => {
    expect(locationsOf(null)).toEqual([]);
    expect(locationsOf({ uri: 'file:///a.php', range })).toEqual([{ uri: 'file:///a.php', range }]);
    expect(locationsOf([{ targetUri: 'file:///b.ts', targetRange: range, targetSelectionRange: { ...range, end: range.start } }]))
      .toEqual([{ uri: 'file:///b.ts', range: { ...range, end: range.start } }]);
  });

  it('turns hover contents into markdown', () => {
    expect(hoverMarkdown({ kind: 'markdown', value: '**x**' })).toEqual(['**x**']);
    expect(hoverMarkdown(['a', { language: 'php', value: 'function f()' }, null])).toEqual(['a', '```php\nfunction f()\n```']);
  });

  it('maps paths, URIs and languages', () => {
    expect(pathOfUri('file:///a/b%20c.php')).toBe('/a/b c.php');
    expect(uriOfPath('/a/b c.php')).toBe('file:///a/b%20c.php');
    expect(relativeTo('/r', '/r/src/a.ts')).toBe('src/a.ts');
    expect(relativeTo('/r', '/elsewhere/stub.php')).toBe('/elsewhere/stub.php');
    expect(monacoLanguage('/r/a.tsx')).toBe('typescript');
    expect(monacoLanguage('/r/Dockerfile')).toBe('dockerfile');
    expect(monacoLanguage('/r/LICENSE')).toBe('plaintext');
    expect(lspLanguage('/r/a.tsx')).toBe('typescriptreact');
    expect(lspLanguage('/r/a.php')).toBe('php');
    expect(lspLanguage('/r/a.go')).toBeUndefined();
    expect(monacoSymbolKind(5)).toBe(4);
  });

  it('keeps a back/forward history', () => {
    let h = pushPlace(emptyHistory, { path: '/a', line: 1, column: 1 });
    h = pushPlace(h, { path: '/a', line: 1, column: 7 }); // same line: not a new place
    h = pushPlace(h, { path: '/b', line: 3, column: 1 });
    expect(h.places).toHaveLength(2);
    expect(canGo(h, 1)).toBe(false);
    h = go(h, -1);
    expect(h.places[h.at].path).toBe('/a');
    h = pushPlace(h, { path: '/c', line: 1, column: 1 }); // a new jump drops the forward tail
    expect(h.places.map((p) => p.path)).toEqual(['/a', '/c']);
    expect(go(h, 5)).toBe(h);
  });
});

describe('status pills', () => {
  it('reads progress however the server words it', () => {
    expect(progressOf('1200/33000')).toBeCloseTo(0.036, 3);
    expect(progressOf('12 of 40 files (web)')).toBe(0.3);
    expect(progressOf('Indexing workspace')).toBeUndefined();
    expect(progressOf('0/0')).toBeUndefined();
  });

  it('says a server is busy, how far along, in a few words', () => {
    expect(pillOf({ server: 'phpactor', state: 'starting', message: '' })).toMatchObject({ label: 'PHP', detail: 'starting', busy: true });
    expect(pillOf({ server: 'phpactor', state: 'indexing', message: 'Indexing workspace' })).toMatchObject({ detail: 'indexing', progress: undefined });
    expect(pillOf({ server: 'phpactor', state: 'indexing', message: '300/1000' })).toMatchObject({ detail: 'indexing 30%', progress: 0.3 });
    expect(pillOf({ server: 'js/ts', state: 'ready', message: '' })).toMatchObject({ label: 'JS/TS', detail: '', busy: false });
    expect(pillOf({ server: 'phpactor', state: 'dead', message: 'exit 1' })).toMatchObject({ detail: 'stopped', failed: true });
  });

  it('names the PHP base by its branch', () => {
    expect(pillOf({ server: 'php base', state: 'indexing', message: 'Preparing develop… index 50/200' })).toMatchObject({ label: 'develop', detail: 'preparing 25%', busy: true });
    expect(pillOf({ server: 'php base', state: 'indexing', message: 'Preparing develop… starting' })).toMatchObject({ label: 'develop', detail: 'preparing' });
    expect(pillOf({ server: 'php base', state: 'ready', message: 'develop @ 2a579a2' })).toMatchObject({ label: 'develop @ 2a579a2', detail: '' });
  });
});
