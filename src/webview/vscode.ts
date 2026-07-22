import type { WebMessage } from './types';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

export const send = (msg: WebMessage) => api.postMessage(msg);
export const getState = () => api.getState();
export const setState = (s: unknown) => api.setState(s);
