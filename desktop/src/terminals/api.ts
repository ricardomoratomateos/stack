import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PaneInfo } from './paneBook';
import { decodeFrame } from './bytes';

export interface TmuxApi {
  connect(socket: string | null, session: string, create?: boolean): Promise<PaneInfo[]>;
  disconnect(session?: string): Promise<void>;
  listPanes(session: string): Promise<PaneInfo[]>;
  /** Tell the backend `bytes` of output were consumed (flow control). */
  ackOutput(bytes: number): Promise<void>;
  setVisible(panes: string[]): Promise<void>;
  write(pane: string, data: number[]): Promise<void>;
  resize(pane: string, cols: number, rows: number): Promise<void>;
  capture(pane: string, start: number, end?: number): Promise<string>;
  /** Pane output as raw bytes (one binary `Channel`, no base64). Resolves once subscribed. */
  onOutput(cb: (pane: string, data: Uint8Array) => void): Promise<UnlistenFn>;
  onLayout(cb: (session: string) => void): Promise<UnlistenFn>;
  onExit(cb: (session: string) => void): Promise<UnlistenFn>;
}

export const tmux: TmuxApi = {
  connect: (socket, session, create) => invoke('connect', { socket, session, create }),
  disconnect: (session) => invoke('disconnect', { session: session ?? null }),
  listPanes: (session) => invoke('list_panes', { session }),
  ackOutput: (bytes) => invoke('ack_output', { bytes }),
  setVisible: (panes) => invoke('set_visible', { panes }),
  write: (pane, data) => invoke('write', { pane, data }),
  resize: (pane, cols, rows) => invoke('resize', { pane, cols, rows }),
  capture: (pane, start, end) => invoke('capture', { pane, start, end: end ?? null }),
  onOutput: async (cb) => {
    const channel = new Channel<ArrayBuffer | number[]>();
    channel.onmessage = (m) => {
      const f = decodeFrame(m instanceof ArrayBuffer ? m : new Uint8Array(m));
      if (f) cb(f.pane, f.data);
    };
    await invoke('subscribe_output', { channel });
    return () => {
      channel.onmessage = () => {};
    };
  },
  onLayout: (cb) => listen<{ session: string }>('tmux://layout', (e) => cb(e.payload.session)),
  onExit: (cb) => listen<{ session: string }>('tmux://exit', (e) => cb(e.payload.session)),
};
