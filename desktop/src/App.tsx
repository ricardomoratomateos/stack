import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusDot } from '@core/webview/components/StatusDot';
import { nameOf } from '@core/webview/derive';
import { MANAGER_ID, buildView, floatRows, managerIndex, managerSession, mruTouch, pickSession, stepWrap, switcherRows, type SwitcherRow, resolveShortcut, stepSessionIndex, type Pane, sessionRows, shortcutOf, stateWord, type Effect } from './model';
import { StartStackd } from './stackd/StartStackd';
import { useStackd } from './stackd/useStackd';
import { useTerminals } from './terminals';
import { SidebarHost } from './sidebar/SidebarHost';
import { installHint, toSidebarState, translate, type Action } from './sidebar/bridge';
import { loadDefaultProvider, saveDefaultProvider } from './sidebar/prefs';
import { NewTaskHost } from './newtask/NewTaskHost';
import { ReviewHost } from './review/ReviewHost';
import { toNewTaskInit, translateNewTask } from './newtask/bridge';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { NewTaskExtMessage, NewTaskInit, NewTaskMessage } from '@core/newtask/types';
import type { ProviderId } from '@core/ports/IAgentProvider';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { SettingsHost } from './settings/SettingsHost';
import { Dialog, type DialogSpec } from './ui/Dialog';
import type { WebMessage } from '@core/webview/types';
import { SessionView } from './ui/Pane';
import { useSessionPane } from './ui/useSessionPane';
import { Splitter } from './ui/Splitter';
import { FloatList } from './ui/FloatList';
import { Switcher } from './ui/Switcher';
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

export const NOT_RUNNING = 'stackd not running — start it from the app (Start stackd now / at login).';

