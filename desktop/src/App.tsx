import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nameOf } from '@core/webview/derive';
import { buildView, managerSession, pickSession, resolveShortcut, sessionRows, shortcutOf, stateWord, type Effect } from './model';
import { useStackd } from './stackd/useStackd';
import { useTerminals } from './terminals';
import { Sidebar } from './ui/Sidebar';
import { SessionView } from './ui/Pane';
import { useSessionPane } from './ui/useSessionPane';

export const NOT_RUNNING = 'stackd not running — start it with `node dist/stackd.js serve`, or enable stack.useDaemon in VS Code.';

export function App() {
  const { running, socket, snapshot, api } = useStackd();
  const { registry, panes } = useTerminals();
  const [repoRoot, setRepoRoot] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [remembered, setRemembered] = useState<Record<string, number>>({});
  const [managerOpen, setManagerOpen] = useState(true);
  const [focusTick, setFocusTick] = useState(0);
  const [sessionOf, setSessionOf] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

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
  const manager = useSessionPane(managerOpen ? managerTarget : null, onSession);

  // Shortcuts. Capture phase, so they win over the focused terminal.
  const latest = useRef({ items, selectedId: selected?.wt.id });
  latest.current = { items, selectedId: selected?.wt.id };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sc = shortcutOf(e);
      if (!sc) return;
      e.preventDefault();
      e.stopPropagation();
      const fx: Effect = resolveShortcut(sc, latest.current.items ?? [], latest.current.selectedId);
      if (fx.select) select(fx.select);
      if (fx.toggleManager) setManagerOpen((o) => !o);
      if (fx.focusManager) {
        setManagerOpen(true);
        setFocusTick((t) => t + 1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [select]);

  useEffect(() => {
    if (focusTick > 0 && manager.pane) registry.focus(manager.pane);
  }, [focusTick, manager.pane, registry]);

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
        <div className="empty">
          <h1>stackd not running</h1>
          <p>Start it with <code>node dist/stackd.js serve</code>, or enable <code>stack.useDaemon</code> in VS Code.</p>
          <p className="dim">Looking for <code>{socket}</code></p>
        </div>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="fullscreen">
        <div className="empty"><h1>No repository yet</h1><p>stackd is running but manages no repository. Open one in VS Code (stack.useDaemon) or add it with the <code>addRepo</code> command.</p></div>
      </div>
    );
  }

  const rows = selected ? sessionRows(selected.wt, commands(selected.wt.id)) : [];
  const startAgent = async (worktreeId: string) => {
    try {
      await api.command('spawnAgent', { worktreeId });
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="app" data-manager={managerOpen ? 'open' : 'closed'}>
      <Sidebar
        view={view}
        selectedId={selected?.wt.id}
        selectedIndex={selectedIndex}
        now={now}
        commands={commands}
        onSelect={select}
        onRepo={(r) => { setRepoRoot(r); setSelectedId(undefined); }}
        onCreate={async (task) => {
          const res = await api.command<{ worktree?: { id: string } }>('createTask', task);
          if (res.worktree?.id) setSelectedId(res.worktree.id);
        }}
      />

      <main className="centre">
        {selected ? (
          <>
            <nav className="tabs" aria-label={`Sessions of ${nameOf(selected.wt)}`}>
              <span className="tabs-title">{selected.name}</span>
              {rows.map((r) => (
                <button key={r.index} type="button" className="tab" data-state={r.state} data-selected={r.index === selectedIndex || undefined} onClick={() => select(selected.wt.id, r.index)}>
                  <span className="dot" aria-hidden="true" />
                  {r.name}
                  <span className="tab-state">{r.kind === 'agent' ? stateWord(r.state) : r.detail}</span>
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

      {managerOpen && (
        <section className="manager" aria-label="Manager">
          <header className="manager-head">
            <span className="manager-title">Manager</span>
            <kbd>⌘0</kbd>
            <kbd>⌘⇧M</kbd>
          </header>
          <div className="term-host">
            <SessionView
              resolved={manager}
              empty={view.control && !mgr
                ? <><p>The Manager is not running.</p><button type="button" onClick={() => void startAgent(view.control!.wt.id)}>Start the Manager</button></>
                : 'Connecting…'}
            />
          </div>
        </section>
      )}
    </div>
  );
}
