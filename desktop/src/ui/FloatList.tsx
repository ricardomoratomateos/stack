import { StatusDot } from '@core/webview/components/StatusDot';
import { stateWord, type FloatRow } from '../model';

/** Float's compact worktree list: one line per worktree with its sessions; the one asking shows Allow. */
export function FloatList({ rows, selectedId, onSelect, onAllow }: {
  rows: FloatRow[];
  selectedId: string | undefined;
  onSelect: (id: string, index?: number) => void;
  onAllow: (id: string, index: number) => void;
}) {
  return (
    <ul className="float-list" aria-label="Tasks">
      {rows.map((r) => (
        <li key={r.id} className="float-row" data-selected={r.id === selectedId || undefined} data-group={r.group}>
          <button type="button" className="float-name" onClick={() => onSelect(r.id)} title={r.name}>
            <StatusDot group={r.group} /><span className="float-name-text">{r.name}</span>
          </button>
          <span className="float-sessions">
            {r.sessions.map((s) => (
              <button key={s.index} type="button" className="float-session" data-state={s.state} title={`${s.name}: ${stateWord(s.state, s.turned)}`} onClick={() => onSelect(r.id, s.index)}>
                <StatusDot state={s.state} size="sm" />{s.name}
              </button>
            ))}
          </span>
          {r.asking && <button type="button" className="float-allow" title={r.asking.label} onClick={() => onAllow(r.id, r.asking!.index)}>Allow</button>}
        </li>
      ))}
    </ul>
  );
}
