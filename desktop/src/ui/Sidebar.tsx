import { useState } from 'react';
import { GROUP_LABEL, GROUP_SHORT, formatAge, type Described, type WorktreeGroup } from '@core/webview/derive';
import { sessionRows, taskFromText, type View } from '../model';

const CHIPS: WorktreeGroup[] = ['needs', 'review', 'working', 'idle'];

export interface SidebarProps {
  view: View;
  selectedId: string | undefined;
  selectedIndex: number | undefined;
  now: number;
  /** Current command per worktree and window index, from the connected panes. */
  commands: (worktreeId: string) => Record<number, string>;
  onSelect(worktreeId: string, index?: number): void;
  onRepo(repoRoot: string): void;
  onCreate(task: NonNullable<ReturnType<typeof taskFromText>>): Promise<void>;
}

export function Sidebar({ view, selectedId, selectedIndex, now, commands, onSelect, onRepo, onCreate }: SidebarProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorktreeGroup | 'all'>('all');
  const visible = view.items.map((d, i) => ({ d, n: i + 1 })).filter(({ d }) => filter === 'all' || d.group === filter);

  const submit = async () => {
    const task = taskFromText(text, view.repoRoot);
    if (!task || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(task);
      setText('');
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="sidebar">
      <header className="brand">
        <span className="mark" aria-hidden="true" />
        <span className="wordmark">stack</span>
        <span className="slash">/</span>
        {view.repos.length > 1 ? (
          <select className="repo-select" value={view.repoRoot} onChange={(e) => onRepo(e.target.value)} aria-label="Repository">
            {view.repos.map((r) => <option key={r.repoRoot} value={r.repoRoot}>{r.name}</option>)}
          </select>
        ) : (
          <span className="repo" title={view.repoRoot}>{view.repoName}</span>
        )}
      </header>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should an agent build?"
          aria-label="New task"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !taskFromText(text, view.repoRoot)}>{busy ? '…' : 'New'}</button>
      </form>
      {error && <div className="composer-error" role="alert">{error}</div>}

      <div className="chips" role="group" aria-label="Filter by state">
        {CHIPS.map((g) => (
          <button key={g} type="button" className="chip" data-group={g} aria-pressed={filter === g} onClick={() => setFilter(filter === g ? 'all' : g)}>
            <span className="dot" aria-hidden="true" />
            <span className="n">{view.counts[g]}</span>
            <span>{GROUP_SHORT[g]}</span>
          </button>
        ))}
      </div>

      <div className="wt-list">
        {view.items.length === 0 && <div className="none">No worktrees yet. Describe a task above.</div>}
        {visible.map(({ d, n }) => (
          <WorktreeBlock
            key={d.wt.id}
            d={d}
            n={n}
            now={now}
            selected={d.wt.id === selectedId}
            selectedIndex={selectedIndex}
            commands={commands(d.wt.id)}
            onSelect={onSelect}
          />
        ))}
      </div>
      <footer className="hints">⌘1…9 worktree · ⌘⇧[ ] prev/next · ⌘⇧J needs you · ⌘0 manager · ⌘⇧M hide</footer>
    </aside>
  );
}

function WorktreeBlock({ d, n, now, selected, selectedIndex, commands, onSelect }: {
  d: Described;
  n: number;
  now: number;
  selected: boolean;
  selectedIndex: number | undefined;
  commands: Record<number, string>;
  onSelect(worktreeId: string, index?: number): void;
}) {
  const rows = sessionRows(d.wt, commands);
  return (
    <section className="wt" data-group={d.group} data-selected={selected || undefined}>
      <button type="button" className="wt-head" onClick={() => onSelect(d.wt.id)} aria-current={selected || undefined}>
        <span className="dot" role="img" aria-label={GROUP_LABEL[d.group]} />
        <span className="wt-body">
          <span className="wt-name">{d.name}</span>
          <span className="wt-line">{d.line}</span>
        </span>
        <span className="wt-meta">
          <span className="when">{formatAge(d.wt.since, now)}</span>
          {n <= 9 && <kbd>⌘{n}</kbd>}
        </span>
      </button>
      {rows.length > 0 && (
        <ul className="sessions">
          {rows.map((r) => (
            <li key={r.index}>
              <button type="button" className="session" data-state={r.state} data-kind={r.kind} data-selected={(selected && selectedIndex === r.index) || undefined} onClick={() => onSelect(d.wt.id, r.index)}>
                <span className="dot" aria-hidden="true" />
                <span className="s-name">{r.name}</span>
                <span className="s-detail">{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
