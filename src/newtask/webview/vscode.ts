import type { NewTaskMessage } from '../types';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

export const send = (msg: NewTaskMessage) => api.postMessage(msg);
