import { Fragment, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sheet } from '../ui/Sheet';
import { stackd } from '../stackd/api';
import { useStackd } from '../stackd/useStackd';
import { APP_VERSION } from '../stackd/version';
import { formatChecks } from '@core/daemon/doctorReport';
import { diagnostics, type Check } from './diagnostics';
import { PROJECT_DEFS, USER_DEFS, formatValue, isModified, parseList, repoValueOf, sameValue, valueOf, type SettingDef, type SettingValue } from './schema';

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
        {inRepo && repoFile && grouped(PROJECT_DEFS, (d) => (
          <SettingRow key={`repo-${d.key}`} def={d} stored={repoValueOf(d, repoFile)} onSave={saveRepo}
            note={file && valueOf(d, file) !== undefined ? 'Overridden by User setting' : undefined} />
        ))}
        {!inRepo && file && grouped(USER_DEFS, (d) => <SettingRow key={d.key} def={d} stored={valueOf(d, file)} onSave={save} />)}
        {!inRepo && file && (
          <>
            <h2 className="settings-group">Project settings</h2>
            <p className="settings-sub">A value set here overrides this key in every repository, including its <code>.stack/config.json</code>. Leave it unset to let each repo decide.</p>
            {grouped(PROJECT_DEFS, (d) => <SettingRow key={d.key} def={d} stored={valueOf(d, file)} onSave={save} />, 'h3')}
          </>
        )}
        {!inRepo && <ManagerRow />}
        {!inRepo && <div className="setting-item">
          <div className="setting-title">Other settings</div>
          <div className="setting-desc">The rest are objects or advanced options (phpactorOptions…): edit them in the file.</div>
          <button type="button" className="secondary" onClick={() => invoke('open_settings_file').catch((e) => setError(String(e)))}>Open settings.json</button>
        </div>}
        {!inRepo && <Diagnostics />}
      </div>
    </Sheet>
  );
}

/** The rows, with a heading where a group ("Code") starts. */
function grouped(defs: SettingDef[], row: (d: SettingDef) => React.ReactNode, Heading: 'h2' | 'h3' = 'h2') {
  return defs.map((d, i) => (
    <Fragment key={d.key}>
      {d.group && d.group !== defs[i - 1]?.group && <Heading className="settings-group">{d.group}</Heading>}
      {row(d)}
    </Fragment>
  ));
}

type ManagerState = 'registered' | 'elsewhere' | 'missing';

const MANAGER_TEXT: Record<ManagerState, string> = {
  registered: 'Registered: every Claude Code session has the stack_* tools and the /stack commands.',
  elsewhere: 'Registered, but pointing at another copy (likely the old VS Code extension).',
  missing: 'Not registered: Claude Code sessions outside Stack have no stack_* tools.',
};

/** Registers stackd's MCP bridge with Claude Code (user scope) and installs the manager skill/commands. */
function ManagerRow() {
  const [status, setStatus] = useState<{ state: ManagerState; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    stackd.command<{ state: ManagerState; detail?: string }>('managerStatus').then(setStatus).catch((e) => setNote(String(e)));
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const r = await stackd.command<{ state: ManagerState; detail?: string; message: string }>('enableManager');
      setStatus(r);
      setNote(r.message);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setting-item">
      <div className="setting-title">Stack tools in Claude Code</div>
      <div className="setting-desc">
        {status ? MANAGER_TEXT[status.state] : 'Checking…'}
        {status?.detail && <> <code>{status.detail}</code></>}
      </div>
      {note && <div className="setting-desc" role="status">{note}</div>}
      <button type="button" className={status?.state === 'registered' ? 'secondary' : undefined} disabled={busy || !status} onClick={() => void enable()}>
        {busy ? 'Registering…' : status?.state === 'registered' ? 'Register again' : status?.state === 'elsewhere' ? 'Point it at this Stack' : 'Register'}
      </button>
    </div>
  );
}

/** stackd's `doctor` checks, plus the app's version check; Copy gives the text for an issue. */
function Diagnostics() {
  const { running, snapshot } = useStackd();
  const [doctor, setDoctor] = useState<Check[] | { error: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const run = () => {
    setDoctor(null);
    stackd.command<Check[]>('doctor').then(setDoctor).catch((e) => setDoctor({ error: String(e) }));
  };
  useEffect(() => { if (running) run(); }, [running]);

  const checks = running === null || (running && !doctor) ? null : diagnostics(APP_VERSION, running, snapshot?.version, doctor ?? []);
  const copy = () => {
    if (!checks) return;
    void navigator.clipboard.writeText(`Stack ${APP_VERSION} diagnostics\n${formatChecks(checks)}`).then(() => setCopied(true), () => {});
  };

  return (
    <>
      <h2 className="settings-group">Diagnostics</h2>
      <p className="settings-sub">What Stack needs on this Mac, as stackd sees it.</p>
      <div className="setting-item">
        {checks ? (
          <ul className="diagnostics">
            {checks.map((c) => (
              <li key={c.id} data-ok={c.ok || undefined}>
                <span className="diag-mark" aria-label={c.ok ? 'ok' : 'failed'}>{c.ok ? '✓' : '✗'}</span>
                <span className="diag-id">{c.id}</span>
                <span className="diag-detail">{c.detail}{!c.ok && c.fix && <div className="diag-fix">{c.fix}</div>}</span>
              </li>
            ))}
          </ul>
        ) : <div className="setting-desc">Checking…</div>}
        <button type="button" className="secondary" disabled={!checks} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        {' '}
        <button type="button" className="secondary" disabled={!running || !checks} onClick={() => { setCopied(false); run(); }}>Check again</button>
      </div>
    </>
  );
}

function SettingRow({ def, stored, onSave, note }: { def: SettingDef; stored: SettingValue | undefined; onSave: (key: string, v: SettingValue | null) => void; note?: string }) {
  const current = stored ?? def.default;
  const shown = formatValue(current);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const modified = isModified(def, stored);
  // Saving the default is the same as resetting: the key leaves the file.
  const commit = (v: SettingValue) => onSave(def.key, sameValue(v, def.default) ? null : v);
  /** The text box's draft as the setting's type; a number that is not one goes back to what it was. */
  const commitDraft = () => {
    if (draft === shown) return;
    if (def.type === 'array') return commit(parseList(draft));
    if (def.type === 'number') {
      const n = Number(draft);
      return Number.isFinite(n) && n > 0 && draft.trim() !== '' ? commit(n) : setDraft(shown);
    }
    commit(draft);
  };
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
            <textarea id={id} rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitDraft} />
          ) : (
            <input id={id} value={draft} inputMode={def.type === 'number' ? 'numeric' : undefined}
              placeholder={def.type === 'array' ? 'comma-separated' : undefined}
              onChange={(e) => setDraft(e.target.value)} onBlur={commitDraft} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          )}
          {def.enum && def.enumDescriptions && <div className="setting-desc">{def.enumDescriptions[def.enum.indexOf(String(current))]}</div>}
        </>
      )}
    </div>
  );
}
