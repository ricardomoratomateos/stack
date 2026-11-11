import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import type { KeyValueStore } from '../core/KeyValueStore';
import type { INotifyPort } from '../ports/INotifyPort';
import type { HostScriptRun, HostTerminal, IWorkspaceHost } from '../application/WorktreeApplicationService';
import { runScript } from '../adapters/scriptRunner';
import type { SessionTerminalHost } from '../session/terminalHost';

/** What the service wants from a `workspaceState`/`globalState`, over a KeyValueStore. */
export interface StateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): unknown;
}

/** A KeyValueStore seen as the service's Memento-like state; `prefix` keeps one repo's keys apart from another's. */
export function stateLike(store: KeyValueStore, prefix = ''): StateLike {
  return {
    get: <T>(key: string) => store.get<T | undefined>(prefix + key, undefined),
    update: (key, value) => store.update(prefix + key, value),
  };
}

/** Notifications of a daemon: the log. Nobody is there to confirm anything, so every confirm is a cancel. */
export class LogNotify implements INotifyPort {
  constructor(private readonly log: (line: string) => void = (l) => console.error(l)) {}
  showError(message: string): void { this.log(`[stackd] error: ${message}`); }
  showWarning(message: string): void { this.log(`[stackd] warning: ${message}`); }
  showInfo(message: string): void { this.log(`[stackd] ${message}`); }
  confirm(): Promise<string | undefined> { return Promise.resolve(undefined); }
  withProgress<T>(_title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> {
    return task(() => {});
  }
}

/**
 * The editor surface of a daemon: there is none. The workspace folders are a
 * list kept in memory (the service reads them back to find the repository),
 * scripts run headless with their output to the log, and anything that needs
 * a person (input boxes, pickers) answers "nobody".
 */
export class HeadlessHost implements IWorkspaceHost {
  private folders: Array<{ path: string; name: string }>;

  constructor(
    repoRoot: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.folders = [{ path: repoRoot, name: repoRoot }];
  }

  workspaceFolderPaths(): string[] { return this.folders.map((f) => f.path); }
  removeWorkspaceFolder(index: number): void { this.folders.splice(index, 1); }
  addWorkspaceFolders(...folders: Array<{ path: string; name: string }>): void { this.folders.push(...folders); }
  renameWorkspaceFolder(index: number, folder: { path: string; name: string }): void { this.folders[index] = folder; }
  workspaceFolderName(p: string): string | undefined { return this.folders.find((f) => f.path === p)?.name; }
  saveAll(): Promise<void> { return Promise.resolve(); }
  moveEditorToFirstInGroup(): Promise<void> { return Promise.resolve(); }
  createTerminal(options: { name: string; cwd: string }): HostTerminal {
    // A "terminal" that runs what is typed into it, for the setup/teardown scripts that ask for one.
    return {
      show() {},
      sendText: (text: string) => {
        const child = spawn('sh', ['-c', text], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (c) => this.log(String(c).trimEnd()));
        child.stderr.on('data', (c) => this.log(String(c).trimEnd()));
      },
      dispose() {},
    };
  }
  runScript(run: HostScriptRun): Promise<number | null> {
    return runScript(run, { append: (t) => this.log(t.trimEnd()), appendLine: (t) => this.log(t) });
  }
  showScriptOutput(): void {}
  showInputBox(): Promise<string | undefined> { return Promise.resolve(undefined); }
  showQuickPick(): Promise<string | undefined> { return Promise.resolve(undefined); }
  updateFolderSetting(): Promise<void> { return Promise.resolve(); }
  activeTerminal(): unknown { return undefined; }
  exists(p: string): boolean { return fs.existsSync(p); }
  isDirectory(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }
  writeClipboard(): Promise<void> { return Promise.resolve(); }
  openExternal(): Promise<void> { return Promise.resolve(); }
  openFileInEditor(): Promise<void> { return Promise.resolve(); }
}

/** Tab and breakpoint managers are editor state: a daemon has no editor, so nothing to remember. */
export const NO_TABS = {
  prune() {},
  updateViewerState() {},
  closeOtherTabs: () => Promise.resolve(),
  restoreTabs: () => Promise.resolve(),
};
export const NO_BREAKPOINTS = {
  prune() {},
  activate() {},
};

/**
 * Session terminals of a daemon: nothing is drawn, so "opening" one is
 * handing back a handle that shows nothing. The tmux windows are the real
 * thing; a client attaches to them itself (attachTarget).
 */
export function headlessTerminals(): SessionTerminalHost<{ show(): void }> {
  const handle = { show() {} };
  return {
    openViewer: () => handle,
    openViewerBeside: () => handle,
    openTab: () => Promise.resolve(handle),
    current: () => undefined,
    focusedWindow: () => undefined,
    lastFocusedWindow: () => undefined,
    targetOf: () => undefined,
    targetOfName: () => undefined,
    closeTab: () => Promise.resolve(),
    closeTabsExcept: () => Promise.resolve(),
    closeAll: () => Promise.resolve(),
    takeParked: () => [],
    closeViewer: () => Promise.resolve(),
    disposeAll() {},
    claim: () => Promise.resolve(),
    pruneViews: () => Promise.resolve(),
    killViews: () => Promise.resolve(),
    dispose() {},
  };
}
