import { useEffect, useMemo } from 'react';
import type { WorktreeItem } from '@core/webview/types';
import type { StackdApi } from '../stackd/api';
import { CodeHost } from './CodeHost';

/**
 * Dev-only page: the Code tab on its own, without the app or stackd. The same `code*` commands, answered by
 * `desktop/scripts/code-dev-backend.mjs` (stackd's CodeService over localhost) for one directory.
 *   /?dev=code[&api=http://127.0.0.1:1431][&file=src/a.ts][&line=12]
 */
export default function DevCode() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const base = params.get('api') ?? 'http://127.0.0.1:1431';
  const api = useMemo(() => ({
    command: async (name: string, body?: Record<string, unknown>) => {
      const res = await fetch(`${base}/commands/${name}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
      const answer = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
      if (!answer.ok) throw new Error(answer.error ?? `HTTP ${res.status}`);
      return answer.result;
    },
  }) as unknown as StackdApi, [base]);
  const file = params.get('file');
  const target = useMemo(() => (file ? { path: file, line: Number(params.get('line')) || undefined, tick: 1 } : undefined), [file, params]);

  useEffect(() => { document.documentElement.classList.add('fm-aside'); }, []); // the palette the app's chrome uses (App.tsx)

  return (
    <div className="dev-code">
      <CodeHost worktree={{ id: 'dev', name: 'dev' } as unknown as WorktreeItem} api={api} target={target} onClose={() => {}} />
    </div>
  );
}
