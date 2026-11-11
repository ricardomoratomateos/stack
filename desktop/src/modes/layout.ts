/**
 * Window modes and panel sizes. Pure: the app keeps one `LayoutState`, the
 * Rust side only moves/sizes the window. Sizes are remembered per mode.
 */
export type Mode = 'full' | 'half' | 'float';
export type Side = 'left' | 'right';
export const MODES: readonly Mode[] = ['full', 'half', 'float'];

/** Height of one line of the Manager strip, in px (the strip snaps to whole lines). */
export const LINE_H = 16;
export const LINES = { min: 3, max: 12, default: 6 } as const;

export interface Sizes {
  /** Sidebar width, px (Full and Half). */
  sidebar: number;
  /** Manager column width, px (Full). */
  manager: number;
  /** Manager strip: lines shown (Half and Float). */
  lines: number;
}
export type SizeKey = keyof Sizes;

export interface LayoutState {
  mode: Mode;
  side: Side;
  sizes: Record<Mode, Sizes>;
}

export const DEFAULT_SIZES: Record<Mode, Sizes> = {
  full: { sidebar: 340, manager: 440, lines: LINES.default },
  half: { sidebar: 220, manager: 440, lines: LINES.default },
  float: { sidebar: 220, manager: 440, lines: LINES.default },
};

/** Min/max per size (px, or lines). Half keeps the sidebar narrower so the session has room. */
export function limits(mode: Mode, key: SizeKey): { min: number; max: number } {
  if (key === 'lines') return { min: LINES.min, max: LINES.max };
  if (key === 'manager') return { min: 280, max: 900 };
  return mode === 'half' ? { min: 160, max: 360 } : { min: 200, max: 600 };
}

export const clampTo = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export function clampSize(mode: Mode, key: SizeKey, v: number): number {
  const { min, max } = limits(mode, key);
  const n = Number.isFinite(v) ? v : DEFAULT_SIZES[mode][key];
  return clampTo(key === 'lines' ? Math.round(n) : n, min, max);
}

export const initialLayout = (): LayoutState => ({ mode: 'full', side: 'right', sizes: structuredClone(DEFAULT_SIZES) });

export function setMode(s: LayoutState, mode: Mode, side: Side = s.side): LayoutState {
  return mode === s.mode && side === s.side ? s : { ...s, mode, side };
}

/** Full → Half → Float → Full. */
export function nextMode(mode: Mode): Mode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

export function resize(s: LayoutState, mode: Mode, key: SizeKey, v: number): LayoutState {
  const value = clampSize(mode, key, v);
  if (s.sizes[mode][key] === value) return s;
  return { ...s, sizes: { ...s.sizes, [mode]: { ...s.sizes[mode], [key]: value } } };
}

export const resetSize = (s: LayoutState, mode: Mode, key: SizeKey): LayoutState => resize(s, mode, key, DEFAULT_SIZES[mode][key]);

/** Strip height for `lines` lines, px. */
export const heightFromLines = (lines: number): number => lines * LINE_H;
/** The whole number of lines closest to `px`, within the allowed range. */
export const linesFromHeight = (px: number): number => clampSize('half', 'lines', Math.round(px / LINE_H));

/**
 * New size while dragging a splitter that started at `start` and moved by `delta` px.
 * `invert`: the panel is on the far side of the handle (growing means moving towards the origin).
 */
export function dragValue(start: number, delta: number, min: number, max: number, invert = false): number {
  return clampTo(start + (invert ? -delta : delta), min, max);
}

/** Widest a side panel may be so the session in the middle keeps `centreMin` px. */
export function maxPanelWidth(containerWidth: number, others: number, centreMin = 320): number {
  return Math.max(0, containerWidth - others - centreMin);
}

// ── maximize (double-click a tab / the Manager header, ⌘⇧Enter) ─────────────

/** Which panel fills the window; `null` = the normal layout. Not stored with the sizes, so restoring is just `null`. */
export type Maximized = 'session' | 'manager' | null;

/** Double-click on a panel: maximize it, or restore when it already is. */
export const toggleMaximized = (cur: Maximized, target: 'session' | 'manager'): Maximized => (cur === target ? null : target);

/**
 * ⌘⇧Enter. Full/Half: maximize the session, or restore. Float: session -> Manager-only -> restore.
 */
export function cycleMaximized(cur: Maximized, mode: Mode): Maximized {
  if (cur === null) return 'session';
  if (mode === 'float' && cur === 'session') return 'manager';
  return null;
}

// ── persistence ─────────────────────────────────────────────────────────────

export const LAYOUT_KEY = 'stack.layout';

export const serializeLayout = (s: LayoutState): string => JSON.stringify(s);

/** Lenient: anything missing or out of range falls back to the defaults. */
export function parseLayout(raw: string | null | undefined): LayoutState {
  const out = initialLayout();
  if (!raw) return out;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return out; }
  if (!j || typeof j !== 'object') return out;
  const o = j as { mode?: unknown; side?: unknown; sizes?: Record<string, Partial<Record<SizeKey, unknown>>> };
  if (MODES.includes(o.mode as Mode)) out.mode = o.mode as Mode;
  if (o.side === 'left' || o.side === 'right') out.side = o.side;
  for (const m of MODES) {
    for (const k of ['sidebar', 'manager', 'lines'] as const) {
      const v = o.sizes?.[m]?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) out.sizes[m][k] = clampSize(m, k, v);
    }
  }
  return out;
}

export function loadLayout(): LayoutState {
  try { return parseLayout(localStorage.getItem(LAYOUT_KEY)); } catch { return initialLayout(); }
}

export function saveLayout(s: LayoutState): void {
  try { localStorage.setItem(LAYOUT_KEY, serializeLayout(s)); } catch { /* the layout lasts until reload */ }
}

/** `?mode=half|float|full` (dev: start in a mode without touching the saved one). */
export function modeFromQuery(search: string): Mode | undefined {
  const v = new URLSearchParams(search).get('mode');
  return MODES.find((m) => m === v);
}

// ── Manager strip ───────────────────────────────────────────────────────────

/** What typing a line into the strip sends to the Manager pane: the text, then Enter. */
export function stripInput(text: string): number[] {
  return [...new TextEncoder().encode(text.replace(/[\r\n]+/g, ' ')), 13];
}

/** The strip shows `n` rows; pad at the top so a short buffer still fills it. */
export function stripRows(lines: string[], n: number): string[] {
  const tail = lines.slice(-n);
  return [...Array<string>(Math.max(0, n - tail.length)).fill(''), ...tail];
}
