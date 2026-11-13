/**
 * SPIKE (docs/spikes/code-browser.md). A read-only code browser over one worktree: file tree, Monaco,
 * quick open (⌘P files, ⌘T or `#` symbols), back/forward, and go to definition / find references / hover /
 * outline for PHP and JS/TS through the backend's language servers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangedFile, CodeBackend, LspStatus, TreeEntry } from './api';
import { defineStackTheme, modelLoader, monaco } from './monaco';
import { registerNavigation, workspaceSymbols, type SymbolHit } from './lsp';
import { canGo, emptyHistory, go, lspLanguage, monacoLanguage, pushPlace, relativeTo, toMonacoRange, type History, type Place } from './protocol';
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
  target?: { path: string; line?: number; tick: number };
}

type Hit = { type: 'file'; path: string } | ({ type: 'symbol' } & SymbolHit);

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
  // "Indexing…" is not a failure: it is said quietly, and withdrawn when the indexing ends.
  const setNotice = useCallback((text: string) => setNoticeText(text.replace(/^Error: /, '')), []);
  const waiting = /indexing|preparing/i.test(notice);
  const [palette, setPalette] = useState<null | { query: string }>(null);

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
  }, [root, initialFile, initialLine, loadDir, show]); // eslint-disable-line react-hooks/exhaustive-deps

  // A place asked for from outside (the Review): each new tick is one jump.
  useEffect(() => {
    if (!target || target.tick === consumedTick.current) return;
    consumedTick.current = target.tick;
    void show(target.path.startsWith('/') ? target.path : `${root}/${target.path}`, target.line);
  }, [target?.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Language servers' state, while the tab is visible.
  useEffect(() => {
    let alive = true;
    const tick = () => void backend.lspStatus().then((s) => {
      if (!alive) return;
      const mine = s.filter((x) => !x.root || x.root === root);
      setStatus(mine);
      if (!mine.some((x) => x.state === 'indexing' || x.state === 'starting')) setNoticeText((n) => (/indexing|preparing/i.test(n) ? '' : n));
    }).catch(() => {});
    tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [backend, root]);

  // ⌘P files, ⌘T symbols, ⌃- / ⌃⇧- back and forward (VS Code's keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); e.stopPropagation(); setPalette({ query: '' }); }
      else if (e.metaKey && e.key.toLowerCase() === 't') { e.preventDefault(); e.stopPropagation(); setPalette({ query: '#' }); }
      else if (e.ctrlKey && e.key === '-') { e.preventDefault(); travel(e.shiftKey ? 1 : -1); }
      else if (e.ctrlKey && e.key === '_') { e.preventDefault(); travel(1); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [travel]);

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
    <div className="code">
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
          <span className="code-status">
            {status.map((s) => (
              <span key={s.server} className={`code-pill is-${s.state}${s.server === 'php base' ? ' is-base' : ''}`} title={`${s.server}: ${s.state}${s.message ? ` — ${s.message}` : ''}${s.rssMb ? ` · ${s.rssMb} MB` : ''}${s.indexMs ? ` · indexed in ${(s.indexMs / 1000).toFixed(1)} s` : ''}`}>
                {s.server === 'php base'
                  ? s.message // "Preparing develop… 1200/33000", then "develop @ 1a2b3c4"
                  : <>{s.server}{s.state === 'indexing' ? ` · ${s.message || 'indexing…'}` : s.state === 'ready' ? '' : ` · ${s.state}`}</>}
              </span>
            ))}
          </span>
        </div>
        {notice && <div className={`code-notice${waiting ? ' is-waiting' : ''}`} role="status">{waiting ? `${notice} Navigation will work when it finishes.` : notice}</div>}
        <div className="code-editor" ref={hostRef} />
        {!active && <div className="code-empty">Pick a file, or press ⌘P. ⌘-click a symbol to go to its definition; ⇧F12 finds its references.</div>}
      </div>
      {palette && (
        <Palette
          backend={backend} root={root} initial={palette.query}
          languages={[...new Set([
            ...(active && lspLanguage(active) ? [lspLanguage(active)!.startsWith('php') ? 'php' : 'typescript'] : []),
            // Only servers that navigate: a linter is not asked for symbols (and must not start Phpactor).
            ...status.filter((s) => s.state !== 'dead').flatMap((s) => (
              s.server === 'typescript' || s.server === 'js/ts' ? ['typescript'] : s.server === 'phpactor' || s.server === 'intelephense' ? ['php'] : []
            )),
          ])]}
          onClose={() => { setPalette(null); editorRef.current?.focus(); }}
          onPick={(hit) => { setPalette(null); if (hit.type === 'file') void show(`${root}/${hit.path}`); else void show(hit.path, hit.line, hit.column); }}
        />
      )}
    </div>
  );
}

/**
 * ⌘P: files by fuzzy path. A leading `#` searches symbols in the language servers already running for this
 * worktree plus the one of the file being read (PHP when there is none): it never starts a server nobody needed.
 */
