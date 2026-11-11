import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tmux as defaultApi, type TmuxApi } from './api';
import { PaneBook, type PaneInfo } from './paneBook';
import { TerminalRegistry } from './registry';

export interface Terminals {
  api: TmuxApi;
  registry: TerminalRegistry;
  /** Panes of every connected session. */
  panes: PaneInfo[];
  /** Sessions with a live control connection. */
  sessions: string[];
  connected: boolean;
  error: string | null;
  /** Connect to a session (a no-op, besides re-listing, when it already is). Resolves to its panes. */
  connect(socket: string | null, session: string, create?: boolean): Promise<PaneInfo[]>;
  /** Detach one session, or all of them. */
  disconnect(session?: string): Promise<void>;
}

const Ctx = createContext<Terminals | null>(null);

/** Owns the tmux connections (one per session), the pane list and the terminal registry. */
export function TerminalsProvider({ children, api = defaultApi }: { children: ReactNode; api?: TmuxApi }) {
  const registry = useMemo(() => new TerminalRegistry(api), [api]);
  const book = useRef(new PaneBook());
  const inflight = useRef(new Map<string, Promise<PaneInfo[]>>());
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [sessions, setSessions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const applyList = (session: string, list: PaneInfo[]) => {
    const { removed } = book.current.update(session, list);
    removed.forEach((id) => registry.dispose(id));
    setPanes(book.current.list());
    setSessions((s) => (s.includes(session) ? s : [...s, session]));
  };
  const dropSession = (session: string) => {
    book.current.removeSession(session).forEach((id) => registry.dispose(id));
    setPanes(book.current.list());
    setSessions((s) => s.filter((x) => x !== session));
  };

  useEffect(() => {
    const offs: Promise<() => void>[] = [
      api.onOutput((pane, data) => registry.feed(pane, data)),
      api.onLayout((session) => void api.listPanes(session).then((l) => applyList(session, l)).catch(() => {})),
      api.onExit((session) => dropSession(session)),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, registry]);

  const value = useMemo<Terminals>(
    () => ({
      api,
      registry,
      panes,
      sessions,
      connected: sessions.length > 0,
      error,
      connect(socket, session, create) {
        const running = inflight.current.get(session);
        if (running) return running;
        const p = (async () => {
          setError(null);
          try {
            const list = await api.connect(socket, session, create);
            applyList(session, list);
            return list;
          } catch (e) {
            setError(String(e));
            throw e;
          } finally {
            inflight.current.delete(session);
          }
        })();
        inflight.current.set(session, p);
        return p;
      },
      async disconnect(session) {
        await api.disconnect(session);
        if (session) dropSession(session);
        else sessions.forEach(dropSession);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, registry, panes, sessions, error],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTerminals(): Terminals {
  const t = useContext(Ctx);
  if (!t) throw new Error('useTerminals outside TerminalsProvider');
  return t;
}

/**
 * Tell the backend which panes are in use (rendered or watched) so it only
 * auto-continues those after a `%pause`. Each component reports its own panes;
 * the union is what the backend gets.
 */
const reported = new Map<symbol, string[]>();
export function useVisiblePanes(ids: (string | null)[]) {
  const { api, connected } = useTerminals();
  const owner = useRef(Symbol('visible'));
  const key = ids.filter(Boolean).sort().join(',');
  useEffect(() => {
    if (!connected) return;
    const me = owner.current;
    reported.set(me, key ? key.split(',') : []);
    void api.setVisible([...new Set([...reported.values()].flat())]);
    return () => {
      reported.delete(me);
      void api.setVisible([...new Set([...reported.values()].flat())]).catch(() => {});
    };
  }, [api, connected, key]);
}
