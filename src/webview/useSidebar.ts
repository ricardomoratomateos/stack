import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { getState, send, setState } from './vscode';
import { normalizeSidebarStyle } from '../sidebarStyle';
import { describeAll, type Described } from './derive';
import type { ExtMessage, ForemanState, WorktreeItem } from './types';

/**
 * The style the sidebar wore last time, so a reload paints it from the first
 * frame instead of flashing the default until the extension's first push.
 */
function initialState(): ForemanState {
  const saved = (getState() as { sidebarStyle?: unknown } | null | undefined)?.sidebarStyle;
  return { worktrees: [], sidebarStyle: saved === undefined ? undefined : normalizeSidebarStyle(saved) };
}

function reducer(current: ForemanState, msg: ExtMessage): ForemanState {
  return msg.type === 'state' ? msg.payload : current;
}

/** Re-renders on an interval, so ages ("5m") keep counting between pushes. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export interface DragBinding {
  /** Spread on the element that should be draggable and accept drops. */
  props: {
    draggable: boolean;
    onDragStart?: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  dragging: boolean;
  /** Something is being dragged over this one: it is where the drop would land. */
  over: boolean;
}

/**
 * Drag-to-reorder for worktrees. The main checkout stays pinned first by the
 * extension, so it cannot be dragged (it can still be dropped onto), and
 * neither can a worktree that is being deleted or is gone.
 */
export function useWorktreeDrag(worktrees: WorktreeItem[]): (wt: WorktreeItem) => DragBinding {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const commit = useCallback((fromId: string, toId: string) => {
    const ids = worktrees.map((w) => w.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...ids];
    next.splice(to, 0, next.splice(from, 1)[0]);
    send({ type: 'reorderWorktrees', orderedIds: next });
  }, [worktrees]);

  return useCallback((wt) => {
    const draggable = !wt.isMain && !wt.deleting && !wt.missing;
    const end = () => { setDragId(null); setOverId(null); };
    return {
      props: {
        draggable,
        onDragStart: draggable ? (e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(wt.id); } : undefined,
        onDragEnter: (e) => { e.preventDefault(); setOverId(wt.id); },
        onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
        onDrop: (e) => { e.preventDefault(); if (dragId) commit(dragId, wt.id); end(); },
        onDragEnd: end,
      },
      dragging: dragId === wt.id,
      over: overId === wt.id && dragId !== null && dragId !== wt.id,
    };
  }, [dragId, overId, commit]);
}

export interface Sidebar {
  state: ForemanState;
  loaded: boolean;
  items: Described[];
  selectedId: string | null;
  select: (id: string) => void;
  dragFor: (wt: WorktreeItem) => DragBinding;
  now: number;
}

/**
 * Everything the three layouts share: the state the extension pushes, which
 * worktree is selected, the derived groups, drag-to-reorder and the clock.
 * The layouts only draw it.
 */
export function useSidebar(): Sidebar {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      dispatch(e.data as ExtMessage);
      setLoaded(true);
    };
    window.addEventListener('message', handler);
    // Announce only AFTER the listener exists, so the reply cannot be missed.
    send({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!loaded || !state.sidebarStyle) return;
    // Merged into the existing webview state, never clobbering whatever else is in it.
    setState({ ...((getState() as Record<string, unknown> | null) ?? {}), sidebarStyle: state.sidebarStyle });
  }, [loaded, state.sidebarStyle]);

  // When the extension tells us the active worktree, always follow it (reload / terminal focus)
  useEffect(() => {
    if (state.activeWorktreeId && state.worktrees.length > 0) setSelected(state.activeWorktreeId);
  }, [state.activeWorktreeId, state.worktrees.length]);

  // Fallback: select the first worktree only when nothing is selected yet
  useEffect(() => {
    if (!selected && state.worktrees.length > 0 && !state.activeWorktreeId) setSelected(state.worktrees[0].id);
  }, [state.worktrees, selected, state.activeWorktreeId]);

  const select = useCallback((id: string) => {
    setSelected(id);
    send({ type: 'selectWorktree', worktreeId: id });
  }, []);

  const items = useMemo(() => describeAll(state), [state]);
  const dragFor = useWorktreeDrag(state.worktrees);

  return { state, loaded, items, selectedId: selected, select, dragFor, now };
}
