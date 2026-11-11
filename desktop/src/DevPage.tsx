import { useState } from 'react';
import { ManagerStrip, PaneTerminal, useTerminals } from './terminals';

/** Dev page: connect to a session, pick a pane to show and one for the strip. */
export function DevPage() {
  const { panes, connected, error, connect, disconnect } = useTerminals();
  const [socket, setSocket] = useState('');
  const [session, setSession] = useState('0');
  const [shown, setShown] = useState<string | null>(null);
  const [strip, setStrip] = useState<string | null>(null);
  const label = (p: (typeof panes)[number]) => `${p.id}  ${p.window_index}:${p.window_name}  ${p.command}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', font: '13px system-ui', background: '#1b1b1b', color: '#ddd' }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, alignItems: 'center' }}>
        <input placeholder="socket (-L), empty = default" value={socket} onChange={(e) => setSocket(e.target.value)} />
        <input placeholder="session" value={session} onChange={(e) => setSession(e.target.value)} />
        {connected ? (
          <button onClick={() => void disconnect()}>Disconnect</button>
        ) : (
          <button onClick={() => void connect(socket || null, session)}>Connect</button>
        )}
        <select value={shown ?? ''} onChange={(e) => setShown(e.target.value || null)}>
          <option value="">show pane…</option>
          {panes.map((p) => (
            <option key={p.id} value={p.id}>{label(p)}</option>
          ))}
        </select>
        <select value={strip ?? ''} onChange={(e) => setStrip(e.target.value || null)}>
          <option value="">manager strip pane…</option>
          {panes.map((p) => (
            <option key={p.id} value={p.id}>{label(p)}</option>
          ))}
        </select>
        {error && <span style={{ color: '#f66' }}>{error}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{shown && <PaneTerminal key={shown} pane={shown} />}</div>
      <ManagerStrip pane={strip} lines={6} />
    </div>
  );
}
