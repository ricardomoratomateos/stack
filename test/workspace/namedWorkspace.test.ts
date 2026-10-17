import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';
import { FakeMemento, Uri, commands, window, workspace, ConfigurationTarget, resetVscodeMock } from 'vscode';
import {
  CONFIRM_SAVE_UNTITLED,
  NAME_IT,
  NAMING_ASKED_KEY,
  NOT_NOW,
  NamedWorkspace,
  STATE_STASH_KEY,
  carriedSettingKeys,
  namedWorkspacePath,
  renderWorkspaceFile,
  restoreStashedState,
  vscodeNamedWorkspaceHost,
  type FolderSpec,
  type NamedWorkspaceHost,
} from '../../src/workspace/namedWorkspace';
import { SETTING_KEYS } from '../../src/migration/legacySettings';
import type { IFileSystem } from '../../src/ports/IFileSystem';

const STORAGE = '/storage';
const ROOT = '/Users/me/aside';
const FILE = namedWorkspacePath(STORAGE, ROOT);

class MemFs implements IFileSystem {
  files = new Map<string, string>();
  dirs: string[] = [];
  failMkdir = false;
  failRead = false;
  exists(p: string): boolean { return this.files.has(p); }
  readFile(p: string): string {
    if (this.failRead) throw new Error('EACCES');
    return this.files.get(p)!;
  }
  writeFile(p: string, content: string): void { this.files.set(p, content); }
  mkdir(p: string): void {
    if (this.failMkdir) throw new Error('EROFS: read-only file system');
    this.dirs.push(p);
  }
}

interface HostOpts {
  file?: { scheme: string; fsPath: string };
  folders?: FolderSpec[];
  values?: Record<string, unknown>;
  pick?: string;
}

function makeHost(o: HostOpts = {}) {
  const host = {
    workspaceFile: vi.fn(() => o.file),
    folders: vi.fn(() => o.folders ?? [{ path: ROOT, name: 'aside' }]),
    workspaceValue: vi.fn((key: string) => o.values?.[key]),
    setWorkspaceValue: vi.fn(async (_key: string, _value: unknown) => {}),
    openWorkspace: vi.fn(async (_file: string) => {}),
    ask: vi.fn(async (_message: string, ..._items: string[]): Promise<string | undefined> => o.pick),
    warn: vi.fn(),
    log: vi.fn(),
  };
  return host;
}

function make(o: HostOpts = {}) {
  const fs = new MemFs();
  const host = makeHost(o);
  const globalState = new FakeMemento();
  const workspaceState = new FakeMemento();
  const named = new NamedWorkspace({
    storageDir: STORAGE,
    fs,
    host: host as NamedWorkspaceHost,
    globalState,
    workspaceState,
  });
  return { fs, host, globalState, workspaceState, named };
}

const written = (fs: MemFs) => JSON.parse(fs.files.get(FILE)!);

describe('namedWorkspacePath', () => {
  it('is <storage>/workspaces/<12 hex of sha1(root)>/<basename>.code-workspace', () => {
    const hash = crypto.createHash('sha1').update(ROOT).digest('hex').slice(0, 12);
    expect(FILE).toBe(nodePath.join(STORAGE, 'workspaces', hash, 'aside.code-workspace'));
  });

  it('is the same file for the same root however it is spelled', () => {
    expect(namedWorkspacePath(STORAGE, `${ROOT}/`)).toBe(FILE);
  });

  it('is a different file for a different repository of the same name', () => {
    expect(namedWorkspacePath(STORAGE, '/elsewhere/aside')).not.toBe(FILE);
  });
});

describe('carriedSettingKeys', () => {
  it('is every stack.* setting', () => {
    expect(carriedSettingKeys()).toEqual(SETTING_KEYS.map((k) => `stack.${k}`));
  });
});

