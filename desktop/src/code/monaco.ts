/**
 * SPIKE (docs/spikes/code-browser.md). Monaco, trimmed to what a read-only browser needs:
 * the editor API + its editor features, Monarch grammars for the languages we meet, and the one worker
 * every Monaco needs. No `languages/features/typescript` (the 6 MB in-browser TypeScript worker): JS/TS
 * navigation comes from a real language server, like PHP's (see lsp.ts).
 */
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/register.all.js';
import 'monaco-editor/languages/definitions/php/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/scss/register.js';
import 'monaco-editor/languages/definitions/less/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/twig/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import 'monaco-editor/languages/definitions/go/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/dockerfile/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

/**
 * Monaco standalone only resolves models that already exist, so a peek over files that were never opened
 * fails with "Model not found". This replaces its text-model service with one that loads the file on demand
 * (`modelLoader.load`, set by the browser). Services can only be overridden by the first call that touches
 * them, so this runs before anything else here does: a throwaway editor, created and dropped.
 */
export const modelLoader: { load?: (path: string) => Promise<monaco.editor.ITextModel> } = {};
monaco.editor.create(document.createElement('div'), { model: null }, {
  textModelService: {
    _serviceBrand: undefined,
    canHandleResource: () => true,
    registerTextModelContentProvider: () => ({ dispose: () => {} }),
    createModelReference: async (resource: monaco.Uri) => {
      const model = monaco.editor.getModel(resource) ?? (await modelLoader.load?.(resource.fsPath));
      if (!model) throw new Error('Model not found');
      const object = {
        textEditorModel: model,
        onWillDispose: model.onWillDispose.bind(model),
        resolve: async () => {},
        createSnapshot: () => model.createSnapshot(),
        isReadonly: () => true,
        isResolved: () => true,
        isDisposed: () => model.isDisposed(),
        getLanguageId: () => model.getLanguageId(),
        dispose: () => {},
      };
      return { object, dispose: () => {} };
    },
  },
}).dispose();

// JSON has no Monarch grammar in Monaco (its colouring ships with the JSON language service): a tiny one is enough to read.
monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc'] });
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/\/\/.*$/, 'comment'],
    ],
  },
});

(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

/**
 * A CSS colour (hex, rgb(), color-mix(), a var()) as `#rrggbbaa`, which is all Monaco's theme accepts:
 * painted on a canvas and read back, so whatever the engine can parse works.
 */
function hex(cssColor: string): string | undefined {
  const value = cssColor.trim();
  if (!value) return undefined;
  const probe = document.createElement('span');
  probe.style.color = value;
  if (!probe.style.color) return undefined;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  // Un-premultiply is not needed: a single fill on a clear canvas keeps straight colour values.
  return '#' + [r, g, b, a].map((n) => n.toString(16).padStart(2, '0')).join('');
}

/**
 * The editor in the app's own skin: the chrome's --app-* tokens for the surfaces, the generated
 * --vscode-editor-* variables (theme/vscode-theme.css) for what the chrome has no token for.
 */
export function defineStackTheme(): void {
  const css = getComputedStyle(document.documentElement);
  const v = (...names: string[]): string | undefined => {
    for (const n of names) { const c = hex(css.getPropertyValue(n)); if (c) return c; }
    return undefined;
  };
  const colors: Record<string, string> = {};
  const set = (key: string, ...names: string[]) => { const c = v(...names); if (c) colors[key] = c; };
  set('editor.background', '--app-bg', '--vscode-editor-background');
  set('editor.foreground', '--vscode-editor-foreground', '--app-text');
  set('editorLineNumber.foreground', '--app-text-faint');
  set('editorLineNumber.activeForeground', '--app-text');
  set('editorCursor.foreground', '--app-accent');
  set('editor.lineHighlightBackground', '--app-hover');
  set('editor.selectionBackground', '--vscode-editor-selectionBackground');
  set('editorWidget.background', '--app-surface');
  set('editorWidget.border', '--app-border-strong');
  set('editorHoverWidget.background', '--app-surface');
  set('editorHoverWidget.border', '--app-border-strong');
  set('peekView.border', '--app-accent');
  set('peekViewEditor.background', '--app-surface');
  set('peekViewResult.background', '--app-bg');
  set('peekViewTitle.background', '--app-surface');
  set('editorStickyScroll.background', '--app-bg');
  set('scrollbarSlider.background', '--app-hover');
  set('focusBorder', '--app-focus');
  monaco.editor.defineTheme('stack', { base: 'vs-dark', inherit: true, rules: [], colors });
}

export { monaco };
