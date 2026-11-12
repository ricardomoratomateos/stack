import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** The start the app makes by itself when it opens and no stackd answers (see commands.rs). */
interface Autostart { attempted: boolean; done: boolean; error: string | null }

const LOADED_AT = Date.now();

/**
 * Shown while no stackd answers. The app starts one by itself when it opens (under the login
 * agent if installed, else detached); this screen says so, and offers a retry and the tray's
 * "Start stackd at login" switch.
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
    // Only the screen shown at app open is about that start; a later one (stackd died) is not.
    const atOpen = Date.now() - LOADED_AT < 15_000;
    const follow = (a: Autostart) => {
      if (!atOpen || !a.attempted) return;
      if (a.error) setError(a.error);
      else setStartedAt((t) => t ?? Date.now());
    };
    void invoke<Autostart>('stackd_autostart').then(follow).catch(() => {});
    const unAuto = listen<Autostart>('stackd://autostart', (e) => follow(e.payload));
    return () => { void un.then((f) => f()); void unAuto.then((f) => f()); };
  }, []);

  const run = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await what(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="empty">
      <h1>{startedAt !== null && !error ? 'Starting stackd…' : 'stackd is not running'}</h1>
      <p>stackd keeps your agents and tasks going while the app is closed. It needs Node.js 20+ on this Mac.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={busy || (startedAt !== null && !error)} onClick={() => void run(async () => { setStartedAt(null); await invoke('stackd_start_now'); setStartedAt(Date.now()); })}>
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
