/**
 * SPIKE (docs/spikes/code-browser.md). A read-only code browser over one worktree: file tree, Monaco,
 * quick open (⌘P files, ⌘T or `#` symbols), back/forward, and go to definition / find references / hover /
 * outline for PHP and JS/TS through the backend's language servers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangedFile, CodeBackend, LspStatus, TextHit, TreeEntry } from './api';
import { codeActionOf, doubleShift } from './keymap';
import { defineStackTheme, modelLoader, monaco } from './monaco';
import { registerNavigation, workspaceSymbols, type SymbolHit } from './lsp';
import { canGo, emptyHistory, go, lspLanguage, monacoLanguage, pillOf, pushPlace, relativeTo, toMonacoRange, type History, type Place } from './protocol';
import './code.css';

interface Props {
  backend: CodeBackend;
  /** The worktree. Everything shown is inside it (or a read-only dependency the backend allows). */
  root: string;
  initialFile?: string;
  initialLine?: number;
  /** The files the task changed, listed above the tree. The browser opens on the first one. */
  changed?: ChangedFile[];
  /** "Show this place": a new `tick` jumps there (a click on a file or a line in the Review). */
  target?: { path?: string; line?: number; search?: boolean; tick: number };
}

type Hit = { type: 'file'; path: string } | ({ type: 'symbol' } & SymbolHit) | ({ type: 'text' } & TextHit);

/** What the palette searches: file names (with `#` for symbols), the text of every file, or the files read lately. */
type PaletteMode = 'files' | 'text' | 'recent';

/** PhpStorm's editor keys (keymap.ts EDITOR_KEYS), bound once for every editor. */
let editorKeysBound = false;
function bindEditorKeys(): void {
  if (editorKeysBound) return;
  editorKeysBound = true;
  const { KeyMod: M, KeyCode: K } = monaco;
  monaco.editor.addKeybindingRules([
    { keybinding: M.CtrlCmd | K.KeyB, command: 'editor.action.revealDefinition', when: 'editorTextFocus' },
    { keybinding: M.CtrlCmd | K.KeyY, command: 'editor.action.peekDefinition', when: 'editorTextFocus' },
    { keybinding: M.Alt | K.F7, command: 'editor.action.goToReferences', when: 'editorTextFocus' },
    { keybinding: M.Alt | M.CtrlCmd | K.F7, command: 'editor.action.referenceSearch.trigger', when: 'editorTextFocus' },
    { keybinding: K.F1, command: 'editor.action.showHover', when: 'editorTextFocus' },
    { keybinding: M.WinCtrl | K.KeyJ, command: 'editor.action.showHover', when: 'editorTextFocus' },
    { keybinding: M.CtrlCmd | K.KeyL, command: 'editor.action.gotoLine', when: 'editorTextFocus' },
    { keybinding: M.CtrlCmd | K.F12, command: 'editor.action.quickOutline', when: 'editorTextFocus' },
    { keybinding: M.Alt | K.UpArrow, command: 'editor.action.smartSelect.expand', when: 'editorTextFocus' },
    { keybinding: M.Alt | K.DownArrow, command: 'editor.action.smartSelect.shrink', when: 'editorTextFocus' },
    { keybinding: K.F2, command: 'editor.action.marker.next', when: 'editorTextFocus' },
    { keybinding: M.Shift | K.F2, command: 'editor.action.marker.prev', when: 'editorTextFocus' },
  ]);
}

