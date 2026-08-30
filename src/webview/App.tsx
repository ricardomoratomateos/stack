import { useCallback, useEffect, useReducer, useState } from 'react';
import { T } from './tokens';
import { WorktreeCard } from './components/WorktreeCard';
import { StatusPanel } from './components/StatusPanel';
import { send } from './vscode';
import type { ExtMessage, ForemanState, WorktreeItem } from './types';

const EMPTY: ForemanState = { worktrees: [] };

function reducer(_: ForemanState, msg: ExtMessage): ForemanState {
  if (msg.type === 'state') return msg.payload;
  return _;
}

export function App() {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      try {
        const msg = e.data as ExtMessage;
        dispatch(msg);
        setLoaded(true);
      } catch { /* ignore */ }
    };
    window.addEventListener('message', handler);
    // Announce only AFTER the listener exists, so the reply cannot be missed.
    send({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);


  // When the extension tells us the active worktree, always follow it (reload / terminal focus)
  useEffect(() => {
    if (state.activeWorktreeId && state.worktrees.length > 0) {
      setSelected(state.activeWorktreeId);
    }
  }, [state.activeWorktreeId, state.worktrees.length]);

  // Fallback: select the first worktree only when nothing is selected yet
  useEffect(() => {
    if (!selected && state.worktrees.length > 0 && !state.activeWorktreeId) {
      setSelected(state.worktrees[0].id);
    }
  }, [state.worktrees, selected, state.activeWorktreeId]);

  const handleSelect = useCallback((id: string) => {
    setSelected(id);
    send({ type: 'selectWorktree', worktreeId: id });
  }, []);

  // Drag-to-reorder worktree cards (main stays pinned first by the extension).
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [overCardId, setOverCardId] = useState<string | null>(null);

  const commitCardReorder = useCallback((fromId: string, toId: string) => {
    const ids = state.worktrees.map(w => w.id);
    const fromPos = ids.indexOf(fromId);
    const toPos = ids.indexOf(toId);
    if (fromPos === -1 || toPos === -1 || fromPos === toPos) return;
    const next = [...ids];
    next.splice(toPos, 0, next.splice(fromPos, 1)[0]);
    send({ type: 'reorderWorktrees', orderedIds: next });
  }, [state.worktrees]);

  const selectedWt: WorktreeItem | undefined = state.worktrees.find(w => w.id === selected);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.bg, position: 'relative' }}
    >

      {/* No in-webview title bar: the native view header carries the "Worktrees"
          title, the live counts (as its description) and the "+" button. */}

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Worktree list — scrollable, shrinks if status panel needs space */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 12px', display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 }}>
            {!loaded ? (
              <LoadingState />
            ) : state.worktrees.length === 0 ? (
              <EmptyState onNew={() => send({ type: 'openNewTask' })} />
            ) : (
              state.worktrees.map(wt => (
                <WorktreeCard
                  key={wt.id}
                  wt={wt}
                  isSelected={selected === wt.id}
                  onSelect={() => handleSelect(wt.id)}
                  defaultProvider={state.defaultProvider}
                  installedProviders={state.installedProviders}
                  dockerEnabled={state.dockerEnabled}
                  cardDragging={dragCardId === wt.id}
                  cardDragOver={overCardId === wt.id && dragCardId !== null && dragCardId !== wt.id}
                  onCardDragStart={() => setDragCardId(wt.id)}
                  onCardDragEnter={() => setOverCardId(wt.id)}
                  onCardDrop={() => { if (dragCardId) commitCardReorder(dragCardId, wt.id); setDragCardId(null); setOverCardId(null); }}
                  onCardDragEnd={() => { setDragCardId(null); setOverCardId(null); }}
                />
              ))
            )}
          </div>

          {/* Status panel for selected worktree */}
          {selectedWt && <StatusPanel wt={selectedWt} />}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flex: 1, gap: 5, padding: 24,
    }}>
      <span className="u-dot-1" style={{ width: 4, height: 4, borderRadius: '50%', background: T.textMuted, display: 'inline-block' }} />
      <span className="u-dot-2" style={{ width: 4, height: 4, borderRadius: '50%', background: T.textMuted, display: 'inline-block' }} />
      <span className="u-dot-3" style={{ width: 4, height: 4, borderRadius: '50%', background: T.textMuted, display: 'inline-block' }} />
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      flex: 1, gap: 12, padding: 24, textAlign: 'center',
    }}>
      <span style={{ fontSize: T.fontSize, color: T.textDim }}>No worktrees yet</span>
      <button
        onClick={onNew}
        style={{
          padding: '6px 14px', borderRadius: 2, border: `1px solid ${T.border}`,
          background: 'transparent', color: T.textDim, fontSize: T.fontSize,
        }}
      >
        + New task
      </button>
    </div>
  );
}


