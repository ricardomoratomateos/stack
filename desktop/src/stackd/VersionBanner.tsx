import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStackd } from './useStackd';
import { APP_VERSION, stackdDrift } from './version';

/**
 * A running stackd from another build (the app was updated, stackd kept running): offer to
 * restart it as the app starts it. Agents keep running — they live in tmux, not in stackd.
 */
export function VersionBanner() {
  const { running, snapshot } = useStackd();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const drift = running && snapshot ? stackdDrift(APP_VERSION, snapshot.version) : null;
  if (!drift) return null;

  const restart = async () => {
    setBusy(true);
    setError('');
    try {
      await invoke('stackd_restart');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="version-banner" role="status">
      <span title={`stackd ${snapshot?.version ?? '(no version)'} · app ${APP_VERSION}`}>
        stackd is {drift === 'older' ? 'an older' : 'a newer'} version{error ? ` — ${error}` : ''}
      </span>
      <button type="button" disabled={busy} onClick={() => void restart()}>{busy ? 'Restarting…' : 'Restart'}</button>
    </div>
  );
}
