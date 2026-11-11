import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DEFS, isModified, valueOf, type SettingDef, type SettingValue } from './schema';

/** Full-window Settings editor over ~/.config/stack/settings.json, in the look of VS Code's. */
export function SettingsHost({ onClose, onSaved }: { onClose: () => void; onSaved: (file: Record<string, unknown>) => void }) {
  const [file, setFile] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    invoke<Record<string, unknown>>('read_settings').then(setFile).catch((e) => { setError(String(e)); setFile({}); });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (key: string, value: SettingValue | null) => {
    try {
      const next = await invoke<Record<string, unknown>>('write_settings', { changes: { [key]: value } });
      setFile(next);
      setError('');
      onSaved(next);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="newtask-host settings-host">
      <div className="newtask-bar" data-tauri-drag-region>
        <button type="button" className="newtask-back" onClick={onClose} title="Back (Esc)"><span aria-hidden>←</span> Back</button>
      </div>
      <div className="settings-body">
        <h1>Settings</h1>
        <p className="settings-sub">Saved to <code>~/.config/stack/settings.json</code>; stackd picks changes up right away.</p>
        {error && <div className="settings-error" role="alert">{error}</div>}
        {file && DEFS.map((d) => <SettingRow key={d.key} def={d} stored={valueOf(d, file)} onSave={save} />)}
        <div className="setting-item">
          <div className="setting-title">Other settings</div>
          <div className="setting-desc">Docker and the rest are objects or advanced options: edit them in the file.</div>
          <button type="button" className="secondary" onClick={() => invoke('open_settings_file').catch((e) => setError(String(e)))}>Open settings.json</button>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ def, stored, onSave }: { def: SettingDef; stored: SettingValue | undefined; onSave: (key: string, v: SettingValue | null) => void }) {
  const current = stored ?? def.default;
  const [draft, setDraft] = useState(String(current));
  useEffect(() => setDraft(String(current)), [current]);
  const modified = isModified(def, stored);
  // Saving the default is the same as resetting: the key leaves the file.
  const commit = (v: SettingValue) => onSave(def.key, v === def.default ? null : v);
  const id = `setting-${def.key}`;

  return (
    <div className="setting-item" data-modified={modified || undefined}>
      <label className="setting-title" htmlFor={id}>
        {def.title}
        {modified && <span className="setting-modified">Modified</span>}
        {modified && <button type="button" className="setting-reset" title="Reset to default" onClick={() => onSave(def.key, null)}>Reset</button>}
      </label>
      {def.type === 'boolean' ? (
        <label className="setting-check">
          <input id={id} type="checkbox" checked={current as boolean} onChange={(e) => commit(e.target.checked)} />
          <span>{def.description}</span>
        </label>
      ) : (
        <>
          <div className="setting-desc">{def.description}</div>
          {def.enum ? (
            <select id={id} value={String(current)} onChange={(e) => commit(e.target.value)}>
              {def.enum.map((v, i) => <option key={v} value={v} title={def.enumDescriptions?.[i]}>{v}</option>)}
            </select>
          ) : def.multiline ? (
            <textarea id={id} rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== current && commit(draft)} />
          ) : (
            <input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== current && commit(draft)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          )}
          {def.enum && def.enumDescriptions && <div className="setting-desc">{def.enumDescriptions[def.enum.indexOf(String(current))]}</div>}
        </>
      )}
    </div>
  );
}