export function CodeBrowser({ backend, root, initialFile, initialLine, changed, target }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, Promise<monaco.editor.ITextModel>>());
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const linted = useRef(new WeakSet<monaco.editor.ITextModel>());
  const consumedTick = useRef<number | undefined>(undefined);
  const rootRef = useRef(root);
  rootRef.current = root;

  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const [history, setHistory] = useState<History>(emptyHistory);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [dirs, setDirs] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<LspStatus[]>([]);
  const [notice, setNoticeText] = useState('');
  /** Bumped when a navigation hit a server still starting or indexing: the busy pills pulse, nothing else is said. */
  const [nudge, setNudge] = useState(0);
  // "Indexing…" is not a failure: the pills already say it. Only a real problem is shown, in the bar.
  const setNotice = useCallback((text: string) => {
    const t = text.replace(/^Error: /, '');
    if (/^(indexing|preparing)\b/i.test(t)) setNudge((n) => n + 1);
    else setNoticeText(t);
  }, []);
  const [palette, setPalette] = useState<null | { query: string; mode?: PaletteMode }>(null);
  const outerRef = useRef<HTMLDivElement>(null);

  const ensureModel = useCallback((path: string): Promise<monaco.editor.ITextModel> => {
    let hit = models.current.get(path);
    if (!hit) {
      hit = backend.file(path).then((f) => {
        const text = f.binary ? '(binary file)' : f.tooLarge ? `(file too large to show: ${Math.round(f.size / 1024)} KB)` : f.text;
        const uri = monaco.Uri.file(path);
        return monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, f.binary || f.tooLarge ? 'plaintext' : monacoLanguage(path), uri);
      });
      hit.catch(() => models.current.delete(path));
      models.current.set(path, hit);
    }
    return hit;
  }, [backend]);

  const loadDir = useCallback(async (dir: string) => {
    const entries = await backend.tree(dir);
    setDirs((d) => ({ ...d, [dir]: entries }));
  }, [backend]);

  /** Shows a file, optionally at a place. `record`: a jump the user can come back from. */
  const show = useCallback(async (path: string, line?: number, column?: number, record = true) => {
    let model: monaco.editor.ITextModel;
    try { model = await ensureModel(path); } catch (e) { setNotice(`${relativeTo(rootRef.current, path)}: ${e instanceof Error ? e.message : String(e)}`); return; }
    const editor = editorRef.current; // read after the wait: the editor may have been replaced meanwhile
    if (!editor || model.isDisposed()) return;
    const from = activeRef.current;
    const at = editor.getPosition();
    if (from) viewStates.current.set(from, editor.saveViewState());
    if (editor.getModel() !== model) editor.setModel(model);
    if (line) {
      editor.setPosition({ lineNumber: line, column: column ?? 1 });
      editor.revealLineInCenterIfOutsideViewport(line);
    } else {
      const state = viewStates.current.get(path);
      if (state) editor.restoreViewState(state);
    }
    editor.focus();
    // Lint squiggles for JS/TS (oxlint through the backend). Once per model: the file is read-only here.
    const lang = lspLanguage(path);
    if (lang && !linted.current.has(model)) {
      linted.current.add(model);
      void backend.lint(rootRef.current, path).then(({ diagnostics }) => {
        if (model.isDisposed()) return;
        monaco.editor.setModelMarkers(model, 'oxlint', diagnostics.map((d) => ({
          ...toMonacoRange(d.range),
          message: d.message,
          code: d.code === undefined ? undefined : String(d.code),
          source: d.source ?? (lang === 'php' ? 'php' : 'oxlint'),
          // LSP: 1 error, 2 warning, 3 info, 4 hint.
          severity: d.severity === 1 ? monaco.MarkerSeverity.Error : d.severity === 2 ? monaco.MarkerSeverity.Warning : d.severity === 3 ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Hint,
        })));
      }).catch(() => { linted.current.delete(model); });
    }
    activeRef.current = path;
    setActive(path);
    setNotice('');
    if (record) {
      setHistory((h) => {
        const withOrigin = from && at ? pushPlace(h, { path: from, line: at.lineNumber, column: at.column }) : h;
        return pushPlace(withOrigin, { path, line: line ?? 1, column: column ?? 1 });
      });
    }
    // Reveal it in the tree: open every ancestor directory inside the root.
    if (path.startsWith(rootRef.current + '/')) {
      const parts = path.slice(rootRef.current.length + 1).split('/').slice(0, -1);
      const ancestors = parts.map((_, i) => `${rootRef.current}/${parts.slice(0, i + 1).join('/')}`);
      setExpanded((s) => new Set([...s, ...ancestors]));
      for (const dir of ancestors) void loadDir(dir).catch(() => {});
    }
  }, [backend, ensureModel, loadDir]);

  const travel = useCallback((delta: number) => {
    const h = historyRef.current;
    if (!canGo(h, delta)) return;
    const next = go(h, delta);
    setHistory(next);
    const p: Place = next.places[next.at];
    void show(p.path, p.line, p.column, false);
  }, [show]);

  // The editor, once.
  useEffect(() => {
    if (!hostRef.current) return;
    defineStackTheme();
    bindEditorKeys();
    const css = getComputedStyle(document.documentElement);
    const editor = monaco.editor.create(hostRef.current, {
      readOnly: true,
      domReadOnly: true,
      renderValidationDecorations: 'on', // Monaco hides squiggles in read-only editors unless told otherwise
      theme: 'stack',
      automaticLayout: true,
      fontFamily: css.getPropertyValue('--vscode-editor-font-family').trim() || 'Menlo, Monaco, monospace',
      fontSize: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      stickyScroll: { enabled: true },
      // Navigation: ⌘-click and F12 go to the definition; with several, a peek.
      gotoLocation: { multiple: 'peek', multipleReferences: 'peek' },
      definitionLinkOpensInPeek: false,
      contextmenu: true,
      model: null,
    });
    modelLoader.load = ensureModel; // files a peek shows before they were ever opened
    editorRef.current = editor;
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor: (_source, resource, at) => {
        const line = at ? ('startLineNumber' in at ? at.startLineNumber : at.lineNumber) : undefined;
        const column = at ? ('startColumn' in at ? at.startColumn : at.column) : undefined;
        void show(resource.fsPath, line, column);
        return true;
      },
    });
    const nav = registerNavigation(backend, () => rootRef.current, setNotice);
    return () => { nav.dispose(); opener.dispose(); editor.dispose(); editorRef.current = null; };
  }, [backend, ensureModel, show]);

  // A new root: forget the previous one's files.
  useEffect(() => {
    for (const p of models.current.values()) void p.then((m) => m.dispose()).catch(() => {});
    models.current.clear();
    viewStates.current.clear();
    activeRef.current = null;
    setActive(null);
    setHistory(emptyHistory);
    setDirs({});
    setExpanded(new Set());
    void loadDir(root).catch((e) => setNotice(String(e)));
    // Opened from a place in the Review: there. Else the first file the task changed.
    consumedTick.current = target?.tick;
    const first = initialFile ?? target?.path ?? changed?.find((c) => c.status !== 'D')?.path;
    if (first) void show(first.startsWith('/') ? first : `${root}/${first}`, initialFile ? initialLine : target?.line);
    if (target?.search) setPalette({ query: '', mode: 'text' });
  }, [root, initialFile, initialLine, loadDir, show]); // eslint-disable-line react-hooks/exhaustive-deps

  // A place asked for from outside (the Review): each new tick is one jump.
  useEffect(() => {
    if (!target || target.tick === consumedTick.current) return;
    consumedTick.current = target.tick;
    if (target.path) void show(target.path.startsWith('/') ? target.path : `${root}/${target.path}`, target.line);
    if (target.search) setPalette({ query: '', mode: 'text' });
  }, [target?.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Language servers' state, while the tab is visible.
  useEffect(() => {
    let alive = true;
    const tick = () => void backend.lspStatus().then((s) => {
      if (!alive) return;
      const mine = s.filter((x) => !x.root || x.root === root);
      setStatus(mine);
    }).catch(() => {});
    tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [backend, root]);

  // PhpStorm's keys (keymap.ts), plus VS Code's ⌘P / ⌘T / ⌃-. Only while this tab is the one showing.
  useEffect(() => {
    const showing = () => !!outerRef.current && !outerRef.current.closest('[hidden]') && outerRef.current.offsetParent !== null;
    const selection = () => {
      const ed = editorRef.current;
      const sel = ed?.getSelection();
      const text = sel && !sel.isEmpty() ? ed?.getModel()?.getValueInRange(sel) ?? '' : '';
      return text.includes('\n') ? '' : text;
    };
    const shifts = doubleShift();
    const onKey = (e: KeyboardEvent) => {
      if (!showing()) return;
      if (e.type === 'keyup' || e.key === 'Shift') {
        if (shifts(e, performance.now())) setPalette((p) => p ?? { query: '' }); // ⇧⇧ Search Everywhere
        return;
      }
      shifts(e, performance.now());
      if (e.type !== 'keydown') return;
      const action = codeActionOf(e);
      if (!action) return;
      // ⌘F: the editor's own find widget when it has focus; from anywhere else in the tab, give it focus first.
      if (action === 'find-in-file') {
        const ed = editorRef.current;
        if (!ed || ed.hasTextFocus() || !ed.getModel()) return;
        e.preventDefault();
        e.stopPropagation();
        ed.focus();
        void ed.getAction('actions.find')?.run();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (action === 'back' || action === 'forward') travel(action === 'back' ? -1 : 1);
      else if (action === 'go-to-file') setPalette({ query: '' });
      else if (action === 'go-to-symbol') setPalette({ query: `#${selection()}` });
      else if (action === 'find-in-path') setPalette({ query: selection(), mode: 'text' });
      else if (action === 'recent-files') setPalette({ query: '', mode: 'recent' });
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true); };
  }, [travel]);
  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...history.places].reverse()) if (!seen.has(p.path) && p.path !== active) { seen.add(p.path); out.push(p.path); }
    return active ? [active, ...out] : out;
  }, [history, active]);

  const toggle = (dir: string) => {
    setExpanded((s) => { const n = new Set(s); if (n.has(dir)) n.delete(dir); else n.add(dir); return n; });
    if (!dirs[dir]) void loadDir(dir).catch((e) => setNotice(String(e)));
  };

  const renderDir = (dir: string, depth: number): JSX.Element[] => (dirs[dir] ?? []).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    const isOpen = expanded.has(path);
    const row = (
      <button
        key={path} type="button" className={`code-row${path === active ? ' is-active' : ''}`} style={{ paddingLeft: 8 + depth * 12 }}
        title={relativeTo(root, path)} onClick={() => (e.dir ? toggle(path) : void show(path))}
      >
        <i className={`codicon codicon-${e.dir ? (isOpen ? 'chevron-down' : 'chevron-right') : 'file'}`} aria-hidden="true" />
        <span className="code-row-name">{e.name}</span>
      </button>
    );
    return e.dir && isOpen ? [row, ...renderDir(path, depth + 1)] : [row];
  });

  return (
    <div className="code" ref={outerRef}>
      <div className="code-side">
        {!!changed?.length && (
          <div className="code-changed" aria-label="Changed files">
            <div className="code-side-title">Changed <span>{changed.length}</span></div>
            {[...changed].sort((a, b) => Number(a.status === 'D') - Number(b.status === 'D')).map((c) => {
              const path = `${root}/${c.path}`;
              const cut = c.path.lastIndexOf('/');
              return (
                <button key={c.path} type="button" className={`code-row${path === active ? ' is-active' : ''}`} style={{ paddingLeft: 8 }} disabled={c.status === 'D'} title={c.path} onClick={() => void show(path)}>
                  <span className={`code-status-letter is-${c.status}`} aria-label={c.status === 'A' ? 'added' : c.status === 'D' ? 'deleted' : c.status === 'R' ? 'renamed' : 'modified'}>{c.status}</span>
                  <span className="code-row-name">{c.path.slice(cut + 1)}</span>
                  <span className="code-row-dir">{c.path.slice(0, Math.max(0, cut))}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="code-side-title">Files</div>
        <div className="code-tree" role="tree" aria-label="Files">{renderDir(root, 0)}</div>
      </div>
      <div className="code-main">
        <div className="code-bar">
          <button type="button" className="icon-btn" title="Back (⌃-)" aria-label="Back" disabled={!canGo(history, -1)} onClick={() => travel(-1)}><i className="codicon codicon-arrow-left" aria-hidden="true" /></button>
          <button type="button" className="icon-btn" title="Forward (⌃⇧-)" aria-label="Forward" disabled={!canGo(history, 1)} onClick={() => travel(1)}><i className="codicon codicon-arrow-right" aria-hidden="true" /></button>
          <button type="button" className="code-path" title="Go to file (⌘P)" onClick={() => setPalette({ query: '' })}>
            {active ? relativeTo(root, active) : 'Go to file… ⌘P'}
          </button>
          {notice && (
            <button type="button" className="code-bar-error" role="alert" title={`${notice}\n\nClick to dismiss.`} onClick={() => setNoticeText('')}>
              <i className="codicon codicon-warning" aria-hidden="true" />{notice}
            </button>
          )}
          <span className="code-status" role="status" aria-live="polite">
            {status.map((s) => {
              const p = pillOf(s);
              const why = p.busy ? `\nNavigation for ${p.label} works once this finishes.` : '';
              return (
                <span
                  key={`${s.server}:${nudge && p.busy ? nudge : 0}`}
                  className={`code-pill is-${s.state}${s.server === 'php base' ? ' is-base' : ''}${p.busy && nudge ? ' is-nudged' : ''}`}
                  style={p.progress !== undefined ? ({ '--p': p.progress } as React.CSSProperties) : undefined}
                  title={`${s.server}: ${s.state}${s.message ? ` — ${s.message}` : ''}${s.rssMb ? ` · ${s.rssMb} MB` : ''}${s.indexMs ? ` · indexed in ${(s.indexMs / 1000).toFixed(1)} s` : ''}${why}`}
                >
                  <span className="code-pill-dot" aria-hidden="true" />
                  {p.label}
                  {p.detail && <span className="code-pill-detail">{p.detail}</span>}
                </span>
              );
            })}
          </span>
        </div>
        <div className="code-editor" ref={hostRef} />
        {!active && <div className="code-empty">Pick a file, or press ⌘P. ⌘-click a symbol to go to its definition; ⇧F12 finds its references.</div>}
      </div>
      {palette && (
        <Palette
          backend={backend} root={root} initial={palette.query} mode={palette.mode ?? 'files'} recent={recent}
          languages={[...new Set([
            ...(active && lspLanguage(active) ? [lspLanguage(active)!.startsWith('php') ? 'php' : 'typescript'] : []),
            // Only servers that navigate: a linter is not asked for symbols (and must not start Phpactor).
            ...status.filter((s) => s.state !== 'dead').flatMap((s) => (
              s.server === 'typescript' || s.server === 'js/ts' ? ['typescript'] : s.server === 'phpactor' || s.server === 'intelephense' ? ['php'] : []
            )),
          ])]}
          onClose={() => { setPalette(null); editorRef.current?.focus(); }}
          onPick={(hit) => {
            setPalette(null);
            if (hit.type === 'file') void show(hit.path.startsWith('/') ? hit.path : `${root}/${hit.path}`);
            else if (hit.type === 'text') void show(`${root}/${hit.path}`, hit.line, hit.column);
            else void show(hit.path, hit.line, hit.column);
          }}
        />
      )}
    </div>
  );
}

/**
 * The palette. Files by fuzzy path (⌘P, ⇧⌘O, ⇧⇧); a leading `#` searches symbols (⌘O, ⌘T) in the language servers
 * already running for this worktree plus the one of the file being read (PHP when there is none): it never starts
 * a server nobody needed. `text` mode is Find in Path (⇧⌘F); `recent` lists the files read lately (⌘E).
 */
function Palette({ backend, root, initial, mode, recent, languages, onPick, onClose }: {
  backend: CodeBackend; root: string; initial: string; mode: PaletteMode; recent: string[]; languages: string[];
  onPick: (hit: Hit) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(initial);
  const [hits, setHits] = useState<Hit[]>([]);
  const [index, setIndex] = useState(0);
  const [info, setInfo] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const symbolMode = mode === 'files' && query.startsWith('#');
  const symbolLanguages = useMemo(() => (languages.length ? languages : ['php']), [languages.join(' ')]); // eslint-disable-line react-hooks/exhaustive-deps
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const t0 = performance.now();
    const done = (list: Hit[], extra: string) => { if (alive) { setHits(list); setIndex(0); setInfo(`${extra}${Math.round(performance.now() - t0)} ms`); } };
    const fail = (e: unknown) => { if (alive) { setHits([]); setInfo(String(e instanceof Error ? e.message : e).replace(/^Error: /, '')); } };
    const run = () => {
      if (mode === 'recent') {
        const q = query.trim().toLowerCase();
        const list = recent.filter((p) => !q || relativeTo(root, p).toLowerCase().includes(q));
        if (alive) { setHits(list.map((path) => ({ type: 'file' as const, path }))); setIndex(list.length > 1 && !q ? 1 : 0); setInfo('Recent files'); }
      } else if (mode === 'text') {
        if (query.length < 2) { if (alive) { setHits([]); setInfo('Type at least 2 characters'); } return; }
        backend.search(root, query, { caseSensitive, wholeWord })
          .then((r) => done(r.hits.map((h) => ({ type: 'text' as const, ...h })), `${r.hits.length}${r.truncated ? '+' : ''} match${r.hits.length === 1 ? '' : 'es'} · `))
          .catch(fail);
      } else if (symbolMode) {
        const q = query.slice(1).trim();
        if (!q) { done([], ''); return; }
        Promise.all(symbolLanguages.map((l) => workspaceSymbols(backend, root, l, q).catch(() => [])))
          .then((lists) => {
            // Exact and prefix matches of the name first, whichever server they came from.
            const rank = (name: string) => { const n = name.toLowerCase(), k = q.toLowerCase(); return n === k ? 0 : n.startsWith(k) ? 1 : 2; };
            const all = lists.flat().sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length);
            done(all.slice(0, 80).map((sym) => ({ type: 'symbol' as const, ...sym })), `${symbolLanguages.join(' + ')} symbols · `);
          });
      } else {
        backend.files(root, query)
          .then((r) => done(r.files.map((path) => ({ type: 'file' as const, path })), `${r.total.toLocaleString()} files · `))
          .catch(fail);
      }
    };
    const timer = setTimeout(run, mode === 'text' ? 220 : symbolMode ? 120 : mode === 'recent' ? 0 : 30);
    return () => { alive = false; clearTimeout(timer); };
  }, [backend, root, query, mode, recent, symbolMode, symbolLanguages, caseSensitive, wholeWord]);

  useEffect(() => { listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [index]);

  const placeholder = mode === 'text' ? 'Find in path' : mode === 'recent' ? 'Recent files' : 'File name — or #symbol';
  return (
    <div className="code-palette-scrim" onMouseDown={onClose}>
      <div className={`code-palette is-${mode}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="code-palette-input">
          <input
            autoFocus value={query} placeholder={placeholder} spellCheck={false}
            onFocus={(e) => { if (mode === 'text') e.currentTarget.select(); }}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(hits.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (e.key === 'Enter' && hits[index]) onPick(hits[index]);
              else if (mode === 'text' && e.altKey && e.code === 'KeyC') { e.preventDefault(); setCaseSensitive((v) => !v); }
              else if (mode === 'text' && e.altKey && e.code === 'KeyW') { e.preventDefault(); setWholeWord((v) => !v); }
            }}
          />
          {mode === 'text' && (
            <span className="code-palette-toggles">
              <button type="button" className={`code-toggle${caseSensitive ? ' is-on' : ''}`} title="Match case (⌥C)" aria-pressed={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>Aa</button>
              <button type="button" className={`code-toggle${wholeWord ? ' is-on' : ''}`} title="Words (⌥W)" aria-pressed={wholeWord} onClick={() => setWholeWord((v) => !v)}>W</button>
            </span>
          )}
        </div>
        <div className="code-palette-list" ref={listRef}>
          {hits.map((h, i) => {
            const path = h.type === 'symbol' || (h.type === 'file' && h.path.startsWith('/')) ? relativeTo(root, h.path) : h.path;
            const cut = path.lastIndexOf('/');
            const key = h.type === 'symbol' ? `${path}:${h.name}:${h.line}` : h.type === 'text' ? `${path}:${h.line}:${h.column}` : path;
            return (
              <button key={key} type="button" className={`code-hit${h.type === 'text' ? ' is-text' : ''}${i === index ? ' is-active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => onPick(h)}>
                {h.type === 'text' ? (
                  <>
                    <span className="code-hit-line"><Marked text={h.text} query={query} caseSensitive={caseSensitive} /></span>
                    <span className="code-hit-path">{path.slice(cut + 1)}:{h.line}</span>
                  </>
                ) : (
                  <>
                    <span className="code-hit-name">{h.type === 'symbol' ? h.name : path.slice(cut + 1)}</span>
                    <span className="code-hit-path">{h.type === 'symbol' ? `${h.container ? `${h.container} · ` : ''}${path}:${h.line}` : path.slice(0, Math.max(0, cut))}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
        <div className="code-palette-info">{info}</div>
      </div>
    </div>
  );
}

/** A matching line with its matches highlighted, leading indentation dropped. */
function Marked({ text, query, caseSensitive }: { text: string; query: string; caseSensitive: boolean }) {
  const line = text.replace(/^\s+/, '');
  if (!query) return <>{line}</>;
  const hay = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = hay.indexOf(needle); i !== -1 && parts.length < 40; i = hay.indexOf(needle, i + needle.length)) {
    if (i > at) parts.push(line.slice(at, i));
    parts.push(<mark key={i}>{line.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  parts.push(line.slice(at));
  return <>{parts}</>;
}
