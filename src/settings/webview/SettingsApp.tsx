import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { T } from '../../webview/tokens';
import { PROVIDER_IDS, PROVIDER_INSTALL, type ProviderId } from '../../ports/IAgentProvider';
import { DEBUG_PRESETS, STACK_ORDER, presetFor } from '../presets';
import type { FileField, ProjectValues, SettingsExtMessage, SettingsSnapshot, Stack, UserValues } from '../types';
import { send } from './vscode';

/** Every user-facing string, in one place, so a translation is a mechanical pass. */
const STR = {
  title: 'Unmess settings',
  subtitle: 'Two kinds of settings: the project’s (shared with everyone who clones it) and yours (this machine only).',
  noRepo: 'Open a git repository to configure a project. Your own settings are below.',
  project: 'Project',
  projectHint: 'Saved to .unmess/config.json. Commit it and your team gets the same setup.',
  openFile: 'Open file',
  fileProblems: 'The file on disk has problems — fix them or save from here to overwrite it:',
  overrides: (keys: string) => `Your settings.json sets ${keys} for this repo. Those win over the file, so what you save here won’t take effect for you until they go.`,
  clearOverrides: 'Remove my overrides',
  worktrees: 'Worktrees',
  worktreesDir: 'Folder',
  worktreesDirHint: 'Where worktrees are created, relative to the repo root.',
  baseBranch: 'Start new work from',
  baseBranchHint: 'Preselected in the New agent form.',
  scripts: 'Setup & teardown',
  scriptsHint: 'Run something when a worktree is created (install deps, copy .env, boot services) and before it is deleted.',
  setup: 'After creating a worktree',
  teardown: 'Before deleting a worktree',
  choose: 'Choose…',
  createForMe: 'Create one for me',
  scriptEnv: 'Your script gets UNMESS_REPO_ROOT, UNMESS_WORKTREE_PATH, UNMESS_BRANCH, UNMESS_COMPOSE_PROJECT and one variable per port below.',
  docker: 'Docker',
  dockerHint: 'A dedicated compose stack per worktree, on ports that never collide.',
  dockerToggle: 'Docker stack per worktree',
  dockerFound: (files: string) => `Found ${files} in this repo.`,
  dockerUse: 'Set it up',
  composeFile: 'Compose file',
  overrideFile: 'Worktree override',
  overrideHint: 'Merged on top; this is where ${HTTP_PORT}-style ports go.',
  ports: 'Ports to generate',
  portsHint: 'One env var per port. At least one is what enables the Docker button on each card. DEBUG_PORT reuses the debug port.',
  portsFound: 'Found in your compose files:',
  addPort: 'Add',
  portPlaceholder: 'HTTP_PORT',
  basePort: 'First port',
  portStride: 'Ports per worktree',
  debug: 'Debug',
  debugHint: 'Each worktree gets its own launch.json on its own port, so you can step-debug several at once.',
  debugBasePort: 'First debug port',
  preset: 'Debugger',
  custom: 'Custom',
  template: 'launch.json template',
  templateHint: '{{PORT}} becomes the worktree’s port, {{WORKTREE_PATH}} its folder. Any debugger VS Code supports.',
  templateBad: 'Not valid JSON.',
  templateShape: 'Needs a string "type" and "request".',
  stackHint: (stack: string) => `This looks like a ${stack} project.`,
  usePreset: 'Use that preset',
  saveProject: 'Save to .unmess/config.json',
  you: 'You',
  youHint: 'Saved to your VS Code settings. Never travels with the repo.',
  agents: 'Agents',
  agentsHint: 'The primary agent is what the big button on each card launches; the rest sit behind the chevron.',
  primary: 'Primary',
  installed: 'installed',
  notFound: 'not on PATH',
  command: 'Command',
  behaviour: 'Behaviour',
  notify: 'Native notification when an agent needs you and VS Code is in the background',
  focusMode: 'Focus mode: switching worktree closes the other worktrees’ tabs and terminals',
  scopeSearch: 'Scope search and Quick Open to the active worktree',
  saveUser: 'Save my settings',
  saved: 'Saved.',
  unsaved: 'Unsaved changes',
  clean: 'Everything saved',
};

type Notice = { scope: 'project' | 'user'; problems: string[] } | null;

