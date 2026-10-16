import React, { useEffect, useRef, useState } from 'react';
import { isCancelKey } from '../composer';

interface Props {
  /** Name shown on the chip: the one the user typed, or the generated one. */
  name: string;
  /** What the user typed, or null while the name follows the description. */
  manual: string | null;
  /** The name the description alone would give. */
  generated: string;
  error?: string;
  errorId: string;
  disabled?: boolean;
  onChange: (manual: string | null) => void;
}

/**
 * `→ branch-name`. Follows the description until clicked, then becomes an input;
 * what is typed sticks, and clearing it hands the name back to the description.
 */
export function BranchChip({ name, manual, generated, error, errorId, disabled, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const before = useRef<string | null>(null);

  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);

  const start = () => {
    before.current = manual;
    onChange(manual ?? name);
    setEditing(true);
  };
  const finish = () => {
    setEditing(false);
    // Opening the editor and leaving without a change must not freeze the name.
    const untouched = before.current === null && manual === generated;
    if (manual !== null && (!manual.trim() || untouched)) onChange(null);
  };

  if (editing) {
    const value = manual ?? '';
    return (
      <input
        ref={inputRef}
        className="nt-branch-input"
        value={value}
        style={{ width: `${Math.max(14, value.length + 3)}ch` }}
        spellCheck={false}
        autoComplete="off"
        aria-label="Branch name"
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (isCancelKey(e.nativeEvent)) {
            // Esc here undoes the edit; it must not also close the panel.
            e.preventDefault();
            e.stopPropagation();
            onChange(before.current);
            setEditing(false);
          } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            finish();
          }
        }}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        className="nt-chip nt-mono"
        title="Branch name. Click to edit."
        aria-label={`Branch name: ${name || 'not set yet'}. Click to edit.`}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        disabled={disabled}
        onClick={start}
      >
        <i className="codicon codicon-arrow-right" aria-hidden="true" />
        {name
          ? <span className="nt-chip-label">{name}</span>
          : <span className="nt-chip-label nt-placeholder">branch-name</span>}
      </button>
      {manual !== null && !disabled && (
        <button
          type="button"
          className="nt-reset"
          title="Use the name generated from the description"
          aria-label="Use the generated branch name"
          onClick={() => onChange(null)}
        >
          <i className="codicon codicon-close" aria-hidden="true" />
        </button>
      )}
    </>
  );
}
