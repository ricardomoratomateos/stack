import type { SettingsMessage } from '../types';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

export const send = (msg: SettingsMessage) => api.postMessage(msg);