export function App() {
  const { running, socket, snapshot, api } = useStackd();
  const { registry, panes } = useTerminals();
  const [repoRoot, setRepoRoot] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [remembered, setRemembered] = useState<Record<string, number>>({});
  const [managerTabs, setManagerTabs] = useState<Record<string, number>>({});
  const [managerOpen, setManagerOpen] = useState(true);
  const [layout, setLayout] = useState<LayoutState>(initialLayoutState);
  const [maximized, setMaximized] = useState<Maximized>(null);
  const [stripExpanded, setStripExpanded] = useState(false);
  const [appWidth, setAppWidth] = useState(1200);
  const appRef = useRef<HTMLDivElement>(null);
  const { mode, side } = layout;
  const sizes = layout.sizes[mode];
  const [focusTick, setFocusTick] = useState(0);
  const [sessionOf, setSessionOf] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [notice, setNotice] = useState('');
  const [defaultProvider, setDefaultProvider] = useState<ProviderId | undefined>(loadDefaultProvider);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  /** The worktree whose Review tab is showing in the centre (instead of its terminal). */
  const [reviewId, setReviewId] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const postToNewTask = useRef<((msg: NewTaskExtMessage) => void) | null>(null);
  const registerPost = useCallback((post: ((msg: NewTaskExtMessage) => void) | null) => { postToNewTask.current = post; }, []);

  // The chrome paints from the sidebar's palette: the `fm-aside` class on <html> defines --fm-* for the --app-* tokens.
  useEffect(() => {
    document.documentElement.classList.add('fm-aside');
    registry.refreshTheme();
  }, [registry]);
  useEffect(() => saveLayout(layout), [layout]);
  // The native menu (menu.rs): Settings… (⌘,) and the window modes.
  useEffect(() => {
    const offs = [
      listen('menu://settings', () => setSettingsOpen(true)),
      listen<string>('menu://mode', (e) => {
        const m = e.payload;
        if (m === 'cycle') setLayout((l) => setMode(l, nextMode(l.mode)));
        else if (m === 'side') setLayout((l) => setMode(l, 'half', l.side === 'left' ? 'right' : 'left'));
        else if (m === 'full' || m === 'half' || m === 'float') setLayout((l) => setMode(l, m));
      }),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
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

  // Selection history per repo (worktree ids and 'manager'), most recent first: the ⌃Tab switcher's order.
  const history = useRef<Record<string, string[]>>({});
  const touch = useCallback((id: string) => {
    const repo = latest.current.repoRoot;
    if (repo) history.current[repo] = mruTouch(history.current[repo] ?? [], id);
  }, []);
  const closeReview = useCallback(() => setReviewId(undefined), []);
  // The review takes the whole screen while it is open (Full, centre maximized), then puts the layout back.
  const beforeReview = useRef<{ mode: Mode; maximized: Maximized } | null>(null);
  const layoutNow = useRef({ mode, maximized });
  layoutNow.current = { mode, maximized };
  useEffect(() => {
    if (reviewId && !beforeReview.current) {
      beforeReview.current = { ...layoutNow.current };
      if (layoutNow.current.mode !== 'full') setLayout((l) => setMode(l, 'full'));
      setMaximized('session');
    } else if (!reviewId && beforeReview.current) {
      const b = beforeReview.current;
      beforeReview.current = null;
      if (b.mode !== 'full') setLayout((l) => setMode(l, b.mode));
      setMaximized(b.maximized);
    }
  }, [reviewId]);
  // Un-maximizing (double-click, ⌘⇧Enter) while reviewing means leaving the review: it only works full-screen.
  useEffect(() => { if (reviewId && beforeReview.current && maximized !== 'session') setReviewId(undefined); }, [maximized]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the reviewed worktree (⌃Tab, ⌘N…) closes its review.
  useEffect(() => { if (reviewId && selected && selected.wt.id !== reviewId) setReviewId(undefined); }, [selected?.wt.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const select = useCallback((id: string, index?: number) => {
    touch(id);
    setSelectedId(id);
    if (index !== undefined) {
      setRemembered((r) => ({ ...r, [id]: index }));
      setReviewId((r) => (r === id ? undefined : r)); // a session tab returns to the terminal
    }
  }, [touch]);
  useEffect(() => { if (view && selected) { latest.current.repoRoot = view.repoRoot; touch(selected.wt.id); } }, [view?.repoRoot, selected?.wt.id, touch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Centre: the selected session. Right: the Manager.
  const centreTarget = useMemo(
    () => (selected && selectedIndex !== undefined ? { worktreeId: selected.wt.id, index: selectedIndex } : null),
    [selected?.wt.id, selectedIndex], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const mgr = managerSession(view?.control?.wt);
  const managerIdx = managerIndex(view?.control?.wt, view ? managerTabs[view.repoRoot] : undefined);
  const managerTarget = useMemo(
    () => (view?.control && managerIdx !== undefined ? { worktreeId: view.control.wt.id, index: managerIdx } : null),
    [view?.control?.wt.id, managerIdx], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const onSession = useCallback((id: string, session: string) => setSessionOf((m) => (m[id] === session ? m : { ...m, [id]: session })), []);
  const centre = useSessionPane(centreTarget, onSession);
  const managerWanted = mode !== 'full' || managerOpen || maximized === 'manager';
  const manager = useSessionPane(managerWanted ? managerTarget : null, onSession);

  // Shortcuts. Capture phase, so they win over the focused terminal.
  const latest = useRef({ items, control: view?.control, repoRoot: view?.repoRoot, selectedId: selected?.wt.id, selected: selected?.wt, selectedIndex, managerIdx, mode, expanded: stripExpanded || maximized === 'manager' });
  latest.current = { items, control: view?.control, repoRoot: view?.repoRoot, selectedId: selected?.wt.id, selected: selected?.wt, selectedIndex, managerIdx, mode, expanded: stripExpanded || maximized === 'manager' };
  // Which pane had focus last (centre or Manager): ⌥⌘←/→ and the repeat-to-cycle shortcuts act on it.
  const focusedPane = useRef<Pane>('centre');
  useEffect(() => {
    const note = (e: Event) => {
      const el = e.target as Element | null;
      if (!el || !el.closest) return;
      if (el.closest('.manager, .manager-dock')) focusedPane.current = 'manager';
      else if (el.closest('.centre')) focusedPane.current = 'centre';
    };
    document.addEventListener('focusin', note, true);
    document.addEventListener('mousedown', note, true);
    return () => { document.removeEventListener('focusin', note, true); document.removeEventListener('mousedown', note, true); };
  }, []);
  const runEffect = useCallback((fx: Effect) => {
    if (fx.select) { select(fx.select); focusedPane.current = 'centre'; }
    if (fx.focusCentre) setCentreFocusTick((t) => t + 1);
    if (fx.tab) {
      const l = latest.current;
      if (fx.tab.pane === 'manager') {
        const to = stepSessionIndex(l.control?.wt, l.managerIdx, fx.tab.dir);
        const repo = l.repoRoot;
        if (to !== undefined && repo) {
          touch(MANAGER_ID);
          focusedPane.current = 'manager';
          setManagerTabs((m) => ({ ...m, [repo]: to }));
          if (l.mode === 'full') setManagerOpen(true);
          setFocusTick((t) => t + 1);
        }
      } else {
        const to = stepSessionIndex(l.selected, l.selectedIndex, fx.tab.dir);
        if (l.selected && to !== undefined) { select(l.selected.id, to); focusedPane.current = 'centre'; setCentreFocusTick((t) => t + 1); }
      }
    }
    if (fx.toggleManager) {
      if (latest.current.mode === 'full') setManagerOpen((o) => !o);
      else setStripExpanded((x) => !x);
    }
    if (fx.cycleMode) setLayout((l) => setMode(l, nextMode(l.mode)));
    if (fx.maximize) setMaximized((m) => cycleMaximized(m, latest.current.mode));
    if (fx.focusManager) {
      touch(MANAGER_ID);
      focusedPane.current = 'manager';
      if (latest.current.mode === 'full') setManagerOpen(true);
      setFocusTick((t) => t + 1);
    }
  }, [select, touch]);
  // ⌘⇧J is both a menu accelerator and a JS shortcut; only one of the two may act per press.
  const lastNeeds = useRef(0);
  const dedupeNeeds = useCallback(() => {
    const now = performance.now();
    if (now - lastNeeds.current < 60) return false;
    lastNeeds.current = now;
    return true;
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sc = shortcutOf(e);
      if (!sc) return;
      e.preventDefault();
      e.stopPropagation();
      if ((sc.kind === 'needs' || sc.kind === 'tab-prev' || sc.kind === 'tab-next' || sc.kind === 'focus-manager') && !dedupeNeeds()) return;
      runEffect(resolveShortcut(sc, latest.current.items ?? [], latest.current.selectedId, focusedPane.current));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [runEffect, dedupeNeeds]);

  // ⌃Tab switcher (Alt+Tab style). Hold Control, Tab steps through worktrees in MRU order, releasing Control selects.
  // The overlay only shows after a short hold, so a quick ⌃Tab just toggles to the previous one.
  const [sw, setSw] = useState<{ rows: SwitcherRow[]; index: number; visible: boolean } | null>(null);
  const swRef = useRef<{ rows: SwitcherRow[]; index: number } | null>(null);
  const swTimer = useRef(0);
  const [centreFocusTick, setCentreFocusTick] = useState(0);
  const closeSwitcher = useCallback(() => {
    clearTimeout(swTimer.current);
    swRef.current = null;
    setSw(null);
  }, []);
  const commitSwitcher = useCallback((id: string | undefined) => {
    closeSwitcher();
    if (!id) return;
    if (id === MANAGER_ID) { runEffect({ focusManager: true }); return; }
    select(id);
    setCentreFocusTick((t) => t + 1);
  }, [closeSwitcher, runEffect, select]);
  const lastStep = useRef(0);
  // One ⌃Tab press: opens the switcher, or moves the highlight if it is open. The native menu accelerator
  // (menu://go) is the real path; the JS keydown is a fallback, deduped in case both ever fire.
  const switchStep = useCallback((dir: 1 | -1) => {
    const now = performance.now();
    if (now - lastStep.current < 60) return;
    lastStep.current = now;
    const cur = swRef.current;
    if (cur) {
      cur.index = stepWrap(cur.index, cur.rows.length, dir);
      setSw((s) => (s ? { ...s, index: cur.index } : s));
      return;
    }
    const { items: its, control, repoRoot: repo } = latest.current;
    const rows = switcherRows(its ?? [], control, (repo && history.current[repo]) || []);
    if (rows.length < 2) return;
    const index = dir === -1 ? rows.length - 1 : 1;
    swRef.current = { rows, index };
    setSw({ rows, index, visible: false });
    swTimer.current = window.setTimeout(() => setSw((s) => (s ? { ...s, visible: true } : s)), 150);
  }, []);
  const commitCurrent = useCallback(() => {
    const cur = swRef.current;
    if (cur) commitSwitcher(cur.rows[cur.index]?.id);
  }, [commitSwitcher]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = swRef.current;
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        switchStep(e.shiftKey ? -1 : 1);
        return;
      }
      if (!cur) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSwitcher(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); switchStep(1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); switchStep(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitCurrent(); }
    };
    // Releasing Control commits (keyup reaches the page even though ⌃Tab itself goes through the native menu).
    const onKeyUp = (e: KeyboardEvent) => {
      if (swRef.current && e.key === 'Control') { e.preventDefault(); e.stopPropagation(); commitCurrent(); }
    };
    const offs = [
      listen<string>('menu://go', (e) => {
        switch (e.payload) {
          case 'switch': switchStep(1); break;
          case 'switch-back': switchStep(-1); break;
          case 'needs': if (!dedupeNeeds()) break; // fallthrough
          case 'next': case 'prev':
            runEffect(resolveShortcut({ kind: e.payload }, latest.current.items ?? [], latest.current.selectedId));
            break;
          case 'tab-prev': case 'tab-next': case 'manager':
            if (!dedupeNeeds()) break;
            runEffect(resolveShortcut({ kind: e.payload === 'manager' ? 'focus-manager' : e.payload }, latest.current.items ?? [], latest.current.selectedId, focusedPane.current));
            break;
        }
      }),
    ];
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', commitCurrent);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', commitCurrent);
      offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
    };
  }, [commitCurrent, closeSwitcher, switchStep, runEffect, dedupeNeeds]);
  useEffect(() => {
    if (centreFocusTick > 0 && centre.pane) registry.focus(centre.pane);
  }, [centreFocusTick, centre.pane, registry]);
  // "Send to agent" in the review: leave the now-stale diff for the session the comments went to.
  const reviewSent = useCallback((index: number | undefined, fellBack: boolean) => {
    const id = latest.current.selectedId; // the reviewed task: leaving it closes the review
    setReviewId(undefined);
    if (id) select(id, index);
    setCentreFocusTick((t) => t + 1);
    if (fellBack) setNotice('The agent had exited, so a new one was launched with your comments.');
  }, [select]);

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
    () => toSidebarState(snapshot, { repoRoot, activeWorktreeId: selected?.wt.id, defaultProvider }),
    [snapshot, repoRoot, selected?.wt.id, defaultProvider],
  );

  const runCommand = useCallback(async (name: string, body: Record<string, unknown>) => {
    try {
      return await api.command<{ windowIndex?: number; worktree?: { id: string } }>(name, body);
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
      return undefined;
    }
  }, [api]);
  /** Middle click closes a tab, as in a browser: a session tab kills its window (the sidebar's ✕), the Review tab closes the review. */
  const onMiddleClick = (close: () => void) => ({
    onMouseDown: (e: React.MouseEvent) => { if (e.button === 1) e.preventDefault(); },
    // mouseup, not auxclick: WKWebView on macOS 14 does not fire auxclick.
    onMouseUp: (e: React.MouseEvent) => { if (e.button !== 1) return; e.preventDefault(); e.stopPropagation(); close(); },
  });
  const closeSessionTab = (worktreeId: string, index: number) => void runCommand('killWindow', { worktreeId, windowIndex: index });

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
        case 'review':
          select(a.worktreeId);
          setReviewId(a.worktreeId);
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
        postToNewTask.current?.({ type: 'init', init: toNewTaskInit(fromStackd, { defaultProvider }) });
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
  }, [view, api, defaultProvider, select]);

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

  const reviewing = !!selected && reviewId === selected.wt.id;
  const rows = selected ? sessionRows(selected.wt, commands(selected.wt.id)) : [];
  const managerRows = view.control ? sessionRows(view.control.wt, commands(view.control.wt.id)) : [];
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
      <header className="titlebar" data-tauri-drag-region />
      <div className="app" ref={appRef} data-mode={mode} data-maximized={maximized ?? undefined}>
        {showSidebar && (
          <>
            <aside className="sidebar" aria-label="Worktrees" style={{ width: sizes.sidebar }}>
              <div className="sidebar-body">
                <SidebarHost state={sidebarState} onMessage={onMessage} actions={(
                  <>
                    <span className="repo-picker"><span className="repo-picker-label">{view.repos.find((r) => r.repoRoot === view.repoRoot)?.name ?? 'Repository'}</span><i className="codicon codicon-chevron-down" aria-hidden="true" />
                    <select value={view.repoRoot} aria-label="Repository" title="Repository" onChange={(e) => {
                      if (e.target.value === ADD_REPO) { void addRepository(); return; }
                      setRepoRoot(e.target.value); setSelectedId(undefined);
                    }}>
                      {view.repos.map((r) => <option key={r.repoRoot} value={r.repoRoot}>{r.name}</option>)}
                      <option value={ADD_REPO}>Add repository…</option>
                    </select></span>
                    <button type="button" className="icon-btn" title="New task" aria-label="New task" onClick={() => onMessage({ type: 'openNewTask' })}><i className="codicon codicon-add" aria-hidden="true" /></button>
                  </>
                )} />
              </div>
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
                      <button key={r.index} type="button" className="tab" data-state={r.state} data-selected={(!reviewing && r.index === selectedIndex) || undefined} {...onMiddleClick(() => closeSessionTab(selected.wt.id, r.index))} onClick={() => select(selected.wt.id, r.index)} title={[r.kind === 'agent' ? stateWord(r.state) : r.detail, r.index === selectedIndex ? 'Double-click to maximize' : ''].filter(Boolean).join(' · ') || undefined}>
                        <StatusDot state={r.state} size="sm" />
                        {r.name}
                        {maximized === 'session' && r.index === selectedIndex && <span className="max-badge" title={maxTitle}>maximized</span>}
                      </button>
                    ))}
                    {/* Only while a review is open: it is opened from the card's review button, and closing it removes the tab. */}
                    {reviewing && (
                      <button type="button" className="tab tab-review" data-selected {...onMiddleClick(closeReview)} title="Review the changes and comment">
                        <i className="codicon codicon-git-compare" aria-hidden="true" />
                        Review
                        <span className="tab-close" role="button" aria-label="Close review" title="Close review (Esc)" onClick={(e) => { e.stopPropagation(); closeReview(); }}><i className="codicon codicon-close" aria-hidden="true" /></span>
                      </button>
                    )}
                  </nav>
                  <div className="centre-body">
                  <div className="term-host">
                    <SessionView
                      resolved={centre}
                      empty={rows.length === 0
                        ? <><p>No sessions in this worktree.</p><button type="button" onClick={() => void startAgent(selected.wt.id)}>Start an agent</button></>
                        : 'Connecting…'}
                    />
                  </div>
                  {reviewing && <ReviewHost key={selected.wt.id} worktree={selected.wt} api={api} onClose={closeReview} onSent={reviewSent} onNotice={setNotice} />}
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
              <nav className="tabs" aria-label="Manager sessions" onDoubleClick={() => setMaximized((m) => toggleMaximized(m, 'manager'))} title="Double-click to maximize · ⌘0 focus · ⌘⇧M toggle">
                <span className="tabs-title">{view.control?.name || 'Manager'}</span>
                {managerRows.map((r) => (
                  <button key={r.index} type="button" className="tab" data-state={r.state} data-selected={r.index === managerIdx || undefined} {...onMiddleClick(() => view.control && closeSessionTab(view.control.wt.id, r.index))} onClick={() => setManagerTabs((m) => ({ ...m, [view.repoRoot]: r.index }))} title={(r.kind === 'agent' ? stateWord(r.state) : r.detail) || undefined}>
                    <StatusDot state={r.state} size="sm" />
                    {r.name}
                  </button>
                ))}
                {maximized === 'manager' && <span className="max-badge" title={maxTitle}>maximized</span>}
              </nav>
              <div className="term-host" style={bigManager ? undefined : { flex: 'none', height: stripPx }}>{managerView}</div>
            </section>
          )}
        </div>

        {columnManager && (
          <>
            {maximized === null && <Splitter orientation="col" invert label="Resize Manager" value={sizes.manager} min={managerLimits.min} max={Math.max(managerLimits.min, managerMax)} reset={DEFAULT_SIZES[mode].manager} onChange={(v) => v === DEFAULT_SIZES[mode].manager ? resetTo('manager') : resizeTo('manager', v)} />}
            <section className="manager" aria-label="Manager" style={maximized === 'manager' ? { flex: 1 } : { width: sizes.manager }}>
              <nav className="tabs" aria-label="Manager sessions" onDoubleClick={() => setMaximized((m) => toggleMaximized(m, 'manager'))} title="Double-click to maximize · ⌘0 focus · ⌘⇧M toggle">
                <span className="tabs-title">{view.control?.name || 'Manager'}</span>
                {managerRows.map((r) => (
                  <button key={r.index} type="button" className="tab" data-state={r.state} data-selected={r.index === managerIdx || undefined} {...onMiddleClick(() => view.control && closeSessionTab(view.control.wt.id, r.index))} onClick={() => setManagerTabs((m) => ({ ...m, [view.repoRoot]: r.index }))} title={(r.kind === 'agent' ? stateWord(r.state) : r.detail) || undefined}>
                    <StatusDot state={r.state} size="sm" />
                    {r.name}
                  </button>
                ))}
                {maximized === 'manager' && <span className="max-badge" title={maxTitle}>maximized</span>}
              </nav>
              <div className="term-host">{managerView}</div>
            </section>
          </>
        )}
        {newTaskOpen && <NewTaskHost onMessage={(m) => void onNewTaskMessage(m)} registerPost={registerPost} />}
        {settingsOpen && <SettingsHost repo={view.repos.find((r) => r.repoRoot === view.repoRoot) && { name: view.repos.find((r) => r.repoRoot === view.repoRoot)!.name, root: view.repoRoot }} onClose={() => setSettingsOpen(false)} />}
        {sw?.visible && <Switcher rows={sw.rows} index={sw.index} onPick={(id) => commitSwitcher(id)} />}
        {dialog && <Dialog spec={dialog} onClose={() => setDialog(null)} />}
      </div>
    </div>
  );
}