describe('renderWorkspaceFile', () => {
  const folders = [{ path: ROOT, name: 'develop' }, { path: `${ROOT}/.worktrees/feat-a`, name: 'feat/a' }];

  it('writes folders (path + name) and settings', () => {
    expect(JSON.parse(renderWorkspaceFile(undefined, folders, { 'stack.focusMode': true }))).toEqual({
      folders: [{ path: ROOT, name: 'develop' }, { path: `${ROOT}/.worktrees/feat-a`, name: 'feat/a' }],
      settings: { 'stack.focusMode': true },
    });
  });

  it('replaces the folders, merges the settings, and keeps everything else', () => {
    const existing = {
      folders: [{ path: '/old' }],
      settings: { 'editor.tabSize': 2, 'stack.focusMode': false },
      launch: { configurations: [] },
    };
    expect(JSON.parse(renderWorkspaceFile(existing, folders, { 'stack.focusMode': true }))).toEqual({
      folders: [{ path: ROOT, name: 'develop' }, { path: `${ROOT}/.worktrees/feat-a`, name: 'feat/a' }],
      settings: { 'editor.tabSize': 2, 'stack.focusMode': true },
      launch: { configurations: [] },
    });
  });

  it('ignores a settings entry that is not an object', () => {
    expect(JSON.parse(renderWorkspaceFile({ settings: [1] }, [], {})).settings).toEqual({});
  });

  it('ends with a newline', () => {
    expect(renderWorkspaceFile(undefined, [], {}).endsWith('}\n')).toBe(true);
  });
});

describe('restoreStashedState', () => {
  let globalState: FakeMemento;
  let workspaceState: FakeMemento;
  beforeEach(() => {
    globalState = new FakeMemento();
    workspaceState = new FakeMemento();
  });

  it('does nothing outside a file-backed workspace', async () => {
    await globalState.update(STATE_STASH_KEY + FILE, { a: 1 });
    expect(await restoreStashedState(undefined, globalState, workspaceState)).toEqual([]);
    expect(await restoreStashedState({ scheme: 'untitled', fsPath: FILE }, globalState, workspaceState)).toEqual([]);
    expect(workspaceState.keys()).toEqual([]);
    expect(globalState.get(STATE_STASH_KEY + FILE)).toEqual({ a: 1 });
  });

  it('does nothing when no stash was left for this file', async () => {
    expect(await restoreStashedState({ scheme: 'file', fsPath: FILE }, globalState, workspaceState)).toEqual([]);
  });

  it('puts the stash back, keeps what the workspace already has, and drops the stash', async () => {
    await globalState.update(STATE_STASH_KEY + FILE, { 'stack.activeWorktreeId': 'wt-2', 'stack.migration.state': true });
    await workspaceState.update('stack.migration.state', 'own');
    const restored = await restoreStashedState({ scheme: 'file', fsPath: FILE }, globalState, workspaceState);
    expect(restored).toEqual(['stack.activeWorktreeId']);
    expect(workspaceState.get('stack.activeWorktreeId')).toBe('wt-2');
    expect(workspaceState.get('stack.migration.state')).toBe('own');
    expect(globalState.get(STATE_STASH_KEY + FILE)).toBeUndefined();
  });
});

