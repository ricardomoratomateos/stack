import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sheet } from '../ui/Sheet';
import { PROJECT_DEFS, USER_DEFS, isModified, repoValueOf, valueOf, type SettingDef, type SettingValue } from './schema';

/** Settings editor, a centred sheet, over ~/.config/stack/settings.json, in the look of VS Code's. */
export function SettingsHost({ repo, onClose }: { repo?: { name: string; root: string }; onClose: () => void }) {
  const [file, setFile] = useState<Record<string, unknown> | null>(null);
  const [repoFile, setRepoFile] = useState<Record<string, unknown> | null>(null);
  const [scope, setScope] = useState<'user' | 'repo'>(repo ? 'repo' : 'user');
  const [error, setError] = useState('');

  useEffect(() => {
    invoke<Record<string, unknown>>('read_settings').then(setFile).catch((e) => { setError(String(e)); setFile({}); });
  }, []);
  useEffect(() => {
    if (!repo) return;
    setRepoFile(null);
    invoke<Record<string, unknown>>('read_repo_config', { repoRoot: repo.root }).then(setRepoFile).catch((e) => { setError(String(e)); setRepoFile({}); });
  }, [repo]);
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
    } catch (e) {
      setError(String(e));
    }
  };

  const saveRepo = async (key: string, value: SettingValue | null) => {
    if (!repo) return;
    try {
      setRepoFile(await invoke<Record<string, unknown>>('write_repo_config', { repoRoot: repo.root, changes: { [key]: value } }));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  const inRepo = scope === 'repo' && !!repo;

  return (
    <Sheet title="Settings" width={720} className="settings-host" onClose={onClose}>
      <div className="settings-body">
        <div className="settings-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!inRepo} onClick={() => setScope('user')}>User</button>
          {repo && <button type="button" role="tab" aria-selected={inRepo} onClick={() => setScope('repo')}>{repo.name}</button>}
        </div>
        {inRepo && repo ? (
          <p className="settings-sub">Saved to <code>{repo.root}/.stack/config.json</code>, shared with everyone who clones the repository.</p>
        ) : (
          <p className="settings-sub">Saved to <code>~/.config/stack/settings.json</code>; stackd picks changes up right away.</p>
        )}
        {error && <div className="settings-error" role="alert">{error}</div>}
        {inRepo && repoFile && PROJECT_DEFS.map((d) => (
          <SettingRow key={`repo-${d.key}`} def={d} stored={repoValueOf(d, repoFile)} onSave={saveRepo}
            note={file && valueOf(d, file) !== undefined ? 'Overridden by User setting' : undefined} />
        ))}
        {!inRepo && file && USER_DEFS.map((d) => <SettingRow key={d.key} def={d} stored={valueOf(d, file)} onSave={save} />)}
        {!inRepo && file && (
          <>
            <h2 className="settings-group">Project settings</h2>
            <p className="settings-sub">A value set here overrides this key in every repository, including its <code>.stack/config.json</code>. Leave it unset to let each repo decide.</p>
            {PROJECT_DEFS.map((d) => <SettingRow key={d.key} def={d} stored={valueOf(d, file)} onSave={save} />)}
          </>
        )}
        {!inRepo && <div className="setting-item">
          <div className="setting-title">Other settings</div>
          <div className="setting-desc">The rest are lists, objects or advanced options: edit them in the file.</div>
          <button type="button" className="secondary" onClick={() => invoke('open_settings_file').catch((e) => setError(String(e)))}>Open settings.json</button>
        </div>}
      </div>
    </Sheet>
  );
}

function SettingRow({ def, stored, onSave, note }: { def: SettingDef; stored: SettingValue | undefined; onSave: (key: string, v: SettingValue | null) => void; note?: string }) {
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
        {note && <span className="setting-override">{note}</span>}
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
