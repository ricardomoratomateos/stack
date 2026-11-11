import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { StackState } from '@core/webview/types';

/** One repository's slice of stackd's snapshot (see src/daemon/StackDaemon.ts). */
export interface RepoSnapshot {
  repoRoot: string;
  state: StackState;
}

export interface Snapshot {
  seq: number;
  tmux: { socket?: string };
  repos: RepoSnapshot[];
}

export interface Latest {
  running: boolean;
  socket: string;
  snapshot: Snapshot | null;
}

export interface StackdApi {
  latest(): Promise<Latest>;
  command<T = unknown>(name: string, body?: Record<string, unknown>): Promise<T>;
  onStatus(cb: (running: boolean, socket: string) => void): Promise<UnlistenFn>;
  onState(cb: (snapshot: Snapshot) => void): Promise<UnlistenFn>;
}

export const stackd: StackdApi = {
  latest: () => invoke('stackd_latest'),
  command: (name, body) => invoke('stackd_command', { name, body: body ?? {} }),
  onStatus: (cb) => listen<{ running: boolean; socket: string }>('stackd://status', (e) => cb(e.payload.running, e.payload.socket)),
  onState: (cb) => listen<Snapshot>('stackd://state', (e) => cb(e.payload)),
};