describe('NamedWorkspace', () => {
  describe('what kind of window this is', () => {
    it('single folder: no workspace file', () => {
      expect(make().named.isSingleFolder()).toBe(true);
      expect(make().named.isUntitled()).toBe(false);
    });

    it('untitled workspace', () => {
      const { named } = make({ file: { scheme: 'untitled', fsPath: 'Untitled-1' } });
      expect(named.isSingleFolder()).toBe(false);
      expect(named.isUntitled()).toBe(true);
    });

    it('a workspace file', () => {
      const { named } = make({ file: { scheme: 'file', fsPath: FILE } });
      expect(named.isSingleFolder()).toBe(false);
      expect(named.isUntitled()).toBe(false);
    });

    it('knows its file', () => {
      expect(make().named.fileFor(ROOT)).toBe(FILE);
    });
  });

  describe('open', () => {
    const folders = [{ path: ROOT, name: 'develop' }, { path: `${ROOT}/.worktrees/feat-a`, name: 'feat/a' }];

    it('writes the file with the folders and the workspace-level stack.* settings, then opens it', async () => {
      const { fs, host, named } = make({
        values: { 'stack.focusMode': true, 'stack.sidebarStyle': 'claude', 'search.exclude': { '**': true } },
      });
      expect(await named.open(ROOT, folders)).toBe(true);
      expect(fs.dirs).toEqual([nodePath.dirname(FILE)]);
      expect(written(fs)).toEqual({
        folders,
        // search.exclude is not carried: Stack writes it per folder, never at workspace level.
        settings: { 'stack.focusMode': true, 'stack.sidebarStyle': 'claude' },
      });
      expect(host.openWorkspace).toHaveBeenCalledWith(FILE);
      expect(host.log).toHaveBeenCalledWith(`opened ${FILE}`);
    });

    it('stashes this window\'s workspaceState under the file before switching', async () => {
      const { host, globalState, workspaceState, named } = make();
      await workspaceState.update('stack.activeWorktreeId', 'wt-1');
      await workspaceState.update('stack.migration.state', true);
      host.openWorkspace.mockImplementation(async () => {
        expect(globalState.get(STATE_STASH_KEY + FILE)).toEqual({
          'stack.activeWorktreeId': 'wt-1',
          'stack.migration.state': true,
        });
      });
      await named.open(ROOT, folders);
      expect(host.openWorkspace).toHaveBeenCalledOnce();
    });

    it('leaves a value the memento lists but holds as undefined out of the stash', async () => {
      const { globalState, workspaceState, named } = make();
      vi.spyOn(workspaceState, 'keys').mockReturnValue(['ghost']);
      await named.open(ROOT, folders);
      expect(globalState.get(STATE_STASH_KEY + FILE)).toEqual({});
    });

    it('updates the file already there instead of making a second', async () => {
      const { fs, named } = make({ values: { 'stack.focusMode': true } });
      fs.files.set(FILE, JSON.stringify({ folders: [{ path: '/gone' }], settings: { 'editor.tabSize': 4 }, extensions: { recommendations: ['x'] } }));
      await named.open(ROOT, folders);
      expect(written(fs)).toEqual({
        folders,
        settings: { 'editor.tabSize': 4, 'stack.focusMode': true },
        extensions: { recommendations: ['x'] },
      });
      expect([...fs.files.keys()]).toEqual([FILE]);
    });

    it('treats an existing file that is JSON but not an object as empty', async () => {
      const { fs, named } = make();
      fs.files.set(FILE, '[1, 2]');
      await named.open(ROOT, folders);
      expect(written(fs)).toEqual({ folders, settings: {} });
      fs.files.set(FILE, 'null');
      await named.open(ROOT, folders);
      expect(written(fs)).toEqual({ folders, settings: {} });
    });

    it('leaves a file it cannot parse (comments: VS Code reads JSONC) as it is, and opens it anyway', async () => {
      const { fs, host, named } = make();
      const jsonc = '{ // mine\n "folders": [] }';
      fs.files.set(FILE, jsonc);
      expect(await named.open(ROOT, folders)).toBe(true);
      expect(fs.files.get(FILE)).toBe(jsonc);
      expect(host.log).toHaveBeenCalledWith(`${FILE} is not plain JSON; opening it as it is`);
      expect(host.openWorkspace).toHaveBeenCalledWith(FILE);
    });

    it('falls back when the directory cannot be written — logged, nothing stashed, nothing opened', async () => {
      const { fs, host, globalState, named } = make();
      fs.failMkdir = true;
      expect(await named.open(ROOT, folders)).toBe(false);
      expect(host.log).toHaveBeenCalledWith(expect.stringContaining(`could not write ${FILE}: Error: EROFS`));
      expect(host.openWorkspace).not.toHaveBeenCalled();
      expect(globalState.get(STATE_STASH_KEY + FILE)).toBeUndefined();
    });

    it('falls back when the existing file cannot be read', async () => {
      const { fs, host, named } = make();
      fs.files.set(FILE, '{}');
      fs.failRead = true;
      expect(await named.open(ROOT, folders)).toBe(false);
      expect(host.openWorkspace).not.toHaveBeenCalled();
    });

    it('falls back when the file cannot be opened, and drops the stash', async () => {
      const { host, globalState, named } = make();
      host.openWorkspace.mockRejectedValue(new Error('nope'));
      expect(await named.open(ROOT, folders)).toBe(false);
      expect(host.log).toHaveBeenCalledWith(`could not open ${FILE}: Error: nope`);
      expect(globalState.get(STATE_STASH_KEY + FILE)).toBeUndefined();
    });

    it('from a single folder, leaves the confirm-save setting alone — there is no untitled workspace to discard', async () => {
      const { host, named } = make();
      await named.open(ROOT, folders);
      expect(host.setWorkspaceValue).not.toHaveBeenCalled();
    });

    it('from an untitled workspace, turns off its "save your workspace?" prompt before switching', async () => {
      const { host, named } = make({ file: { scheme: 'untitled', fsPath: 'Untitled-1' } });
      await named.open(ROOT, folders);
      expect(host.setWorkspaceValue).toHaveBeenCalledWith(CONFIRM_SAVE_UNTITLED, false);
      expect(host.setWorkspaceValue.mock.invocationCallOrder[0]).toBeLessThan(host.openWorkspace.mock.invocationCallOrder[0]);
    });

    it('still switches when that setting cannot be written (VS Code then asks)', async () => {
      const { host, named } = make({ file: { scheme: 'untitled', fsPath: 'Untitled-1' } });
      host.setWorkspaceValue.mockRejectedValue(new Error('application scope'));
      expect(await named.open(ROOT, folders)).toBe(true);
      expect(host.log).toHaveBeenCalledWith(`could not turn off ${CONFIRM_SAVE_UNTITLED} for the untitled workspace: Error: application scope`);
    });
  });

  describe('offer (an untitled workspace, once per repository)', () => {
    const untitled = { scheme: 'untitled', fsPath: 'Untitled-1' };
    const message = 'Name this window "aside"? It reloads once; agents keep running in tmux.';

    it('asks nothing without a repository', async () => {
      const { host, named } = make({ file: untitled });
      await named.offer(undefined);
      expect(host.ask).not.toHaveBeenCalled();
    });

    it('asks nothing in a single-folder window or a named workspace', async () => {
      for (const file of [undefined, { scheme: 'file', fsPath: FILE }]) {
        const { host, named } = make({ file });
        await named.offer(ROOT);
        expect(host.ask).not.toHaveBeenCalled();
      }
    });

    it('"Name it": remembered, and the window switches to the named file with its current folders', async () => {
      const { host, globalState, fs, named } = make({
        file: untitled,
        pick: NAME_IT,
        folders: [{ path: '/notes', name: 'notes' }, { path: ROOT, name: 'develop' }, { path: `${ROOT}/.worktrees/b`, name: 'b' }],
      });
      await named.offer(ROOT);
      expect(host.ask).toHaveBeenCalledWith(message, NAME_IT, NOT_NOW);
      expect(globalState.get(NAMING_ASKED_KEY + ROOT)).toBe('named');
      // The repository's own folder first, then the rest in their order.
      expect(written(fs).folders).toEqual([
        { path: ROOT, name: 'develop' },
        { path: '/notes', name: 'notes' },
        { path: `${ROOT}/.worktrees/b`, name: 'b' },
      ]);
      expect(host.openWorkspace).toHaveBeenCalledWith(FILE);
    });

    it('"Not now" is remembered and nothing changes', async () => {
      const { host, globalState, named } = make({ file: untitled, pick: NOT_NOW });
      await named.offer(ROOT);
      expect(globalState.get(NAMING_ASKED_KEY + ROOT)).toBe('not-now');
      expect(host.openWorkspace).not.toHaveBeenCalled();
    });

    it('a toast closed unanswered counts as "Not now"', async () => {
      const { globalState, named } = make({ file: untitled, pick: undefined });
      await named.offer(ROOT);
      expect(globalState.get(NAMING_ASKED_KEY + ROOT)).toBe('not-now');
    });

    it('is remembered before the toast shows, so a window closed under it is not asked again', async () => {
      const { host, globalState, named } = make({ file: untitled });
      host.ask.mockImplementation(async () => {
        expect(globalState.get(NAMING_ASKED_KEY + ROOT)).toBe('asked');
        return undefined;
      });
      await named.offer(ROOT);
      expect(host.ask).toHaveBeenCalledOnce();
    });

    it('never asks twice for the same repository', async () => {
      const { host, globalState, named } = make({ file: untitled });
      await globalState.update(NAMING_ASKED_KEY + ROOT, 'not-now');
      await named.offer(`${ROOT}/`);
      expect(host.ask).not.toHaveBeenCalled();
    });
  });

  describe('nameNow (Stack: Name This Workspace)', () => {
    it('needs a repository', async () => {
      const { host, named } = make({ file: { scheme: 'untitled', fsPath: 'Untitled-1' } });
      await named.nameNow(undefined);
      expect(host.warn).toHaveBeenCalledWith('Stack: open a git repository first.');
      expect(host.openWorkspace).not.toHaveBeenCalled();
    });

    it('says so when the window already has a workspace file', async () => {
      const { host, named } = make({ file: { scheme: 'file', fsPath: FILE } });
      await named.nameNow(ROOT);
      expect(host.warn).toHaveBeenCalledWith('Stack: this window is already named after aside.code-workspace.');
      expect(host.openWorkspace).not.toHaveBeenCalled();
    });

    it('names an untitled workspace even after "Not now"', async () => {
      const { host, globalState, named } = make({ file: { scheme: 'untitled', fsPath: 'Untitled-1' } });
      await globalState.update(NAMING_ASKED_KEY + ROOT, 'not-now');
      await named.nameNow(ROOT);
      expect(host.openWorkspace).toHaveBeenCalledWith(FILE);
      expect(host.warn).not.toHaveBeenCalled();
    });

    it('names a single-folder window too', async () => {
      const { host, fs, named } = make();
      await named.nameNow(ROOT);
      expect(written(fs).folders).toEqual([{ path: ROOT, name: 'aside' }]);
      expect(host.openWorkspace).toHaveBeenCalledWith(FILE);
    });

    it('warns when the file cannot be written', async () => {
      const { host, fs, named } = make({ file: { scheme: 'untitled', fsPath: 'Untitled-1' } });
      fs.failMkdir = true;
      await named.nameNow(ROOT);
      expect(host.warn).toHaveBeenCalledWith('Stack: could not write the workspace file — see the Stack output.');
    });
  });
});

