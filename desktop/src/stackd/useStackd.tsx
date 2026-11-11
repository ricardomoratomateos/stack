import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { stackd as defaultApi, type Snapshot, type StackdApi } from './api';

export interface StackdStatus {
  /** `null` until the first answer from the Rust side. */
  running: boolean | null;
  socket: string;
  snapshot: Snapshot | null;
  api: StackdApi;
}

const Ctx = createContext<StackdStatus | null>(null);

/** stackd's snapshot, kept current from the Rust side's SSE watcher. */
export function StackdProvider({ children, api = defaultApi }: { children: ReactNode; api?: StackdApi }) {
  const [running, setRunning] = useState<boolean | null>(null);
  const [socket, setSocket] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let live = true;
    const offs = [
      api.onStatus((r, s) => {
        setRunning(r);
        setSocket(s);
        if (!r) setSnapshot(null);
      }),
      api.onState((s) => setSnapshot((prev) => (prev && prev.seq > s.seq ? prev : s))),
    ];
    // Events that fired before the listeners existed are in `latest`.
    void api.latest().then((l) => {
      if (!live) return;
      setRunning((r) => r ?? l.running);
      setSocket(l.socket);
      setSnapshot((prev) => prev ?? l.snapshot);
    }).catch(() => setRunning((r) => r ?? false));
    return () => {
      live = false;
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, [api]);

  const value = useMemo(() => ({ running, socket, snapshot, api }), [running, socket, snapshot, api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStackd(): StackdStatus {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStackd outside StackdProvider');
  return v;
}
