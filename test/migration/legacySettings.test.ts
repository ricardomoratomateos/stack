import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { workspace, resetVscodeMock, ConfigurationTarget, FakeMemento, Uri } from 'vscode';
import {
  GLOBAL_SETTINGS_MIGRATED_KEY,
  SETTING_KEYS,
  WORKSPACE_SETTINGS_MIGRATED_KEY,
  migrateLegacySettings,
  vscodeSettingsHost,
} from '../../src/migration/legacySettings';

type Level = 'globalValue' | 'workspaceValue' | 'workspaceFolderValue';
const LEVEL_OF: Record<number, Level> = {
  [ConfigurationTarget.Global]: 'globalValue',
  [ConfigurationTarget.Workspace]: 'workspaceValue',
  [ConfigurationTarget.WorkspaceFolder]: 'workspaceFolderValue',
};

/**
 * settings.json at every level, for both sections, behind the real
 * getConfiguration(section, scope).inspect/update shape. Folder values are
 * keyed by the folder's path; a scope-less read sees no folder value, as in
 * VS Code.
 */
function fakeSettings() {
  const store = new Map<string, unknown>();
  const id = (section: string, key: string, level: Level, folder?: string) =>
    `${section}.${key}@${level}${level === 'workspaceFolderValue' ? `:${folder ?? ''}` : ''}`;
  const set = (section: string, key: string, level: Level, value: unknown, folder?: string) =>
    store.set(id(section, key, level, folder), value);
  const get = (section: string, key: string, level: Level, folder?: string) => store.get(id(section, key, level, folder));
  const updates: Array<{ section: string; key: string; value: unknown; target: number; folder?: string }> = [];
  let failOn: string | undefined;

  workspace.getConfiguration.mockImplementation(((section: string, scope?: Uri) => ({
    get: vi.fn(),
    inspect: (key: string) => ({
      key,
      globalValue: get(section, key, 'globalValue'),
      workspaceValue: get(section, key, 'workspaceValue'),
      workspaceFolderValue: scope ? get(section, key, 'workspaceFolderValue', scope.fsPath) : undefined,
    }),
    update: vi.fn(async (key: string, value: unknown, target: number) => {
      if (failOn === `${section}.${key}`) throw new Error('read-only settings file');
      updates.push({ section, key, value, target, ...(scope ? { folder: scope.fsPath } : {}) });
      set(section, key, LEVEL_OF[target]!, value, scope?.fsPath);
    }),
  })) as never);

  return { set, get, updates, failWritesTo: (key: string) => { failOn = key; } };
}

