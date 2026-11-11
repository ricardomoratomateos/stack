import type { ReactNode } from 'react';

/** A centred modal sheet over a dimmed backdrop: title and close "×" on top, the body scrolls. Esc is the owner's business. */
export function Sheet({ title, width = 640, className, onClose, children }: { title: string; width?: number; className?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width }}>
        <header className="sheet-head">
          <span className="sheet-title">{title}</span>
          <button type="button" className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}><i className="codicon codicon-close" aria-hidden="true" /></button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
