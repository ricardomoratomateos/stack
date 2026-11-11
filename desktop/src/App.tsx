import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nameOf } from '@core/webview/derive';
import { buildView, floatRows, managerSession, pickSession, resolveShortcut, sessionRows, shortcutOf, stateWord, type Effect } from './model';
import { StartStackd } from './stackd/StartStackd';
import { useStackd } from './stackd/useStackd';
import { ManagerStrip, useTerminals, type StripHandle } from './terminals';
import { SidebarHost } from './sidebar/SidebarHost';
import { ViewTitle } from './sidebar/ViewTitle';
import { describeCounts, installHint, toSidebarState, translate, type Action } from './sidebar/bridge';
import { loadDefaultProvider, saveDefaultProvider } from './sidebar/prefs';
import { NewTaskHost } from './newtask/NewTaskHost';
import { toNewTaskInit, translateNewTask } from './newtask/bridge';
import { invoke } from '@tauri-apps/api/core';
import type { NewTaskExtMessage, NewTaskInit, NewTaskMessage } from '@core/newtask/types';
import type { ProviderId } from '@core/ports/IAgentProvider';
import { loadSidebarStyle, resolveSidebarStyle } from './sidebar/settings';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { SettingsHost } from './settings/SettingsHost';
import { Dialog, type DialogSpec } from './ui/Dialog';
import type { SidebarStyle } from '@core/sidebarStyle';
import type { WebMessage } from '@core/webview/types';
import { SessionView } from './ui/Pane';
import { useSessionPane } from './ui/useSessionPane';
import { Splitter } from './ui/Splitter';
import { ModeSwitch } from './ui/ModeSwitch';
import { FloatList } from './ui/FloatList';
import {
  LINE_H, cycleMaximized, heightFromLines, limits, linesFromHeight, loadLayout, maxPanelWidth, modeFromQuery, nextMode,
  resetSize, resize, saveLayout, setMode, toggleMaximized, DEFAULT_SIZES, type LayoutState, type Maximized, type Mode,
} from './modes/layout';
import { applyWindowMode, loadFrames, saveFrames, windowFrame, type Frames } from './modes/windowApi';
import { useShell } from './notify/useShell';
import { needsOf } from './notify/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';

const initialLayoutState = (): LayoutState => {
  const l = loadLayout();
  const q = modeFromQuery(location.search);
  return q ? setMode(l, q) : l;
};

const ADD_REPO = '\0add-repository';

export const NOT_RUNNING = 'stackd not running — start it from the app (Start stackd now / at login), or enable stack.useDaemon in VS Code.';

