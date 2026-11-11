import { invoke } from '@tauri-apps/api/core';

/** Lines go to ~/Library/Logs/Stack/app.log as well as the console (the bundled app has no devtools). */
export function log(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  const message = parts.map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : safeJson(p))).join(' ');
  if ('__TAURI_INTERNALS__' in window) void invoke('log_line', { level, message }).catch(() => {});
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Mirror console.warn/error and uncaught errors into the log. */
export function installLogging(): void {
  for (const level of ['warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      log(level, ...args);
    };
  }
  window.addEventListener('error', (e) => log('error', 'uncaught', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => log('error', 'unhandled rejection', e.reason));
  log('info', 'app start', location.href);
}
