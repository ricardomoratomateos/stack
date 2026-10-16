import { describe, it, expect } from 'vitest';
import {
  dirtySections, errorSections, parsePort, parseTemplate, problemKey, projectDirty, projectDraft, projectErrors,
  projectValues, reconcileProject, reconcileUser, userDirty, userErrors,
} from '../../src/settings/draft';
import type { ProjectValues, UserValues } from '../../src/settings/types';

const project: ProjectValues = {
  worktreesDirectory: '.worktrees', defaultBaseBranch: 'main', setupScript: '', teardownScript: '',
  docker: { composeFile: 'docker-compose.yml', overrideFile: '', ports: ['HTTP_PORT'], basePort: 3100, portStride: 10 },
  debugBasePort: 9300, debugTemplate: { type: 'node', request: 'attach', name: 'Stack: Debug', port: '{{PORT}}' },
};
const user: UserValues = {
  defaultProvider: 'claude', claudeCommand: 'claude', codexCommand: 'codex', opencodeCommand: 'opencode',
  notifyOnAttention: true, focusMode: false, sidebarStyle: 'aside', sessionTabs: 'perSession', scopeSearchToActiveWorktree: true,
};

describe('parsePort', () => {
  it.each([['3000', 3000], [' 80 ', 80], ['65535', 65535], ['1', 1]])('accepts %s', (text, n) => {
    expect(parsePort(text)).toBe(n);
  });
  it.each([[''], ['0'], ['-5'], ['65536'], ['12.5'], ['abc'], ['1e3']])('rejects "%s"', (text) => {
    expect(parsePort(text)).toBeUndefined();
  });
});

describe('parseTemplate', () => {
  it('accepts an object with type and request', () => {
    expect(parseTemplate('{"type":"node","request":"attach"}')).toEqual({ value: { type: 'node', request: 'attach' } });
  });
  it('rejects text that is not JSON, or JSON that is not an object', () => {
    expect(parseTemplate('{ "type":')).toEqual({ error: 'json' });
    expect(parseTemplate('[1]')).toEqual({ error: 'json' });
    expect(parseTemplate('null')).toEqual({ error: 'json' });
    expect(parseTemplate('3')).toEqual({ error: 'json' });
  });
  it('rejects an object missing type or request', () => {
    expect(parseTemplate('{"type":"node"}')).toEqual({ error: 'shape' });
    expect(parseTemplate('{"request":"attach","type":1}')).toEqual({ error: 'shape' });
  });
});

describe('projectDraft / projectValues', () => {
  it('round-trips the values it was made from', () => {
    expect(projectValues(projectDraft(project))).toEqual(project);
    expect(projectDraft(project).dockerOn).toBe(true);
    expect(projectDraft({ ...project, docker: { ...project.docker, ports: [] } }).dockerOn).toBe(false);
  });
  it('saves no ports while Docker is off, but keeps them in the draft', () => {
    const d = { ...projectDraft(project), dockerOn: false };
    expect(projectValues(d).docker.ports).toEqual([]);
    expect(d.project.docker.ports).toEqual(['HTTP_PORT']);
  });
  it('uses what was typed when it is valid and the previous value when it is not', () => {
    const d = projectDraft(project);
    expect(projectValues({ ...d, numbers: { basePort: '4000', portStride: '20', debugBasePort: '9400' } })).toMatchObject({
      docker: { basePort: 4000, portStride: 20 }, debugBasePort: 9400,
    });
    expect(projectValues({ ...d, numbers: { basePort: '', portStride: '0', debugBasePort: '-1' } })).toMatchObject({
      docker: { basePort: 3100, portStride: 10 }, debugBasePort: 9300,
    });
  });
  it('keeps the previous template while the text does not parse', () => {
    expect(projectValues({ ...projectDraft(project), templateText: '{' }).debugTemplate).toEqual(project.debugTemplate);
    expect(projectValues({ ...projectDraft(project), templateText: '{"type":"go","request":"attach"}' }).debugTemplate)
      .toEqual({ type: 'go', request: 'attach' });
  });
});

