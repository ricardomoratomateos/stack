import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Shown while no stackd answers: start it once, or let launchd start it at login.
 * Nothing starts without a click here (or the tray's "Start stackd at login").
 */
export function StartStackd({ socket }: { socket: string }) {
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // This screen unmounts as soon as stackd answers; still here after a few seconds means it died.
  useEffect(() => {
    if (startedAt === null) return;
    const t = setTimeout(() => setError('stackd did not come up. The reason is at the end of ~/.config/stack/stackd.log.'), 6000);
    return () => clearTimeout(t);
  }, [startedAt]);

  useEffect(() => {
    void invoke<boolean>('stackd_login_status').then(setLogin).catch(() => {});
    const un = listen<boolean>('stackd://login', (e) => setLogin(e.payload));
    return () => { void un.then((f) => f()); };
  }, []);

  const run = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await what(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="empty">
      <h1>stackd is not running</h1>
      <p>stackd keeps your agents and tasks going while the app is closed. It needs Node.js 20+ on this Mac.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => void run(async () => { await invoke('stackd_start_now'); setStartedAt(Date.now()); })}>
          {startedAt !== null && !error ? 'Starting…' : 'Start stackd now'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => invoke('stackd_set_login', { enabled: !login }))}>
          {login ? 'Stop starting stackd at login' : 'Start stackd at login'}
        </button>
      </div>
      {error && <p className="dim" role="alert">{error}</p>}
      <p className="dim">Looking for <code>{socket}</code> · log <code>~/.config/stack/stackd.log</code></p>
    </div>
  );
}
