import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A popup menu anchored to the control that opened it.
 *
 * Rendered here rather than through VS Code's QuickPick, which pulls focus to
 * the command palette at the top of the window — a long way from the row you
 * clicked.
 */
export function useDropdown() {
  const [open, setOpen] = useState(false);
  // Opens upward near the bottom edge: the list scrolls, and a menu below the
  // last row would otherwise hang off the end of it.
  const [up, setUp] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => {
    setOpen((was) => {
      if (!was) {
        const rect = anchorRef.current?.getBoundingClientRect();
        setUp(!!rect && rect.bottom > window.innerHeight - 190);
      }
      return !was;
    });
  }, []);

  return { open, up, anchorRef, close, toggle };
}

interface PanelProps {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  up: boolean;
  /** Anchor the menu's right edge to the control's, for controls at the end of a row. */
  alignEnd?: boolean;
  label: string;
  children: React.ReactNode;
}

export function MenuPanel({ anchorRef, onClose, up, alignEnd, label, children }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click or Escape. Capture phase, because rows stop
  // propagation on click to avoid selecting the worktree.
  //
  // The bounds checked are the whole anchor (trigger and menu), not just this
  // menu: with the trigger treated as "outside", clicking it while open closed
  // the menu here and its own onClick immediately reopened it, so it could never
  // be collapsed by the control that opened it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchorRef.current?.querySelector<HTMLElement>('button')?.focus();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, anchorRef]);

  // Keyboard users land on the first entry, and arrows walk the list.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      className={`fm-menu${up ? ' fm-menu-up' : ''}${alignEnd ? ' fm-menu-end' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export function MenuItem({ children, onClick, disabled, dim, danger, title, checked }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Not available right now, but still clickable to find out why. */
  dim?: boolean;
  danger?: boolean;
  title?: string;
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`fm-menu-item${danger ? ' fm-menu-danger' : ''}`}
      data-dim={dim || undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
      {checked && <i className="codicon codicon-check fm-menu-check" aria-hidden="true" />}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="fm-menu-sep" role="separator" />;
}