describe('projectErrors', () => {
  it('is empty for a good draft', () => {
    expect(projectErrors(projectDraft(project))).toEqual({});
  });
  it('flags empty names, bad ports and a broken template', () => {
    const d = projectDraft({ ...project, worktreesDirectory: ' ', defaultBaseBranch: '' });
    expect(projectErrors({ ...d, numbers: { basePort: '0', portStride: '', debugBasePort: '99999' }, templateText: '{"type":"x"}' })).toEqual({
      worktreesDirectory: 'required', defaultBaseBranch: 'required', basePort: 'range', portStride: 'range',
      debugBasePort: 'range', debugTemplate: 'shape',
    });
  });
  it('ignores the Docker numbers while Docker is off', () => {
    const d = { ...projectDraft(project), dockerOn: false, numbers: { basePort: '', portStride: '', debugBasePort: '9300' } };
    expect(projectErrors(d)).toEqual({});
  });
});

describe('userErrors', () => {
  it('flags an empty agent command', () => {
    expect(userErrors(user)).toEqual({});
    expect(userErrors({ ...user, codexCommand: '  ' })).toEqual({ codexCommand: 'required' });
  });
});

describe('dirty state', () => {
  it('is clean for an untouched draft', () => {
    expect(projectDirty(projectDraft(project), project)).toBe(false);
    expect(userDirty(user, user)).toBe(false);
    expect(dirtySections(projectDraft(project), user, project, user)).toEqual([]);
  });
  it('names the sections that differ, across both scopes', () => {
    const d = { ...projectDraft(project), project: { ...project, setupScript: '.stack/setup.sh' } };
    const u = { ...user, focusMode: true, sidebarStyle: 'claude' as const };
    expect(projectDirty(d, project)).toBe(true);
    expect(userDirty(u, user)).toBe(true);
    expect(dirtySections(d, u, project, user)).toEqual(['appearance', 'worktrees', 'scripts']);
  });
  it('sees a typed port as an edit to its section', () => {
    const d = { ...projectDraft(project), numbers: { basePort: '3200', portStride: '10', debugBasePort: '9300' } };
    expect(dirtySections(d, user, project, user)).toEqual(['docker']);
  });
});

describe('errorSections', () => {
  it('maps each blocking field to the section it lives in', () => {
    expect(errorSections(projectDraft(project), user)).toEqual([]);
    const d = projectDraft({ ...project, worktreesDirectory: '' });
    const bad = { ...d, numbers: { basePort: 'x', portStride: '10', debugBasePort: '' }, templateText: '' };
    expect(errorSections(bad, { ...user, claudeCommand: '' })).toEqual(['general', 'worktrees', 'docker', 'debugging']);
    expect(errorSections({ ...projectDraft(project), project: { ...project, defaultBaseBranch: '' } }, user)).toEqual(['worktrees']);
    expect(errorSections({ ...projectDraft(project), numbers: { basePort: '3100', portStride: '', debugBasePort: '9300' } }, user)).toEqual(['docker']);
  });
});

describe('reconcile', () => {
  const next = { ...project, setupScript: 'from-disk.sh' };
  it('adopts the new snapshot for a scope nobody touched', () => {
    expect(reconcileProject(project, projectDraft(project), next)).toEqual(projectDraft(next));
    expect(reconcileUser(user, user, { ...user, focusMode: true })).toEqual({ ...user, focusMode: true });
  });
  it('keeps an edit in progress when the other scope saved', () => {
    const editing = { ...projectDraft(project), project: { ...project, worktreesDirectory: '../wt' } };
    expect(reconcileProject(project, editing, project)).toBe(editing);
    const editingUser = { ...user, focusMode: true };
    expect(reconcileUser(user, editingUser, user)).toBe(editingUser);
  });
  it('keeps the draft after its own save, which is now clean', () => {
    const saved = { ...project, setupScript: 'x.sh' };
    const draft = { ...projectDraft(project), project: saved };
    const after = reconcileProject(project, draft, saved);
    expect(projectDirty(after, saved)).toBe(false);
  });
  it('keeps a Docker switch that was flipped on before any port was added', () => {
    const off = { ...project, docker: { ...project.docker, ports: [] } };
    const flipped = { ...projectDraft(off), dockerOn: true };
    expect(reconcileProject(off, flipped, off).dockerOn).toBe(true);
  });
});

describe('problemKey', () => {
  it('reads the top-level key a problem is about', () => {
    expect(problemKey('"docker.basePort" must be a whole number between 1 and 65535, got "abc"')).toBe('docker');
    expect(problemKey('unknown key "docker.foo"')).toBe('docker');
    expect(problemKey('"setupScript" must be a string, got 3')).toBe('setupScript');
  });
  it('is undefined for a problem that names no key', () => {
    expect(problemKey('could not read the file')).toBeUndefined();
  });
});
