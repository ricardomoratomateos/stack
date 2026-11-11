import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PaneInfo } from './paneBook';

export interface TmuxApi {
  connect(socket: string | null, session: string, create?: boolean): Promise<PaneInfo[]>;
  disconnect(session?: string): Promise<void>;
  listPanes(session: string): Promise<PaneInfo[]>;
  setVisible(panes: string[]): Promise<void>;
  write(pane: string, data: number[]): Promise<void>;
  resize(pane: string, cols: number, rows: number): Promise<void>;
  capture(pane: string, start: number, end?: number): Promise<string>;
  onOutput(cb: (pane: string, b64: string) => void): Promise<UnlistenFn>;
  onLayout(cb: (session: string) => void): Promise<UnlistenFn>;
  onExit(cb: (session: string) => void): Promise<UnlistenFn>;
}

export const tmux: TmuxApi = {
  connect: (socket, session, create) => invoke('connect', { socket, session, create }),
  disconnect: (session) => invoke('disconnect', { session: session ?? null }),
  listPanes: (session) => invoke('list_panes', { session }),
  setVisible: (panes) => invoke('set_visible', { panes }),
  write: (pane, data) => invoke('write', { pane, data }),
  resize: (pane, cols, rows) => invoke('resize', { pane, cols, rows }),
  capture: (pane, start, end) => invoke('capture', { pane, start, end: end ?? null }),
  onOutput: (cb) => listen<{ pane: string; data: string }>('tmux://output', (e) => cb(e.payload.pane, e.payload.data)),
  onLayout: (cb) => listen<{ session: string }>('tmux://layout', (e) => cb(e.payload.session)),
  onExit: (cb) => listen<{ session: string }>('tmux://exit', (e) => cb(e.payload.session)),
};