function Palette({ backend, root, initial, languages, onPick, onClose }: {
  backend: CodeBackend; root: string; initial: string; languages: string[];
  onPick: (hit: Hit) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(initial);
  const [hits, setHits] = useState<Hit[]>([]);
  const [index, setIndex] = useState(0);
  const [info, setInfo] = useState('');
  const symbolMode = query.startsWith('#');
  const symbolLanguages = useMemo(() => (languages.length ? languages : ['php']), [languages.join(' ')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      const t0 = performance.now();
      const done = (list: Hit[], extra: string) => { if (alive) { setHits(list); setIndex(0); setInfo(`${extra}${Math.round(performance.now() - t0)} ms`); } };
      if (symbolMode) {
        const q = query.slice(1).trim();
        if (!q) return done([], '');
        Promise.all(symbolLanguages.map((l) => workspaceSymbols(backend, root, l, q).catch(() => [])))
          .then((lists) => {
            // Exact and prefix matches of the name first, whichever server they came from.
            const rank = (name: string) => { const n = name.toLowerCase(), k = q.toLowerCase(); return n === k ? 0 : n.startsWith(k) ? 1 : 2; };
            const all = lists.flat().sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length);
            done(all.slice(0, 80).map((s) => ({ type: 'symbol' as const, ...s })), `${symbolLanguages.join(' + ')} symbols · `);
          });
      } else {
        backend.files(root, query)
          .then((r) => done(r.files.map((path) => ({ type: 'file' as const, path })), `${r.total.toLocaleString()} files · `))
          .catch((e) => { if (alive) setInfo(String(e instanceof Error ? e.message : e)); });
      }
    }, symbolMode ? 120 : 30);
    return () => { alive = false; clearTimeout(timer); };
  }, [backend, root, query, symbolMode, symbolLanguages]);

  return (
    <div className="code-palette-scrim" onMouseDown={onClose}>
      <div className="code-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus value={query} placeholder="File name — or #symbol" spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(hits.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter' && hits[index]) onPick(hits[index]);
          }}
        />
        <div className="code-palette-list">
          {hits.map((h, i) => {
            const path = h.type === 'file' ? h.path : relativeTo(root, h.path);
            const cut = path.lastIndexOf('/');
            return (
              <button key={`${path}:${h.type === 'symbol' ? `${h.name}:${h.line}` : ''}`} type="button" className={`code-hit${i === index ? ' is-active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => onPick(h)}>
                <span className="code-hit-name">{h.type === 'symbol' ? h.name : path.slice(cut + 1)}</span>
                <span className="code-hit-path">{h.type === 'symbol' ? `${h.container ? `${h.container} · ` : ''}${path}:${h.line}` : path.slice(0, Math.max(0, cut))}</span>
              </button>
            );
          })}
        </div>
        <div className="code-palette-info">{info}</div>
      </div>
    </div>
  );
}
