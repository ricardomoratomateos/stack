import { log } from '../log';
import { useEffect, useMemo, useState } from 'react';
import { useStackd } from '../stackd/useStackd';
import { useTerminals } from '../terminals';

export interface Target {
  worktreeId: string;
  /** tmux window index of the session. */
  index: number;
}

export interface Resolved {
  pane: string | null;
  session: string | null;
  error: string | null;
}

/**
 * Sessions already resolved this run, by `worktreeId:index`. Coming back to a
 * tab shows its pane at once from here (its terminal kept its content); the
 * round trip to stackd and tmux still runs, behind it, to catch a session that
 * moved or went away.
 */
const resolved = new Map<string, string>();

/**
 * Resolves a session to its tmux pane: asks stackd where it lives
 * (`attachTarget`), connects to that tmux session (one connection per
 * session, shared), and finds the pane of the window.
 */
export function useSessionPane(target: Target | null, onSession?: (worktreeId: string, session: string) => void): Resolved {
  const { api } = useStackd();
  const { connect, panes, refresh } = useTerminals();
  const [attached, setAttached] = useState<{ key: string; session: string } | { key: string; error: string } | null>(null);
  const key = target ? `${target.worktreeId}:${target.index}` : null;

  useEffect(() => {
    if (!target || !key) {
      setAttached(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        log('info', 'attach', key);
        const started = performance.now();
        // select: false — the app picks the pane itself; tmux's current window is no business of ours.
        const t = await api.command<{ socket?: string; session: string }>('attachTarget', { worktreeId: target.worktreeId, windowIndex: target.index, select: false });
        log('info', 'attach target', key, t.session);
        let list = await connect(t.socket ?? null, t.session);
        // tmux sometimes answers the first list-panes of a fresh connection with nothing: ask again.
        for (let delay = 100; live && !list.some((p) => p.window_index === target.index) && delay <= 1600; delay *= 2) {
          await new Promise((r) => setTimeout(r, delay));
          list = await refresh(t.session);
          log('info', 'relisted', key, list.length);
        }
        log('info', 'connected', key, list.map((p) => `${p.id}@${p.window_index}`).join(','), `${Math.round(performance.now() - started)}ms`, live ? '' : '(stale)');
        if (!live) return;
        resolved.set(key, t.session);
        onSession?.(target.worktreeId, t.session);
        setAttached({ key, session: t.session });
      } catch (e) {
        log('error', 'attach failed', key, e);
        resolved.delete(key);
        if (live) setAttached({ key, error: String(e).replace(/^Error: /, '') });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);

  return useMemo(() => {
    const known = key ? resolved.get(key) : undefined;
    const mine = attached && attached.key === key ? attached : known ? { key: key!, session: known } : null;
    if (!target || !mine) return { pane: null, session: null, error: null };
    if ('error' in mine) return { pane: null, session: null, error: mine.error };
    const inWindow = panes.filter((p) => p.session === mine.session && p.window_index === target.index);
    const pane = inWindow.find((p) => p.active) ?? inWindow[0];
    return { pane: pane?.id ?? null, session: mine.session, error: null };
  }, [attached, key, panes, target]);
}
