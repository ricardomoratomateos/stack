import { StatusDot } from '@core/webview/components/StatusDot';
import { useEffect, useRef } from 'react';
import type { SwitcherRow } from '../model';

/** ⌃Tab overlay: worktrees and the Manager in MRU order. Keys are handled by App; this only draws and takes clicks. */
export function Switcher({ rows, index, onPick }: { rows: SwitcherRow[]; index: number; onPick: (id: string) => void }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => { ref.current?.children[index]?.scrollIntoView({ block: 'nearest' }); }, [index]);
  return (
    <div className="switcher-backdrop">
      <ul className="switcher" ref={ref} role="listbox" aria-label="Switch worktree">
        {rows.map((r, i) => (
          <li key={r.id} className="switcher-row" role="option" aria-selected={i === index} data-selected={i === index || undefined} data-state={r.state}
            onMouseDown={(e) => { e.preventDefault(); onPick(r.id); }}>
            <StatusDot state={r.state} size="sm" />
            <span className="switcher-name">{r.name}</span>
            <span className="switcher-line">{r.line}</span>
            <span className="switcher-hint">{r.hint}</span>
          </li>
        ))}
        <li className="switcher-foot" role="presentation">⌃Tab cambiar · ⌥⌘↑↓ anterior/siguiente · ⌘⇧J te necesita</li>
      </ul>
    </div>
  );
}