describe('vscodeNamedWorkspaceHost', () => {
  const output = { appendLine: vi.fn() };
  const host = vscodeNamedWorkspaceHost(output);
  beforeEach(() => resetVscodeMock());

  it('reads the workspace file and folders', () => {
    expect(host.workspaceFile()).toBeUndefined();
    expect(host.folders()).toEqual([]);
    workspace.workspaceFile = new Uri('untitled', 'Untitled-1');
    workspace.workspaceFolders = [{ uri: Uri.file(ROOT), name: 'develop', index: 0 }];
    expect(host.workspaceFile()?.scheme).toBe('untitled');
    expect(host.folders()).toEqual([{ path: ROOT, name: 'develop' }]);
  });

  it('reads a workspace-level value through inspect', () => {
    const inspect = vi.fn((key: string) => ({ key, workspaceValue: key === 'stack.focusMode' ? true : undefined }));
    workspace.getConfiguration.mockReturnValue({ get: vi.fn(), inspect, update: vi.fn() } as never);
    expect(host.workspaceValue('stack.focusMode')).toBe(true);
    expect(host.workspaceValue('stack.docker')).toBeUndefined();
    expect(workspace.getConfiguration).toHaveBeenCalledWith();
    workspace.getConfiguration.mockReturnValue({ get: vi.fn(), inspect: vi.fn(() => undefined), update: vi.fn() } as never);
    expect(host.workspaceValue('x')).toBeUndefined();
  });

  it('writes a workspace-level value', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    workspace.getConfiguration.mockReturnValue({ get: vi.fn(), inspect: vi.fn(), update } as never);
    await host.setWorkspaceValue(CONFIRM_SAVE_UNTITLED, false);
    expect(update).toHaveBeenCalledWith(CONFIRM_SAVE_UNTITLED, false, ConfigurationTarget.Workspace);
  });

  it('opens the file in this window with vscode.openFolder', async () => {
    await host.openWorkspace(FILE);
    expect(commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', Uri.file(FILE), { forceReuseWindow: true });
  });

  it('asks, warns and logs through the window and the Stack channel', async () => {
    window.showInformationMessage.mockResolvedValueOnce(NAME_IT as never);
    expect(await host.ask('q?', NAME_IT, NOT_NOW)).toBe(NAME_IT);
    expect(window.showInformationMessage).toHaveBeenCalledWith('q?', NAME_IT, NOT_NOW);
    host.warn('careful');
    expect(window.showWarningMessage).toHaveBeenCalledWith('careful');
    host.log('hello');
    expect(output.appendLine).toHaveBeenCalledWith('[stack] named workspace: hello');
  });
});