export function SettingsApp() {
  const [snap, setSnap] = useState<SettingsSnapshot | null>(null);
  const [project, setProject] = useState<ProjectValues | null>(null);
  const [user, setUser] = useState<UserValues | null>(null);
  const [dockerOn, setDockerOn] = useState(false);
  const [templateText, setTemplateText] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState<'project' | 'user' | null>(null);

  const adopt = useCallback((s: SettingsSnapshot) => {
    setSnap(s);
    setProject(s.project);
    setUser(s.user);
    setDockerOn(s.project.docker.ports.length > 0);
    setTemplateText(JSON.stringify(s.project.debugTemplate, null, 2));
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as SettingsExtMessage;
      if (msg.type === 'snapshot') { adopt(msg.snapshot); setSaving(null); }
      else if (msg.type === 'picked') {
        setProject((p) => {
          if (!p) return p;
          if (msg.field === 'composeFile' || msg.field === 'overrideFile') {
            return { ...p, docker: { ...p.docker, [msg.field]: msg.path } };
          }
          return { ...p, [msg.field]: msg.path };
        });
      } else if (msg.type === 'saved') {
        setNotice({ scope: msg.scope, problems: msg.problems });
        setSaving(null);
      }
    };
    window.addEventListener('message', handler);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [adopt]);

  useEffect(() => {
    if (notice && notice.problems.length === 0) {
      const t = setTimeout(() => setNotice(null), 2500);
      return () => clearTimeout(t);
    }
  }, [notice]);

  // The template is edited as text; it only becomes part of the project
  // values when it parses, so a half-typed brace never gets saved.
  const template = useMemo(() => {
    try {
      const parsed = JSON.parse(templateText) as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: STR.templateBad };
      if (typeof parsed['type'] !== 'string' || typeof parsed['request'] !== 'string') return { error: STR.templateShape };
      return { value: parsed as ProjectValues['debugTemplate'] };
    } catch {
      return { error: STR.templateBad };
    }
  }, [templateText]);

  const effectiveProject = useMemo<ProjectValues | null>(() => {
    if (!project) return null;
    return {
      ...project,
      docker: { ...project.docker, ports: dockerOn ? project.docker.ports : [] },
      debugTemplate: template.value ?? project.debugTemplate,
    };
  }, [project, dockerOn, template]);

  const projectDirty = !!snap && !!effectiveProject && JSON.stringify(effectiveProject) !== JSON.stringify(snap.project);
  const userDirty = !!snap && !!user && JSON.stringify(user) !== JSON.stringify(snap.user);

  if (!snap || !project || !user || !effectiveProject) {
    return <div style={{ padding: 32, color: T.textMuted }}>…</div>;
  }

  const hasRepo = !!snap.repoRoot;
  const patch = (p: Partial<ProjectValues>) => setProject((cur) => (cur ? { ...cur, ...p } : cur));
  const patchDocker = (d: Partial<ProjectValues['docker']>) =>
    setProject((cur) => (cur ? { ...cur, docker: { ...cur.docker, ...d } } : cur));
  const patchUser = (u: Partial<UserValues>) => setUser((cur) => (cur ? { ...cur, ...u } : cur));

  const pick = (field: FileField) => send({ type: 'pickFile', field });

  const saveProject = () => {
    if (!projectDirty || template.error) return;
    setSaving('project');
    send({ type: 'saveProject', values: effectiveProject });
  };
  const saveUser = () => {
    if (!userDirty) return;
    setSaving('user');
    send({ type: 'saveUser', values: user });
  };

  const currentPreset = template.value ? presetFor(template.value) : undefined;
  const suggestedPreset = snap.detected.stack && snap.detected.stack !== currentPreset ? snap.detected.stack : undefined;
  const portSuggestions = snap.detected.portVars.filter((v) => !project.docker.ports.includes(v));
  const baseOptions = [...new Set([project.defaultBaseBranch, ...snap.branches])].filter(Boolean);

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 880, padding: '32px 32px 48px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: T.textStrong, margin: 0 }}>{STR.title}</h1>
        <p style={{ color: T.textDim, marginTop: 6, marginBottom: 28, fontSize: 13 }}>{STR.subtitle}</p>

        {!hasRepo && <Banner tone="info">{STR.noRepo}</Banner>}

        {hasRepo && (
          <Card
            title={STR.project}
            hint={STR.projectHint}
            action={snap.projectFile.present ? (
              <button className="u-btn small" onClick={() => send({ type: 'openProjectFile' })}>{STR.openFile}</button>
            ) : null}
          >
            {snap.projectFile.problems.length > 0 && (
              <Banner tone="warn">
                <div>{STR.fileProblems}</div>
                <ul style={{ margin: '6px 0 0 18px' }}>{snap.projectFile.problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </Banner>
            )}
            {snap.personalOverrides.length > 0 && (
              <Banner tone="warn">
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span style={{ flex: 1 }}>{STR.overrides(snap.personalOverrides.join(', '))}</span>
                  <button className="u-btn small" onClick={() => send({ type: 'clearPersonalOverrides' })}>{STR.clearOverrides}</button>
                </div>
              </Banner>
            )}

            <Section title={STR.worktrees}>
              <Grid>
                <Field label={STR.worktreesDir} hint={STR.worktreesDirHint}>
                  <input className="u-input mono" value={project.worktreesDirectory} onChange={(e) => patch({ worktreesDirectory: e.target.value })} />
                </Field>
                <Field label={STR.baseBranch} hint={STR.baseBranchHint}>
                  <Select value={project.defaultBaseBranch} options={baseOptions} onChange={(v) => patch({ defaultBaseBranch: v })} />
                </Field>
              </Grid>
            </Section>

            <Section title={STR.scripts} hint={STR.scriptsHint}>
              <FileRow label={STR.setup} value={project.setupScript} onChange={(v) => patch({ setupScript: v })}
                onPick={() => pick('setupScript')} onCreate={() => send({ type: 'createScript', kind: 'setup' })} />
              <FileRow label={STR.teardown} value={project.teardownScript} onChange={(v) => patch({ teardownScript: v })}
                onPick={() => pick('teardownScript')} onCreate={() => send({ type: 'createScript', kind: 'teardown' })} />
              <p style={hintStyle}>{STR.scriptEnv}</p>
            </Section>

            <Section title={STR.docker} hint={STR.dockerHint}>
              {!dockerOn && snap.detected.composeFiles.length > 0 && (
                <Banner tone="info">
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ flex: 1 }}>{STR.dockerFound(snap.detected.composeFiles.map((f) => `\`${f}\``).join(', '))}</span>
                    <button className="u-btn small primary" onClick={() => {
                      const [base, override] = snap.detected.composeFiles;
                      patchDocker({
                        composeFile: base ?? project.docker.composeFile,
                        overrideFile: override ?? project.docker.overrideFile,
                        ports: snap.detected.portVars.length > 0 ? snap.detected.portVars : project.docker.ports,
                      });
                      setDockerOn(true);
                    }}>{STR.dockerUse}</button>
                  </div>
                </Banner>
              )}
              <Toggle checked={dockerOn} onChange={setDockerOn} label={STR.dockerToggle} />
              {dockerOn && (
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <Grid>
                    <FileRow label={STR.composeFile} value={project.docker.composeFile} onChange={(v) => patchDocker({ composeFile: v })} onPick={() => pick('composeFile')} />
                    <FileRow label={STR.overrideFile} hint={STR.overrideHint} value={project.docker.overrideFile} onChange={(v) => patchDocker({ overrideFile: v })} onPick={() => pick('overrideFile')} />
                  </Grid>
                  <Field label={STR.ports} hint={STR.portsHint}>
                    <PortsEditor
                      ports={project.docker.ports}
                      suggestions={portSuggestions}
                      onChange={(ports) => patchDocker({ ports })}
                    />
                  </Field>
                  <Grid>
                    <Field label={STR.basePort}>
                      <NumberInput value={project.docker.basePort} onChange={(v) => patchDocker({ basePort: v })} />
                    </Field>
                    <Field label={STR.portStride}>
                      <NumberInput value={project.docker.portStride} onChange={(v) => patchDocker({ portStride: v })} />
                    </Field>
                  </Grid>
                </div>
              )}
            </Section>

            <Section title={STR.debug} hint={STR.debugHint}>
              {suggestedPreset && (
                <Banner tone="info">
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ flex: 1 }}>{STR.stackHint(DEBUG_PRESETS[suggestedPreset].label.split(' — ')[0])}</span>
                    <button className="u-btn small primary" onClick={() => setTemplateText(JSON.stringify(DEBUG_PRESETS[suggestedPreset].template, null, 2))}>{STR.usePreset}</button>
                  </div>
                </Banner>
              )}
              <Grid>
                <Field label={STR.debugBasePort}>
                  <NumberInput value={project.debugBasePort} onChange={(v) => patch({ debugBasePort: v })} />
                </Field>
                <Field label={STR.preset}>
                  <Select
                    value={currentPreset ?? 'custom'}
                    options={[...STACK_ORDER, 'custom']}
                    labels={{ ...Object.fromEntries(STACK_ORDER.map((s) => [s, DEBUG_PRESETS[s].label])), custom: STR.custom }}
                    onChange={(v) => { if (v !== 'custom') setTemplateText(JSON.stringify(DEBUG_PRESETS[v as Stack].template, null, 2)); }}
                  />
                </Field>
              </Grid>
              <Field label={STR.template} hint={STR.templateHint}>
                <textarea
                  className="u-input mono"
                  value={templateText}
                  onChange={(e) => setTemplateText(e.target.value)}
                  rows={Math.min(14, Math.max(5, templateText.split('\n').length + 1))}
                  spellCheck={false}
                  style={{ resize: 'vertical', lineHeight: 1.5, borderColor: template.error ? T.red : undefined }}
                />
                {template.error && <div style={{ color: T.red, fontSize: 12, marginTop: 4 }}>{template.error}</div>}
              </Field>
            </Section>

            <SaveBar
              dirty={projectDirty}
              blocked={!!template.error}
              busy={saving === 'project'}
              label={STR.saveProject}
              notice={notice?.scope === 'project' ? notice : null}
              onSave={saveProject}
            />
          </Card>
        )}

        <Card title={STR.you} hint={STR.youHint}>
          <Section title={STR.agents} hint={STR.agentsHint}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {PROVIDER_IDS.map((id) => (
                <ProviderRow
                  key={id}
                  id={id}
                  primary={user.defaultProvider === id}
                  installed={snap.installedProviders.includes(id)}
                  command={user[commandKey(id)]}
                  onPrimary={() => patchUser({ defaultProvider: id })}
                  onCommand={(v) => patchUser({ [commandKey(id)]: v } as Partial<UserValues>)}
                />
              ))}
            </div>
          </Section>

          <Section title={STR.behaviour}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Toggle checked={user.notifyOnAttention} onChange={(v) => patchUser({ notifyOnAttention: v })} label={STR.notify} />
              <Toggle checked={user.focusMode} onChange={(v) => patchUser({ focusMode: v })} label={STR.focusMode} />
              <Toggle checked={user.scopeSearchToActiveWorktree} onChange={(v) => patchUser({ scopeSearchToActiveWorktree: v })} label={STR.scopeSearch} />
            </div>
          </Section>

          <SaveBar
            dirty={userDirty}
            busy={saving === 'user'}
            label={STR.saveUser}
            notice={notice?.scope === 'user' ? notice : null}
            onSave={saveUser}
          />
        </Card>
      </div>
    </div>
  );
}

