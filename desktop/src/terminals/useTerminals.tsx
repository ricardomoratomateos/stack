import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tmux as defaultApi, type TmuxApi } from './api';
import { PaneBook, type PaneInfo } from './paneBook';
import { TerminalRegistry } from './registry';

export interface Terminals {
  api: TmuxApi;
  registry: TerminalRegistry;
  panes: PaneInfo[];
  connected: boolean;
  error: string | null;
  connect(socket: string | null, session: string, create?: boolean): Promise<void>;
  disconnect(): Promise<void>;
}

const Ctx = createContext<Terminals | null>(null);

/** Owns the tmux connection, the pane list and the terminal registry. */
export function TerminalsProvider({ children, api = defaultApi }: { children: ReactNode; api?: TmuxApi }) {
  const registry = useMemo(() => new TerminalRegistry(api), [api]);
  const book = useRef(new PaneBook());
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyList = (list: PaneInfo[]) => {
    const { removed } = book.current.update(list);
    removed.forEach((id) => registry.dispose(id));
    setPanes(book.current.list());
  };

  useEffect(() => {
    const offs: Promise<() => void>[] = [
      api.onOutput((pane, data) => registry.feed(pane, data)),
      api.onLayout(() => void api.listPanes().then(applyList).catch(() => {})),
      api.onExit(() => {
        setConnected(false);
        setPanes([]);
        registry.disposeAll();
      }),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, registry]);

  const value = useMemo<Terminals>(
    () => ({
      api,
      registry,
      panes,
      connected,
      error,
      async connect(socket, session, create) {
        setError(null);
        try {
          registry.disposeAll();
          applyList(await api.connect(socket, session, create));
          setConnected(true);
        } catch (e) {
          setError(String(e));
          setConnected(false);
        }
      },
      async disconnect() {
        await api.disconnect();
        registry.disposeAll();
        setConnected(false);
        setPanes([]);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, registry, panes, connected, error],
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
 * auto-continues those after a `%pause`.
 */
export function useVisiblePanes(ids: (string | null)[]) {
  const { api, registry, connected } = useTerminals();
  const key = ids.filter(Boolean).sort().join(',');
  useEffect(() => {
    if (!connected) return;
    void api.setVisible(key ? key.split(',') : []);
  }, [api, registry, connected, key]);
}
