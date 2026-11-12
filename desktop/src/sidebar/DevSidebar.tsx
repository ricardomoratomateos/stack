import { useMemo, useState } from 'react';
import { sampleState } from './fixtures';
import { describeCounts, translate } from './bridge';
import { ViewTitle } from './ViewTitle';
import { SidebarHost } from './SidebarHost';

/**
 * Dev-only page: the sidebar on a fixed sample state, to compare with VS Code side by side.
 *   /?dev=sidebar[&width=340]
 */
export function DevSidebar() {
  const params = new URLSearchParams(location.search);
  const width = Number(params.get('width')) || 340;
  const [selected, setSelected] = useState('ask');
  const [last, setLast] = useState('');
  const state = useMemo(() => ({ ...sampleState(), host: 'desktop' as const, activeWorktreeId: selected }), [selected]);
  const ctx = useMemo(() => ({ repoRoot: '/r', worktrees: [...state.worktrees, ...(state.controlSession ? [state.controlSession] : [])] }), [state]);

  return (
    <div className="dev-sidebar" style={{ width }}>
      <ViewTitle counts={describeCounts(state)} onAdd={() => {}} />
      <div className="sidebar-body">
        <SidebarHost
          state={state}
          onMessage={(m) => {
            const a = translate(m, ctx);
            if (a.kind === 'select') setSelected(a.worktreeId);
            setLast(`${m.type} -> ${a.kind}`);
          }}
        />
      </div>
      <div className="dev-last">{last}</div>
    </div>
  );
}
