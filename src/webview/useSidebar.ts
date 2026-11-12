import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { send } from './vscode';
import { usePointerReorder, type ReorderProps } from './usePointerReorder';
import { describe, describeAll, type Described } from './derive';
import type { ExtMessage, StackState, WorktreeItem } from './types';

function initialState(): StackState {
  return { worktrees: [] };
}

function reducer(current: StackState, msg: ExtMessage): StackState {
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
  /** Spread on the row: it can be dragged (when allowed) and the rows around it make way. */
  props: ReorderProps;
  /** This row is the one being dragged. */
  dragging: boolean;
}

/**
 * Drag-to-reorder for worktrees. The main checkout stays pinned first by the
 * extension, so it cannot be dragged (it can still be dropped onto), and
 * neither can a worktree that is being deleted or is gone.
 */
export function useWorktreeDrag(worktrees: WorktreeItem[]) {
  const ids = useRef<string[]>([]);
  const commit = useCallback((fromId: string, toId: string) => {
    const from = ids.current.indexOf(fromId);
    const to = ids.current.indexOf(toId);
    if (from === -1 || to === -1 || from === to) return undefined;
    const next = [...ids.current];
    next.splice(to, 0, next.splice(from, 1)[0]);
    send({ type: 'reorderWorktrees', orderedIds: next });
    return next;
  }, []);
  const { bind, dragKey, order } = usePointerReorder<string>('wt', commit);
  // The order on screen (a drop's, until the host confirms it), so a second drag starts from it.
  ids.current = order(worktrees, (w) => w.id).map((w) => w.id);

  const dragFor = useCallback((wt: WorktreeItem): DragBinding => {
    const draggable = !wt.isMain && !wt.isControl && !wt.deleting && !wt.missing;
    return { props: bind(wt.id, draggable), dragging: dragKey === wt.id };
  }, [bind, dragKey]);
  return { dragFor, order };
}

export interface Sidebar {
  state: StackState;
  loaded: boolean;
  items: Described[];
  /** The standing control session, described the same way a task is — pinned above `items`, never inside it. */
  controlItem?: Described;
  selectedId: string | null;
  select: (id: string) => void;
  dragFor: (wt: WorktreeItem) => DragBinding;
  now: number;
}

/**
 * Everything the layout draws from: the state the extension pushes, which
 * worktree is selected, the derived groups, drag-to-reorder and the clock.
 * The layout only draws it.
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

  const { dragFor, order } = useWorktreeDrag(state.worktrees);
  const items = useMemo(() => order(describeAll(state), (d) => d.wt.id), [state, order]);
  const controlItem = useMemo(
    () => (state.controlSession ? describe(state.controlSession, state.dockerUnavailable) : undefined),
    [state.controlSession, state.dockerUnavailable],
  );

  return { state, loaded, items, controlItem, selectedId: selected, select, dragFor, now };
}
