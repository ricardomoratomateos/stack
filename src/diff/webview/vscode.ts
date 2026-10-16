import type { DiffPanelMessage } from '../types';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

export const send = (msg: DiffPanelMessage) => api.postMessage(msg);

/** What survives the panel being hidden and restored: view preferences and what was marked viewed. */
export interface PanelState {
  format?: 'inline' | 'split';
  wrap?: boolean;
  treeOpen?: boolean;
  treeWidth?: number;
  collapsedDirs?: string[];
  viewed?: string[];
}

export const loadState = (): PanelState => {
  const s = api.getState();
  return s && typeof s === 'object' ? (s as PanelState) : {};
};
export const saveState = (s: PanelState) => api.setState(s);