type CommandKey = 'claudeCommand' | 'codexCommand' | 'grokCommand' | 'opencodeCommand';

function commandKey(id: ProviderId): CommandKey {
  return `${id}Command` as CommandKey;
}

// ── Building blocks ──────────────────────────────────────────────────────────

const hintStyle: React.CSSProperties = { color: T.textMuted, fontSize: 12, marginTop: 6, lineHeight: 1.45 };

function Card({ title, hint, action, children }: { title: string; hint: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{
      background: T.surface2, border: `1px solid ${T.border}`, borderRadius: 12,
      padding: '20px 24px 8px', marginBottom: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, color: T.textStrong, margin: 0 }}>{title}</h2>
          <p style={{ ...hintStyle, marginTop: 3 }}>{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '16px 0', borderTop: `1px solid ${T.border}` }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: T.textStrong, margin: 0, letterSpacing: .2 }}>{title}</h3>
      {hint && <p style={{ ...hintStyle, marginTop: 2, marginBottom: 12 }}>{hint}</p>}
      {!hint && <div style={{ height: 12 }} />}
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>{children}</div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 12, color: T.textDim, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={hintStyle}>{hint}</div>}
    </label>
  );
}

function Banner({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const color = tone === 'warn' ? T.amber : T.blue;
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13, lineHeight: 1.45,
      background: `color-mix(in srgb, ${color} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
    }}>
      {children}
    </div>
  );
}

function Select({ value, options, labels, onChange }: { value: string; options: string[]; labels?: Record<string, string>; onChange: (v: string) => void }) {
  return (
    <span style={{ position: 'relative', display: 'block' }}>
      <select className="u-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
      </select>
      <i className="codicon codicon-chevron-down" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: T.textMuted, pointerEvents: 'none' }} />
    </span>
  );
}

function NumberInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      className="u-input mono"
      type="number"
      min={1}
      max={65535}
      value={value}
      onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }}
    />
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 15, height: 15, margin: 0, accentColor: 'var(--vscode-button-background)' }} />
      <span>{label}</span>
    </label>
  );
}

function FileRow({ label, hint, value, onChange, onPick, onCreate }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void; onPick: () => void; onCreate?: () => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="u-input mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder="—" />
        <button type="button" className="u-btn" onClick={onPick} style={{ whiteSpace: 'nowrap' }}>{STR.choose}</button>
        {onCreate && !value && (
          <button type="button" className="u-btn" onClick={onCreate} style={{ whiteSpace: 'nowrap' }}>{STR.createForMe}</button>
        )}
      </div>
    </Field>
  );
}

function PortsEditor({ ports, suggestions, onChange }: { ports: string[]; suggestions: string[]; onChange: (p: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const name = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!name || ports.includes(name)) return;
    onChange([...ports, name]);
    setDraft('');
  };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, minHeight: 24 }}>
        {ports.map((p) => (
          <span key={p} className="u-chip">
            {p}
            <button type="button" title="Remove" onClick={() => onChange(ports.filter((x) => x !== p))}>
              <i className="codicon codicon-close" style={{ fontSize: 11 }} />
            </button>
          </span>
        ))}
        {ports.length === 0 && <span style={{ color: T.textMuted, fontSize: 12, alignSelf: 'center' }}>—</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="u-input mono"
          value={draft}
          placeholder={STR.portPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }}
          style={{ maxWidth: 220 }}
        />
        <button type="button" className="u-btn" onClick={() => add(draft)}>{STR.addPort}</button>
      </div>
      {suggestions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 8 }}>
          <span style={{ color: T.textMuted, fontSize: 12 }}>{STR.portsFound}</span>
          {suggestions.map((s) => (
            <span key={s} className="u-chip suggest" onClick={() => add(s)}>
              <i className="codicon codicon-add" style={{ fontSize: 11 }} />{s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderRow({ id, primary, installed, command, onPrimary, onCommand }: {
  id: ProviderId; primary: boolean; installed: boolean; command: string; onPrimary: () => void; onCommand: (v: string) => void;
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr auto 2fr', alignItems: 'center', gap: 12,
      padding: '8px 10px', borderRadius: 8,
      background: primary ? `color-mix(in srgb, ${T.accent} 10%, transparent)` : 'transparent',
      border: `1px solid ${primary ? `color-mix(in srgb, ${T.accent} 35%, transparent)` : T.border}`,
    }}>
      <input type="radio" name="primary" checked={primary} onChange={onPrimary} title={STR.primary} style={{ margin: 0, accentColor: 'var(--vscode-button-background)' }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: primary ? 600 : 400 }}>{PROVIDER_INSTALL[id].label}</div>
      </div>
      <span style={{ fontSize: 11, color: installed ? T.green : T.textMuted, whiteSpace: 'nowrap' }}>
        {installed ? STR.installed : STR.notFound}
      </span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap' }}>{STR.command}</span>
        <input className="u-input mono" value={command} onChange={(e) => onCommand(e.target.value)} />
      </label>
    </div>
  );
}

function SaveBar({ dirty, blocked, busy, label, notice, onSave }: {
  dirty: boolean; blocked?: boolean; busy: boolean; label: string; notice: Notice; onSave: () => void;
}) {
  const status = notice
    ? notice.problems.length === 0 ? STR.saved : notice.problems.join(' · ')
    : dirty ? STR.unsaved : STR.clean;
  const statusColor = notice && notice.problems.length > 0 ? T.red : notice ? T.green : dirty ? T.amber : T.textMuted;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0 10px', borderTop: `1px solid ${T.border}` }}>
      <span style={{ flex: 1, fontSize: 12, color: statusColor }}>{status}</span>
      <button className="u-btn primary" disabled={!dirty || blocked || busy} onClick={onSave}>{label}</button>
    </div>
  );
}
