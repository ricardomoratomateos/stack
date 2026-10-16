import React, { useId, useState } from 'react';
import { STR } from './strings';

/** A codicon, decorative unless given a label. */
export function Icon({ name, label, spin }: { name: string; label?: string; spin?: boolean }) {
  return <i className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined} />;
}

type Scope = 'repo' | 'me';

/** Says, on the card itself, which of the two places its fields are saved to. */
export function ScopeBadge({ scope, file }: { scope: Scope; file: string }) {
  return (
    <span className="st-scope" data-scope={scope} title={scope === 'repo' ? STR.scopeRepoTitle(file) : STR.scopeMeTitle}>
      <Icon name={scope === 'repo' ? 'repo' : 'account'} />
      <span>{scope === 'repo' ? STR.scopeRepo : STR.scopeMe}</span>
    </span>
  );
}

export function Card({ title, hint, scope, file, children }: {
  title: string; hint?: string; scope: Scope; file: string; children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className="st-card" aria-labelledby={id}>
      <header className="st-card-head">
        <div className="st-card-titles">
          <h3 id={id}>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
        <ScopeBadge scope={scope} file={file} />
      </header>
      <div className="st-card-body">{children}</div>
    </section>
  );
}

/** A label, a control and a one-line hint — or the reason the value is rejected. */
export function Field({ label, hint, error, hideLabel, children }: {
  label: string; hint?: string; error?: string; hideLabel?: boolean; children: (a: { id: string; describedBy?: string; invalid: boolean }) => React.ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className="st-field">
      <label htmlFor={id} className={hideLabel ? 'st-sr' : 'st-label'}>{label}</label>
      {children({ id, describedBy: note ? noteId : undefined, invalid: !!error })}
      {note && <p id={noteId} className={error ? 'st-note st-note-bad' : 'st-note'} role={error ? 'alert' : undefined}>{note}</p>}
    </div>
  );
}

type InputProps = { id: string; describedBy?: string; invalid?: boolean; mono?: boolean; value: string; placeholder?: string; onChange: (v: string) => void };

export function TextInput({ id, describedBy, invalid, mono, value, placeholder, onChange }: InputProps) {
  return (
    <input
      id={id} className={mono ? 'st-input mono' : 'st-input'} value={value} placeholder={placeholder}
      aria-describedby={describedBy} aria-invalid={invalid || undefined} spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Ports are text so that an empty or half-typed box is visible and blocks Save, rather than being swallowed. */
export function PortInput(p: Omit<InputProps, 'mono'>) {
  return (
    <input
      id={p.id} className="st-input mono st-input-short" inputMode="numeric" autoComplete="off" value={p.value}
      aria-describedby={p.describedBy} aria-invalid={p.invalid || undefined}
      onChange={(e) => p.onChange(e.target.value)}
    />
  );
}

export function Select({ id, describedBy, value, options, labels, onChange }: {
  id: string; describedBy?: string; value: string; options: string[]; labels?: Record<string, string>; onChange: (v: string) => void;
}) {
  return (
    <span className="st-select">
      <select id={id} className="st-input" value={value} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
      </select>
      <Icon name="chevron-down" />
    </span>
  );
}

/** A setting that is on or off: the name and what it does on the left, the switch on the right. */
export function SwitchRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="st-row">
      <label htmlFor={id} className="st-row-text">
        <span className="st-label">{label}</span>
        <span className="st-note">{hint}</span>
      </label>
      <input id={id} type="checkbox" role="switch" className="st-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

export function Banner({ tone, icon, title, action, children }: {
  tone: 'info' | 'warn' | 'accent'; icon?: string; title?: string; action?: React.ReactNode; children?: React.ReactNode;
}) {
  const glyph = icon ?? (tone === 'warn' ? 'warning' : 'info');
  return (
    <div className="st-banner" data-tone={tone} role={tone === 'warn' ? 'alert' : 'status'}>
      <Icon name={glyph} />
      <div className="st-banner-text">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Button({ kind, small, icon, children, ...rest }: {
  kind?: 'primary' | 'accent' | 'ghost'; small?: boolean; icon?: string; children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`st-btn${kind ? ` ${kind}` : ''}${small ? ' sm' : ''}`}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

/** A repo-relative path with the buttons that fill it in. */
export function FileInput({ id, describedBy, value, placeholder, onChange, onPick, onCreate }: {
  id: string; describedBy?: string; value: string; placeholder?: string;
  onChange: (v: string) => void; onPick: () => void; onCreate?: () => void;
}) {
  return (
    <div className="st-filerow">
      <input id={id} className="st-input mono" value={value} placeholder={placeholder} aria-describedby={describedBy} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <Button icon="folder-opened" onClick={onPick}>{STR.choose}</Button>
      {onCreate && !value && <Button icon="new-file" onClick={onCreate}>{STR.createForMe}</Button>}
    </div>
  );
}

/** Env var names as removable chips, a box to add one, and the names found in the compose files as one-click suggestions. */
export function ChipList({ id, describedBy, items, suggestions, onChange }: {
  id: string; describedBy?: string; items: string[]; suggestions: string[]; onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const name = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!name || items.includes(name)) return;
    onChange([...items, name]);
    setDraft('');
  };
  return (
    <div className="st-chips">
      <ul className="st-chip-list" aria-label={STR.portsLabel}>
        {items.map((p) => (
          <li key={p} className="st-chip">
            <code>{p}</code>
            <button type="button" aria-label={STR.removePort(p)} onClick={() => onChange(items.filter((x) => x !== p))}><Icon name="close" /></button>
          </li>
        ))}
        {items.length === 0 && <li className="st-chip-empty">{STR.portsEmpty}</li>}
      </ul>
      <div className="st-filerow">
        <input
          id={id} className="st-input mono st-input-short" value={draft} placeholder={STR.portPlaceholder} aria-describedby={describedBy} spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }}
        />
        <Button icon="add" onClick={() => add(draft)} disabled={!draft.trim()}>{STR.addPort}</Button>
      </div>
      {suggestions.length > 0 && (
        <div className="st-suggest">
          <span className="st-note">{STR.portsFound}</span>
          {suggestions.map((s) => (
            <button key={s} type="button" className="st-chip suggest" onClick={() => add(s)}><Icon name="add" /><code>{s}</code></button>
          ))}
        </div>
      )}
    </div>
  );
}