describe('migrateLegacySettings', () => {
  let globalState: FakeMemento;
  let workspaceState: FakeMemento;
  let settings: ReturnType<typeof fakeSettings>;
  const run = () => migrateLegacySettings(vscodeSettingsHost(), globalState as never, workspaceState as never);

  beforeEach(() => {
    resetVscodeMock();
    globalState = new FakeMemento();
    workspaceState = new FakeMemento();
    settings = fakeSettings();
  });

  it('knows every setting package.json contributes', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const contributed = Object.keys(pkg.contributes.configuration.properties).map((k: string) => k.replace(/^stack\./, ''));
    expect([...SETTING_KEYS].sort()).toEqual(contributed.sort());
  });

  it('copies user-level foreman.* values to stack.*, objects included, and leaves the old ones', async () => {
    const docker = { composeFile: 'compose.yml', ports: ['HTTP_PORT'] };
    settings.set('foreman', 'setupScript', 'globalValue', '.foreman/setup.sh');
    settings.set('foreman', 'docker', 'globalValue', docker);
    settings.set('foreman', 'notifyOnAttention', 'globalValue', false);

    const migrated = await run();

    expect(settings.get('stack', 'setupScript', 'globalValue')).toBe('.foreman/setup.sh');
    expect(settings.get('stack', 'docker', 'globalValue')).toEqual(docker);
    expect(settings.get('stack', 'notifyOnAttention', 'globalValue')).toBe(false);
    expect(settings.updates.every((u) => u.section === 'stack' && u.target === ConfigurationTarget.Global)).toBe(true);
    expect(settings.get('foreman', 'setupScript', 'globalValue')).toBe('.foreman/setup.sh');
    expect(migrated.map((m) => [m.key, m.level])).toEqual([
      ['stack.setupScript', 'global'],
      ['stack.notifyOnAttention', 'global'],
      ['stack.docker', 'global'],
    ]);
  });

  it('copies workspace-level values to the workspace level', async () => {
    workspace.workspaceFolders = [{ uri: Uri.file('/repo'), name: 'repo', index: 0 }];
    settings.set('foreman', 'worktreesDirectory', 'workspaceValue', '../wt');

    const migrated = await run();

    expect(settings.get('stack', 'worktreesDirectory', 'workspaceValue')).toBe('../wt');
    expect(settings.updates).toEqual([
      { section: 'stack', key: 'worktreesDirectory', value: '../wt', target: ConfigurationTarget.Workspace },
    ]);
    expect(migrated).toEqual([{ key: 'stack.worktreesDirectory', level: 'workspace' }]);
  });

  it("copies each folder's own values to that folder in a multi-root workspace", async () => {
    workspace.workspaceFile = Uri.file('/work/all.code-workspace');
    workspace.workspaceFolders = [
      { uri: Uri.file('/work/a'), name: 'a', index: 0 },
      { uri: Uri.file('/work/b'), name: 'b', index: 1 },
    ];
    settings.set('foreman', 'defaultBaseBranch', 'workspaceFolderValue', 'main', '/work/a');
    settings.set('foreman', 'defaultBaseBranch', 'workspaceFolderValue', 'trunk', '/work/b');

    const migrated = await run();

    expect(settings.get('stack', 'defaultBaseBranch', 'workspaceFolderValue', '/work/a')).toBe('main');
    expect(settings.get('stack', 'defaultBaseBranch', 'workspaceFolderValue', '/work/b')).toBe('trunk');
    expect(settings.updates.map((u) => [u.target, u.folder])).toEqual([
      [ConfigurationTarget.WorkspaceFolder, '/work/a'],
      [ConfigurationTarget.WorkspaceFolder, '/work/b'],
    ]);
    expect(migrated).toEqual([
      { key: 'stack.defaultBaseBranch', level: 'workspaceFolder', folder: '/work/a' },
      { key: 'stack.defaultBaseBranch', level: 'workspaceFolder', folder: '/work/b' },
    ]);
  });

  it('treats a single folder as the workspace: its settings are not copied twice', async () => {
    workspace.workspaceFolders = [{ uri: Uri.file('/repo'), name: 'repo', index: 0 }];
    settings.set('foreman', 'focusMode', 'workspaceFolderValue', true, '/repo');

    await run();

    expect(settings.updates).toEqual([]);
  });

  it('never overwrites a stack.* value already set at that level', async () => {
    workspace.workspaceFolders = [{ uri: Uri.file('/repo'), name: 'repo', index: 0 }];
    settings.set('foreman', 'claudeCommand', 'globalValue', 'old-claude');
    settings.set('stack', 'claudeCommand', 'globalValue', 'new-claude');
    settings.set('foreman', 'sidebarStyle', 'workspaceValue', 'mission');
    settings.set('stack', 'sidebarStyle', 'workspaceValue', 'claude');
    // Set at another level only: this level still gets the old value.
    settings.set('foreman', 'focusMode', 'workspaceValue', true);
    settings.set('stack', 'focusMode', 'globalValue', false);

    await run();

    expect(settings.get('stack', 'claudeCommand', 'globalValue')).toBe('new-claude');
    expect(settings.get('stack', 'sidebarStyle', 'workspaceValue')).toBe('claude');
    expect(settings.get('stack', 'focusMode', 'workspaceValue')).toBe(true);
    expect(settings.updates.map((u) => u.key)).toEqual(['focusMode']);
  });

  it('runs once: the user level per machine, the workspace levels per workspace', async () => {
    workspace.workspaceFolders = [{ uri: Uri.file('/repo'), name: 'repo', index: 0 }];
    settings.set('foreman', 'codexCommand', 'globalValue', 'codex-1');
    await run();
    expect(globalState.get(GLOBAL_SETTINGS_MIGRATED_KEY)).toBe(true);
    expect(workspaceState.get(WORKSPACE_SETTINGS_MIGRATED_KEY)).toBe(true);

    // Removed by the user afterwards: not brought back.
    settings.set('stack', 'codexCommand', 'globalValue', undefined);
    settings.set('foreman', 'opencodeCommand', 'workspaceValue', 'oc');
    settings.updates.length = 0;
    await expect(run()).resolves.toEqual([]);
    expect(settings.updates).toEqual([]);

    // Another workspace on the same machine still has its own to carry over.
    const elsewhere = new FakeMemento();
    await expect(migrateLegacySettings(vscodeSettingsHost(), globalState as never, elsewhere as never))
      .resolves.toEqual([{ key: 'stack.opencodeCommand', level: 'workspace' }]);
  });

  it('leaves workspace levels for later when no folder is open', async () => {
    settings.set('foreman', 'debugBasePort', 'workspaceValue', 9000);
    await run();
    expect(settings.updates).toEqual([]);
    expect(workspaceState.get(WORKSPACE_SETTINGS_MIGRATED_KEY)).toBeUndefined();
  });

  it('skips a value it cannot write and carries on with the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    settings.set('foreman', 'setupScript', 'globalValue', 'a.sh');
    settings.set('foreman', 'teardownScript', 'globalValue', 'b.sh');
    settings.failWritesTo('stack.setupScript');

    const migrated = await run();

    expect(migrated).toEqual([{ key: 'stack.teardownScript', level: 'global' }]);
    expect(warn).toHaveBeenCalled();
    expect(globalState.get(GLOBAL_SETTINGS_MIGRATED_KEY)).toBe(true);
    warn.mockRestore();
  });

  it('lists no separate folders for a workspace file whose folders are all gone', () => {
    workspace.workspaceFile = Uri.file('/work/empty.code-workspace');
    expect(vscodeSettingsHost().separateFolders()).toEqual([]);
    expect(vscodeSettingsHost().hasWorkspace()).toBe(false);
  });

  it('reads nothing when getConfiguration reports no inspection at all', async () => {
    workspace.getConfiguration.mockImplementation((() => ({ inspect: () => undefined, update: vi.fn() })) as never);
    await expect(run()).resolves.toEqual([]);
  });
});
