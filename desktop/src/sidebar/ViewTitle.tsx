import type { ReactNode } from 'react';

/** The native view header VS Code draws above the sidebar webview: title, live counts, actions. */
export function ViewTitle({ counts, onAdd, children }: { counts: string; onAdd?: () => void; children?: ReactNode }) {
  return (
    <div className="view-title">
      <span className="view-title-name">Tasks</span>
      <span className="view-title-desc">{counts}</span>
      <span className="view-title-actions">
        {children}
        {onAdd && <button type="button" className="icon-btn" title="New task" aria-label="New task" onClick={onAdd}><i className="codicon codicon-add" aria-hidden="true" /></button>}
      </span>
    </div>
  );
}
