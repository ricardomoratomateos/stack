import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { dragValue } from '../modes/layout';

interface Props {
  /** `col`: a vertical bar between side-by-side panels; `row`: a horizontal bar between stacked ones. */
  orientation: 'col' | 'row';
  /** Current size of the panel the bar resizes, px. */
  value: number;
  min: number;
  max: number;
  /** The panel is after the bar (right of / below it): dragging towards the origin grows it. */
  invert?: boolean;
  /** Double-click: back to this. */
  reset: number;
  label: string;
  onChange: (px: number) => void;
}

/** A draggable bar. Reports at most one size per animation frame; the terminals refit through their own ResizeObserver. */
export function Splitter({ orientation, value, min, max, invert, reset, label, onChange }: Props) {
  const drag = useRef<{ start: number; from: number } | null>(null);
  const raf = useRef(0);
  const pending = useRef<number | null>(null);
  const col = orientation === 'col';

  const flush = () => {
    raf.current = 0;
    if (pending.current !== null) onChange(pending.current);
    pending.current = null;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: col ? e.clientX : e.clientY, from: value };
    document.body.dataset.resizing = orientation;
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    pending.current = dragValue(d.from, (col ? e.clientX : e.clientY) - d.start, min, max, invert);
    if (!raf.current) raf.current = requestAnimationFrame(flush);
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    cancelAnimationFrame(raf.current);
    flush();
    delete document.body.dataset.resizing;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = col ? (invert ? 'ArrowLeft' : 'ArrowRight') : (invert ? 'ArrowUp' : 'ArrowDown');
    const shrink = col ? (invert ? 'ArrowRight' : 'ArrowLeft') : (invert ? 'ArrowDown' : 'ArrowUp');
    if (e.key === grow) onChange(Math.min(max, value + 16));
    else if (e.key === shrink) onChange(Math.max(min, value - 16));
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      aria-orientation={col ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onChange(reset)}
      onKeyDown={key}
    />
  );
}
