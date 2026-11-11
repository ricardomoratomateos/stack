import { invoke } from '@tauri-apps/api/core';
import type { Mode, Side } from './layout';

export interface Frame { x: number; y: number; w: number; h: number }
export interface Frames { full?: Frame; float?: Frame }

const KEY = 'stack.windowFrames';

export function loadFrames(): Frames {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Frames; } catch { return {}; }
}
export function saveFrames(f: Frames): void {
  try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* lasts until reload */ }
}

export const windowFrame = (): Promise<Frame> => invoke('window_frame');

/** Move/size the OS window for a mode (a no-op error outside Tauri, e.g. the browser dev server). */
export async function applyWindowMode(mode: Mode, side: Side, frame?: Frame): Promise<void> {
  await invoke('set_window_mode', { mode, side, frame: frame ?? null });
}
