import { useCallback, useRef, useState } from 'react';

/** Pointer travel (px) before a press becomes a drag; below it, the press stays a click. */
const DRAG_THRESHOLD = 4;
/** How long the order a drop chose is held while the host confirms it; then the host's order wins. */
const PENDING_MS = 2000;
const SHIFT = 'transform 150ms ease';
const ATTR = 'data-reorder';
const FIXED = 'data-reorder-fixed';

export interface ReorderProps {
  'data-reorder': string;
  'data-reorder-fixed'?: '';
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

/**
 * Drag-to-reorder like browser tabs, on pointer events rather than HTML5 drag
 * and drop (the desktop app's native file-drop handler swallows HTML5 drags
 * inside its webview; pointer events reach the page there and in VS Code).
 *
 * The dragged row itself goes translucent and follows the pointer up and down
 * its list; the rows it passes slide out of its way, so the list always shows
 * the order a drop would leave. On drop the new order is applied at once
 * (`order`) while the host persists it, so nothing jumps back meanwhile.
 *
 * `bind(key, canDrag)` goes on each row. Rows that cannot be dragged are fixed:
 * they neither move nor take a dragged row past them (the main checkout stays
 * first). `ns` keeps nested lists apart (sessions inside a worktree row).
 * `onCommit(from, to)` returns the full new key order, or undefined for none.
 */
export function usePointerReorder<K extends string | number>(ns: string, onCommit: (from: K, to: K) => K[] | undefined) {
  const [dragKey, setDragKey] = useState<K | null>(null);
  const [pending, setPending] = useState<K[] | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  /** Set between a drag's pointerup and the click the browser fires right after it. */
  const swallowClick = useRef(false);
  const prefix = `${ns}:`;

  const bind = useCallback((key: K, canDrag: boolean): ReorderProps => {
    const keyOf = (el: Element): K => {
      const raw = el.getAttribute(ATTR)!.slice(prefix.length);
      return (typeof key === 'number' ? Number(raw) : raw) as K;
    };
    return {
      [ATTR]: prefix + String(key),
      ...(canDrag ? {} : { [FIXED]: '' as const }),
      onPointerDown: canDrag ? (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0 || e.pointerType === 'touch') return;
        // A session row sits inside a worktree row: only the innermost list drags.
        e.stopPropagation();
        const row = e.currentTarget;
        const startX = e.clientX;
        const startY = e.clientY;
        let active = false;
        let rows: HTMLElement[] = [];
        let rects: DOMRect[] = [];
        let from = -1;
        let to = -1;
        let step = 0;
        let userSelect = '';

        const begin = () => {
          const parent = row.parentElement;
          if (!parent) return false;
          rows = Array.from(parent.children).filter((el): el is HTMLElement =>
            el instanceof HTMLElement && !!el.getAttribute(ATTR)?.startsWith(prefix) && !el.hasAttribute(FIXED));
          from = rows.indexOf(row);
          if (from === -1 || rows.length < 2) return false;
          to = from;
          rects = rows.map((r) => r.getBoundingClientRect());
          const gap = from + 1 < rects.length ? rects[from + 1].top - rects[from].bottom : rects[from].top - rects[from - 1].bottom;
          step = rects[from].height + Math.max(0, gap);
          for (const r of rows) if (r !== row) r.style.transition = SHIFT;
          Object.assign(row.style, { position: 'relative', zIndex: '2', opacity: '.55', transition: 'none', cursor: 'grabbing' });
          userSelect = document.body.style.userSelect;
          document.body.style.userSelect = 'none';
          setDragKey(key);
          return true;
        };

        const move = (ev: PointerEvent) => {
          if (!active) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
            if (!begin()) { cleanup(); return; }
            active = true;
          }
          // Stays within its list: no further than the first and last movable rows.
          const min = rects[0].top - rects[from].top;
          const max = rects[rects.length - 1].bottom - rects[from].bottom;
          const dy = Math.min(max, Math.max(min, ev.clientY - startY));
          row.style.transform = `translateY(${dy}px)`;
          const centre = rects[from].top + dy + rects[from].height / 2;
          to = from;
          for (let i = from + 1; i < rects.length; i++) if (centre > rects[i].top + rects[i].height / 2) to = i;
          for (let i = from - 1; i >= 0; i--) if (centre < rects[i].top + rects[i].height / 2) to = i;
          rows.forEach((r, i) => {
            if (i === from) return;
            const shift = from < i && i <= to ? -step : to <= i && i < from ? step : 0;
            r.style.transform = shift ? `translateY(${shift}px)` : '';
          });
        };

        const reset = () => {
          for (const r of rows) {
            r.style.transition = 'none';
            r.style.transform = '';
          }
          Object.assign(row.style, { position: '', zIndex: '', opacity: '', cursor: '' });
          // Let the reset land without animating, then give the rows their own transitions back.
          requestAnimationFrame(() => { for (const r of rows) r.style.transition = ''; });
          document.body.style.userSelect = userSelect;
        };

        const done = (ev: PointerEvent) => {
          cleanup();
          if (!active) return;
          if (ev.type === 'pointerup') {
            swallowClick.current = true;
            setTimeout(() => { swallowClick.current = false; }, 0);
          }
          const next = ev.type === 'pointerup' && to !== from ? commit.current(key, keyOf(rows[to])) : undefined;
          if (next) {
            // Moved rows would replay their fade-in; a reorder should just settle.
            document.documentElement.setAttribute('data-stack-reordering', '');
            setTimeout(() => document.documentElement.removeAttribute('data-stack-reordering'), 400);
            clearTimeout(pendingTimer.current);
            setPending(next);
            pendingTimer.current = setTimeout(() => setPending(null), PENDING_MS);
          }
          // Same task as the new order's render, so the rows never paint shifted twice.
          reset();
          setDragKey(null);
        };

        const cleanup = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', done);
          window.removeEventListener('pointercancel', done);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', done);
        window.addEventListener('pointercancel', done);
      } : undefined,
      // The press that ended a drag is not also a click (select / focus the row).
      onClickCapture: (e: React.MouseEvent) => {
        if (!swallowClick.current) return;
        e.preventDefault();
        e.stopPropagation();
      },
    };
  }, [prefix]);

  /** `list` in the order the last drop chose, until the host's own order arrives (or `PENDING_MS` pass). */
  const order = useCallback(<T,>(list: T[], keyFor: (item: T) => K): T[] => {
    if (!pending) return list;
    const pos = new Map(pending.map((k, i) => [k, i] as const));
    return [...list].sort((a, b) => (pos.get(keyFor(a)) ?? pending.length) - (pos.get(keyFor(b)) ?? pending.length));
  }, [pending]);

  return { bind, dragKey, order };
}
