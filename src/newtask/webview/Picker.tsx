import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { filterBranches, isCancelKey } from '../composer';

export interface PickerItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
  /** Quiet text at the end of the row, e.g. "not installed". */
  hint?: string;
  /** Unavailable right now but still choosable, to find out why. */
  dim?: boolean;
}

interface Props {
  items: PickerItem[];
  value: string;
  onSelect: (value: string) => void;
  /** Contents of the chip that opens the picker. */
  children: React.ReactNode;
  /** Accessible name of the chip, e.g. "Base branch". */
  label: string;
  title: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  mono?: boolean;
  dim?: boolean;
  disabled?: boolean;
}

/**
 * A chip that opens a small listbox: optional search field, arrow keys, Enter
 * to choose, Esc to close. Built here rather than on a native <select> because
 * a select cannot hold a provider mark, a "not installed" hint or a filter.
 */
export function Picker({
  items, value, onSelect, children, label, title, searchable, searchPlaceholder, mono, dim, disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const shown = useMemo(() => {
    if (!searchable || !query.trim()) return items;
    const byLabel = new Map(items.map((i) => [i.label, i]));
    return filterBranches(items.map((i) => i.label), query).map((l) => byLabel.get(l)!);
  }, [items, query, searchable]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) return close(false);
    const rect = rootRef.current?.getBoundingClientRect();
    // Opens upward near the bottom edge rather than hanging off the window.
    setUp(!!rect && rect.bottom > window.innerHeight - 300);
    setActive(Math.max(0, items.findIndex((i) => i.value === value)));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    (searchable ? searchRef.current : popRef.current)?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open, searchable, close]);

  useEffect(() => {
    if (open) popRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, shown]);

  const choose = (item: PickerItem) => {
    onSelect(item.value);
    close(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isCancelKey(e.nativeEvent)) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const last = shown.length - 1;
    const move = (to: number) => { e.preventDefault(); setActive(to); };
    if (e.key === 'ArrowDown') move(active >= last ? 0 : active + 1);
    else if (e.key === 'ArrowUp') move(active <= 0 ? last : active - 1);
    else if (e.key === 'Home' && !searchable) move(0);
    else if (e.key === 'End' && !searchable) move(last);
    else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing && shown[active]) {
      e.preventDefault();
      choose(shown[active]);
    }
  };

  return (
    <div
      ref={rootRef}
      className="nt-anchor"
      onBlur={(e) => { if (open && !rootRef.current?.contains(e.relatedTarget as Node | null)) close(false); }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`nt-chip${mono ? ' nt-mono' : ''}`}
        data-dim={dim || undefined}
        title={title}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); toggle(); } }}
      >
        {children}
        <i className="codicon codicon-chevron-down nt-chev" aria-hidden="true" />
      </button>
      {open && (
        <div ref={popRef} className={`nt-pop${up ? ' nt-pop-up' : ''}`} tabIndex={-1} onKeyDown={onKeyDown}>
          {searchable && (
            <input
              ref={searchRef}
              className="nt-search"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            />
          )}
          <div
            id={listId}
            className="nt-list"
            role="listbox"
            aria-label={label}
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          >
            {shown.length === 0 && <div className="nt-empty">No match</div>}
            {shown.map((item, i) => (
              <div
                key={item.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={item.value === value}
                className={`nt-opt${mono ? ' nt-mono' : ''}`}
                data-active={i === active || undefined}
                data-dim={item.dim || undefined}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(item)}
              >
                {item.icon}
                <span className="nt-opt-label">{item.label}</span>
                {item.hint && <span className="nt-opt-hint">{item.hint}</span>}
                {item.value === value && <i className="codicon codicon-check" aria-hidden="true" />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