export function App() {
  const { running, socket, snapshot, api } = useStackd();
  const { registry, panes } = useTerminals();
  const [repoRoot, setRepoRoot] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [remembered, setRemembered] = useState<Record<string, number>>({});
  const [managerOpen, setManagerOpen] = useState(true);
  const [layout, setLayout] = useState<LayoutState>(initialLayoutState);
  const [maximized, setMaximized] = useState<Maximized>(null);
  const [stripExpanded, setStripExpanded] = useState(false);
  const [appWidth, setAppWidth] = useState(1200);
  const appRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<StripHandle>(null);
  const { mode, side } = layout;
  const sizes = layout.sizes[mode];
  const [focusTick, setFocusTick] = useState(0);
  const [sessionOf, setSessionOf] = useState<Record<string, string>>({});
  const [style, setStyle] = useState<SidebarStyle>('aside');
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [notice, setNotice] = useState('');
  const [defaultProvider, setDefaultProvider] = useState<ProviderId | undefined>(loadDefaultProvider);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const postToNewTask = useRef<((msg: NewTaskExtMessage) => void) | null>(null);
  const registerPost = useCallback((post: ((msg: NewTaskExtMessage) => void) | null) => { postToNewTask.current = post; }, []);

  useEffect(() => { void loadSidebarStyle().then(setStyle); }, []);
  useEffect(() => saveLayout(layout), [layout]);
  // ⌘, opens the Settings screen (capture phase, so it wins over the focused terminal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ',' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // The OS window follows the mode. Frames of Full and Float are remembered; Half snaps to the screen.
  const frames = useRef<Frames>(loadFrames());
  const applying = useRef(0);
  const prevMode = useRef<Mode | null>(null);
  useEffect(() => {
    const prev = prevMode.current;
    prevMode.current = mode;
    setMaximized(null);
    setStripExpanded(false);
    let live = true;
    void (async () => {
      applying.current = Date.now();
      try {
        if (prev && prev !== mode && prev !== 'half') {
          frames.current = { ...frames.current, [prev]: await windowFrame() };
          saveFrames(frames.current);
        }
        if (live) await applyWindowMode(mode, side, mode === 'half' ? undefined : frames.current[mode]);
      } catch (e) {
        if (!/invoke|__TAURI/.test(String(e))) console.error('window mode', e); // no Tauri in the browser dev server
      } finally {
        applying.current = Date.now();
      }
    })();
    return () => { live = false; };
  }, [mode, side]);
  // Float remembers where the user put it and how big.
  useEffect(() => {
    if (mode !== 'float') return;
    let timer = 0;
    const save = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (Date.now() - applying.current < 600) return;
        void windowFrame().then((f) => { frames.current = { ...frames.current, float: f }; saveFrames(frames.current); }).catch(() => {});
      }, 300);
    };
    let offs: Promise<() => void>[] = [];
    try {
      const w = getCurrentWindow();
      offs = [w.onResized(save), w.onMoved(save)];
    } catch { /* not in Tauri */ }
    return () => { clearTimeout(timer); offs.forEach((p) => void p.then((off) => off()).catch(() => {})); };
  }, [mode]);
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setAppWidth(el.clientWidth)); });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [running, snapshot !== null]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const view = useMemo(() => buildView(snapshot, repoRoot), [snapshot, repoRoot]);
  const items = view?.items;
  const selected = items?.find((d) => d.wt.id === selectedId) ?? items?.[0];
  const selectedIndex = selected ? pickSession(selected.wt, remembered[selected.wt.id]) : undefined;

  const select = useCallback((id: string, index?: number) => {
    setSelectedId(id);
    if (index !== undefined) setRemembered((r) => ({ ...r, [id]: index }));
  }, []);

  // Centre: the selected session. Right: the Manager.
  const centreTarget = useMemo(
    () => (selected && selectedIndex !== undefined ? { worktreeId: selected.wt.id, index: selectedIndex } : null),
    [selected?.wt.id, selectedIndex], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const mgr = managerSession(view?.control?.wt);
  const managerTarget = useMemo(
    () => (view?.control && mgr ? { worktreeId: view.control.wt.id, index: mgr.index } : null),
    [view?.control?.wt.id, mgr?.index], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const onSession = useCallback((id: string, session: string) => setSessionOf((m) => (m[id] === session ? m : { ...m, [id]: session })), []);
  const centre = useSessionPane(centreTarget, onSession);
  const managerWanted = mode !== 'full' || managerOpen || maximized === 'manager';
  const manager = useSessionPane(managerWanted ? managerTarget : null, onSession);

  // Shortcuts. Capture phase, so they win over the focused terminal.
  const latest = useRef({ items, selectedId: selected?.wt.id, mode, expanded: stripExpanded || maximized === 'manager' });
  latest.current = { items, selectedId: selected?.wt.id, mode, expanded: stripExpanded || maximized === 'manager' };
  const runEffect = useCallback((fx: Effect) => {
    if (fx.select) select(fx.select);
    if (fx.toggleManager) {
      if (latest.current.mode === 'full') setManagerOpen((o) => !o);
      else setStripExpanded((x) => !x);
    }
    if (fx.cycleMode) setLayout((l) => setMode(l, nextMode(l.mode)));
    if (fx.maximize) setMaximized((m) => cycleMaximized(m, latest.current.mode));
    if (fx.focusManager) {
      if (latest.current.mode === 'full') setManagerOpen(true);
      if (latest.current.mode === 'full' || latest.current.expanded) setFocusTick((t) => t + 1);
      else stripRef.current?.focus();
    }
  }, [select]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sc = shortcutOf(e);
      if (!sc) return;
      e.preventDefault();
      e.stopPropagation();
      runEffect(resolveShortcut(sc, latest.current.items ?? [], latest.current.selectedId));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [runEffect]);

  // Notifications, menu-bar item and global shortcuts (⌃⌥⌘J / M / S): they may point at a worktree of another repo.
  const selectAnywhere = useCallback((id: string) => {
    const repo = snapshot?.repos.find((r) => r.state.worktrees.some((w) => w.id === id));
    if (repo) setRepoRoot(repo.repoRoot);
    select(id);
  }, [snapshot, select]);
  useShell(snapshot, selected?.wt.id, {
    onSelect: selectAnywhere,
    onNext: () => {
      const queue = needsOf(snapshot);
      if (queue.length === 0) return;
      const at = queue.findIndex((n) => n.id === latest.current.selectedId);
      selectAnywhere(queue[(at + 1) % queue.length].id);
    },
    onManager: () => runEffect({ focusManager: true }),
    onNotice: setNotice,
  });

  useEffect(() => {
    if (focusTick > 0 && manager.pane) registry.focus(manager.pane);
  }, [focusTick, manager.pane, registry]);

  const sidebarState = useMemo(
    () => toSidebarState(snapshot, { repoRoot, activeWorktreeId: selected?.wt.id, sidebarStyle: style, defaultProvider }),
    [snapshot, repoRoot, selected?.wt.id, style, defaultProvider],
  );

  const runCommand = useCallback(async (name: string, body: Record<string, unknown>) => {
    try {
      return await api.command<{ windowIndex?: number; worktree?: { id: string } }>(name, body);
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
      return undefined;
    }
  }, [api]);

  /** Native folder picker, then stackd's `addRepo`; selects the repository it manages. */
  const addRepository = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: 'Add repository' });
      if (typeof picked !== 'string') return;
      const added = await api.command<{ repoRoot?: string }>('addRepo', { repo: picked });
      setRepoRoot(added?.repoRoot ?? picked);
      setSelectedId(undefined);
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    }
  }, [api]);

  const onMessage = useCallback((msg: WebMessage) => {
    if (!view) return;
    const ctx = { repoRoot: view.repoRoot, worktrees: [...view.items.map((d) => d.wt), ...(view.control ? [view.control.wt] : [])] };
    const act = (a: Action): void => {
      switch (a.kind) {
        case 'select':
          select(a.worktreeId, a.index);
          break;
        case 'command':
          void runCommand(a.name, a.body).then((res) => {
            if (a.selectNew) select(a.selectNew, res?.windowIndex);
            if (a.name === 'createTask' && res?.worktree?.id) select(res.worktree.id);
          });
          break;
        case 'ask':
          setDialog({ kind: 'ask', title: a.title, label: a.label, initial: a.initial, confirm: a.confirm, onSubmit: (text) => void runCommand(a.then.name, { ...a.then.body, [a.then.field]: text }) });
          break;
        case 'confirm':
          setDialog({ kind: 'confirm', title: a.title, detail: a.detail, choices: a.choices, onChoose: (i) => { const c = a.then(i); void runCommand(c.name, c.body); } });
          break;
        case 'newTask':
          setNewTaskOpen(true);
          break;
        case 'open':
          invoke('open_url', { url: a.url }).catch((e) => setNotice(String(e)));
          break;
        case 'pickProvider':
          setDialog({
            kind: 'confirm', title: 'Default agent', detail: 'Launched by the main button of each task.', choices: a.choices,
            onChoose: (i) => { saveDefaultProvider(a.choices[i]); setDefaultProvider(a.choices[i]); },
          });
          break;
        case 'install': {
          const hint = installHint(a.provider);
          setDialog({ kind: 'confirm', title: hint.title, detail: hint.detail, choices: ['Copy command'], onChoose: () => void navigator.clipboard.writeText(hint.command).catch(() => {}) });
          break;
        }
        case 'unsupported':
          setNotice(`${a.what} is not in the desktop app yet.`);
          break;
        case 'none':
          break;
      }
    };
    act(translate(msg, ctx));
  }, [view, select, runCommand]);

  // The extension's new-task panel; what NewTaskPanelManager does for it in VS Code happens here.
  const onNewTaskMessage = useCallback(async (msg: NewTaskMessage) => {
    if (!view) return;
    const act = translateNewTask(msg, { repoRoot: view.repoRoot });
    switch (act.kind) {
      case 'init': {
        let fromStackd: NewTaskInit | undefined;
        try { fromStackd = await api.command<NewTaskInit>('newTaskInit', { repo: view.repoRoot }); } catch (e) { console.error(e); }
        postToNewTask.current?.({ type: 'init', init: toNewTaskInit(fromStackd, { sidebarStyle: style, defaultProvider }) });
        return;
      }
      case 'create':
        try {
          const res = await api.command<{ worktree?: { id: string } }>('createTask', act.body);
          setNewTaskOpen(false);
          if (res?.worktree?.id) select(res.worktree.id);
        } catch (e) {
          postToNewTask.current?.({ type: 'error', message: String(e instanceof Error ? e.message : e) || 'Could not create the worktree.' });
        }
        return;
      case 'close':
        setNewTaskOpen(false);
        return;
      case 'confirmDiscard':
        setDialog({ kind: 'confirm', title: 'Discard this task?', detail: 'The description you wrote will be lost.', choices: ['Discard'], onChoose: () => setNewTaskOpen(false) });
        return;
      case 'install': {
        const hint = installHint(act.provider);
        setDialog({ kind: 'confirm', title: hint.title, detail: hint.detail, choices: ['Copy command'], onChoose: () => void navigator.clipboard.writeText(hint.command).catch(() => {}) });
        return;
      }
    }
  }, [view, api, style, defaultProvider, select]);

  const commands = useCallback((id: string) => {
    const session = sessionOf[id];
    const out: Record<number, string> = {};
    for (const p of panes) if (p.session === session) out[p.window_index] = p.command;
    return out;
  }, [sessionOf, panes]);

  if (running === null) return <div className="fullscreen">Connecting to stackd…</div>;
  if (!running) {
    return (
      <div className="fullscreen">
        <StartStackd socket={socket} />
      </div>
    );
  }
  if (!view) {
    return (
      <div className="fullscreen">
        <div className="empty"><h1>No repository yet</h1><p>stackd is running but manages no repository.</p><button type="button" onClick={() => void addRepository()}>Add repository</button>{notice && <div className="notice" role="status">{notice}</div>}</div>
      </div>
    );
  }

  const rows = selected ? sessionRows(selected.wt, commands(selected.wt.id)) : [];
  const resizeTo = (key: 'sidebar' | 'manager' | 'lines', v: number) => setLayout((l) => resize(l, l.mode, key, v));
  const resetTo = (key: 'sidebar' | 'manager' | 'lines') => setLayout((l) => resetSize(l, l.mode, key));
  const allow = (worktreeId: string, windowIndex: number) => void runCommand('respondPermission', { worktreeId, windowIndex, answer: 'allow' });
  const startAgent = async (worktreeId: string) => {
    try {
      await api.command('spawnAgent', { worktreeId });
    } catch (e) {
      console.error(e);
    }
  };

  const float = mode === 'float';
  const showSidebar = mode !== 'float' && maximized === null;
  const showCentre = maximized !== 'manager';
  const showList = float && maximized === null;
  const columnManager = mode === 'full' && managerOpen && maximized !== 'session' || mode === 'full' && maximized === 'manager';
  const showStrip = mode !== 'full' && maximized === null && !stripExpanded;
  const bigManager = mode !== 'full' && (maximized === 'manager' || (maximized === null && stripExpanded));
  const managerLimits = limits(mode, 'manager');
  const sidebarLimits = limits(mode, 'sidebar');
  const sidebarMax = Math.min(sidebarLimits.max, maxPanelWidth(appWidth, columnManager && maximized === null ? sizes.manager : 0));
  const managerMax = Math.min(managerLimits.max, maxPanelWidth(appWidth, showSidebar ? sizes.sidebar : 0));
  const stripPx = heightFromLines(sizes.lines);
  const maxTitle = 'Maximized — double-click or ⌘⇧Enter to restore';
  const managerView = (
    <SessionView
      resolved={manager}
      empty={view.control && !mgr
        ? <><p>The Manager is not running.</p><button type="button" onClick={() => void startAgent(view.control!.wt.id)}>Start the Manager</button></>
        : 'Connecting…'}
    />
  );

  return (
    <div className="shell" data-mode={mode}>
      <header className="titlebar" data-tauri-drag-region>
        <span className="titlebar-name" data-tauri-drag-region>Stack</span>
        <button type="button" className="icon-btn" title="Settings (⌘,)" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" strokeLinecap="round" /></svg>
        </button>
        <ModeSwitch mode={mode} onChange={(m) => setLayout((l) => setMode(l, m))} />
        {mode === 'half' && (
          <button type="button" className="icon-btn side-btn" title={`Snap to the ${side === 'left' ? 'right' : 'left'} half`} aria-label="Switch side" onClick={() => setLayout((l) => setMode(l, 'half', l.side === 'left' ? 'right' : 'left'))}>{side === 'left' ? '◧' : '◨'}</button>
        )}
      </header>
      <div className="app" ref={appRef} data-mode={mode} data-maximized={maximized ?? undefined}>
        {showSidebar && (
          <>
            <aside className="sidebar" aria-label="Worktrees" style={{ width: sizes.sidebar }}>
              <ViewTitle counts={sidebarState ? describeCounts(sidebarState) : ''} onAdd={() => onMessage({ type: 'openNewTask' })}>
                <select className="repo-select" value={view.repoRoot} onChange={(e) => {
                  if (e.target.value === ADD_REPO) { void addRepository(); return; }
                  setRepoRoot(e.target.value); setSelectedId(undefined);
                }}>
                  {view.repos.map((r) => <option key={r.repoRoot} value={r.repoRoot}>{r.name}</option>)}
                  <option value={ADD_REPO}>Add repository…</option>
                </select>
              </ViewTitle>
              <div className="sidebar-body"><SidebarHost state={sidebarState} onMessage={onMessage} /></div>
              {notice && <div className="notice" role="status">{notice}</div>}
            </aside>
            <Splitter orientation="col" label="Resize sidebar" value={sizes.sidebar} min={sidebarLimits.min} max={Math.max(sidebarLimits.min, sidebarMax)} reset={DEFAULT_SIZES[mode].sidebar} onChange={(v) => v === DEFAULT_SIZES[mode].sidebar ? resetTo('sidebar') : resizeTo('sidebar', v)} />
          </>
        )}

        <div className="stage">
          {showList && items && <FloatList rows={floatRows(items)} selectedId={selected?.wt.id} onSelect={select} onAllow={allow} />}
          {float && notice && <div className="notice" role="status">{notice}</div>}
          {showCentre && (
            <main className="centre">
              {selected ? (
                <>
                  <nav className="tabs" aria-label={`Sessions of ${nameOf(selected.wt)}`} onDoubleClick={() => setMaximized((m) => toggleMaximized(m, 'session'))}>
                    <span className="tabs-title">{selected.name}</span>
                    {rows.map((r) => (
                      <button key={r.index} type="button" className="tab" data-state={r.state} data-selected={r.index === selectedIndex || undefined} onClick={() => select(selected.wt.id, r.index)} title={r.index === selectedIndex ? 'Double-click to maximize' : undefined}>
                        <span className="dot" aria-hidden="true" />
                        {r.name}
                        <span className="tab-state">{r.kind === 'agent' ? stateWord(r.state) : r.detail}</span>
                        {maximized === 'session' && r.index === selectedIndex && <span className="max-badge" title={maxTitle}>maximized</span>}
                      </button>
                    ))}
                  </nav>
                  <div className="term-host">
                    <SessionView
                      resolved={centre}
                      empty={rows.length === 0
                        ? <><p>No sessions in this worktree.</p><button type="button" onClick={() => void startAgent(selected.wt.id)}>Start an agent</button></>
                        : 'Connecting…'}
                    />
                  </div>
                </>
              ) : (
                <div className="placeholder">Describe a task in the sidebar to start one.</div>
              )}
            </main>
          )}

          {mode !== 'full' && maximized !== 'session' && (
            <section className="manager-dock" data-expanded={bigManager || undefined} aria-label="Manager">
              {!bigManager && <Splitter orientation="row" invert label="Resize Manager strip" value={stripPx} min={heightFromLines(limits(mode, 'lines').min)} max={heightFromLines(limits(mode, 'lines').max)} reset={heightFromLines(DEFAULT_SIZES[mode].lines)} onChange={(px) => resizeTo('lines', linesFromHeight(px))} />}
              <header className="strip-head" onDoubleClick={() => setMaximized((m) => toggleMaximized(m, 'manager'))} title="Double-click to maximize">
                <span className="strip-title">◆ Manager{!bigManager && <> · last {sizes.lines} lines</>}</span>
                {maximized === 'manager' && <span className="max-badge" title={maxTitle}>maximized</span>}
                <kbd>⌘0</kbd>
                <kbd>⌘⇧M</kbd>
              </header>
              {bigManager ? <div className="term-host">{managerView}</div> : showStrip && <ManagerStrip ref={stripRef} pane={manager.pane} lines={sizes.lines} />}
            </section>
          )}
        </div>

        {columnManager && (
          <>
            {maximized === null && <Splitter orientation="col" invert label="Resize Manager" value={sizes.manager} min={managerLimits.min} max={Math.max(managerLimits.min, managerMax)} reset={DEFAULT_SIZES[mode].manager} onChange={(v) => v === DEFAULT_SIZES[mode].manager ? resetTo('manager') : resizeTo('manager', v)} />}
            <section className="manager" aria-label="Manager" style={maximized === 'manager' ? { flex: 1 } : { width: sizes.manager }}>
              <header className="manager-head" onDoubleClick={() => setMaximized((m) => toggleMaximized(m, 'manager'))} title="Double-click to maximize">
                <span className="manager-title">Manager</span>
                {maximized === 'manager' && <span className="max-badge" title={maxTitle}>maximized</span>}
                <kbd>⌘0</kbd>
                <kbd>⌘⇧M</kbd>
              </header>
              <div className="term-host">{managerView}</div>
            </section>
          </>
        )}
        {newTaskOpen && <NewTaskHost style={style} onMessage={(m) => void onNewTaskMessage(m)} registerPost={registerPost} />}
        {settingsOpen && <SettingsHost onClose={() => setSettingsOpen(false)} onSaved={(file) => void loadSidebarStyle().then(setStyle).catch(() => setStyle(resolveSidebarStyle(file, null)))} />}
        {dialog && <Dialog spec={dialog} onClose={() => setDialog(null)} />}
      </div>
    </div>
  );
}
