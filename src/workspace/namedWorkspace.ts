import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IFileSystem } from '../ports/IFileSystem';
import { SETTINGS_SECTION, SETTING_KEYS } from '../migration/legacySettings';
import { canonicalPath } from '../worktree/worktreesInRepo';

/**
 * A window named after its project.
 *
 * Adding a worktree folder to a single-folder window turns it into an UNTITLED
 * multi-root workspace, and VS Code calls that "Untitled (Workspace)" in the
 * title bar and the Explorer — forever, since an untitled workspace cannot be
 * renamed through the API. A workspace is named after its `.code-workspace`
 * file, so Stack writes one per repository and opens that instead:
 *
 *   <globalStorage>/workspaces/<sha1(repoRoot) prefix>/<repo basename>.code-workspace
 *
 * In the extension's own storage, never in the repository: git does not see
 * it and nobody commits it. Opened once, VS Code itself keeps its `folders` in
 * step with every later updateWorkspaceFolders.
 */

/** Subdirectory of the extension's global storage that holds the files. */
export const WORKSPACES_DIR = 'workspaces';
/** globalState, per repository root: the offer to name an untitled window was made (and its answer). */
export const NAMING_ASKED_KEY = 'stack.namedWorkspace.asked:';
/** globalState, per workspace file: the workspaceState that file's first window must start from. */
export const STATE_STASH_KEY = 'stack.namedWorkspace.stash:';
/**
 * Leaving an untitled workspace makes VS Code ask "Do you want to save your
 * workspace configuration as a file?" — exactly the question the named file
 * answers. Turned off in the untitled workspace being left (its own settings,
 * which VS Code discards with it), so the switch is the one reload promised.
 */
export const CONFIRM_SAVE_UNTITLED = 'window.confirmSaveUntitledWorkspace';

export const NAME_IT = 'Name it';
export const NOT_NOW = 'Not now';

export interface FolderSpec {
  path: string;
  name: string;
}

/** The VS Code surface this needs, behind a port so every branch is testable. */
export interface NamedWorkspaceHost {
  /** vscode.workspace.workspaceFile: undefined for a single folder, `untitled:` for an untitled workspace. */
  workspaceFile(): { scheme: string; fsPath: string } | undefined;
  /** The window's folders, in order, with their display names. */
  folders(): FolderSpec[];
  /** What a setting holds at workspace level (`inspect(key).workspaceValue`). */
  workspaceValue(key: string): unknown;
  /** Write a setting at workspace level, in the workspace this window has open now. */
  setWorkspaceValue(key: string, value: unknown): Promise<void>;
  /** Open a .code-workspace file in this window (vscode.openFolder, reusing the window). */
  openWorkspace(file: string): Promise<void>;
  ask(message: string, ...items: string[]): Promise<string | undefined>;
  warn(message: string): void;
  /** To the Stack output channel. */
  log(message: string): void;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
}

export interface NamedWorkspaceDeps {
  /** ctx.globalStorageUri.fsPath */
  storageDir: string;
  fs: IFileSystem;
  host: NamedWorkspaceHost;
  globalState: MementoLike;
  workspaceState: MementoLike;
}

/** The settings carried from the workspace being left into the named file. */
export function carriedSettingKeys(): string[] {
  return SETTING_KEYS.map((key) => `${SETTINGS_SECTION}.${key}`);
}

/** Where a repository's named workspace file lives. Same root, same file — always. */
export function namedWorkspacePath(storageDir: string, repoRoot: string): string {
  const root = canonicalPath(repoRoot);
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
  return path.join(storageDir, WORKSPACES_DIR, hash, `${path.basename(root)}.code-workspace`);
}

/**
 * The file's text: `folders` replaced by the ones given, `settings` merged over
 * whatever the file already had, and anything else in it (launch, tasks,
 * extension recommendations someone added) kept as it was.
 */
export function renderWorkspaceFile(
  existing: Record<string, unknown> | undefined,
  folders: FolderSpec[],
  settings: Record<string, unknown>,
): string {
  const before = existing?.settings;
  const kept = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
  const doc = {
    ...existing,
    folders: folders.map((f) => ({ path: f.path, name: f.name })),
    settings: { ...kept, ...settings },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Brings this window's workspaceState over to a workspace it switched to.
 *
 * workspaceState is keyed by workspace identity, so a window that moves from
 * a folder or an untitled workspace to the named file starts from nothing —
 * the selected worktree, the one-time migrations already done. open() stashes
 * the lot in globalState under the file's path before switching; the first
 * activation in that workspace puts it back and drops the stash. A key the
 * workspace already has (it was opened before) is its own and wins.
 *
 * Run before anything reads workspaceState.
 */
export async function restoreStashedState(
  workspaceFile: { scheme: string; fsPath: string } | undefined,
  globalState: MementoLike,
  workspaceState: MementoLike,
): Promise<string[]> {
  if (workspaceFile?.scheme !== 'file') return [];
  const key = STATE_STASH_KEY + workspaceFile.fsPath;
  const stash = globalState.get<Record<string, unknown>>(key);
  if (!stash) return [];
  const restored: string[] = [];
  for (const [k, v] of Object.entries(stash)) {
    if (workspaceState.get(k) !== undefined) continue;
    await workspaceState.update(k, v);
    restored.push(k);
  }
  await globalState.update(key, undefined);
  return restored;
}

export class NamedWorkspace {
  constructor(private readonly deps: NamedWorkspaceDeps) {}

  fileFor(repoRoot: string): string {
    return namedWorkspacePath(this.deps.storageDir, repoRoot);
  }

  /**
   * A plain folder window: the next workspace-folder edit would turn it into
   * an untitled workspace. This is where Stack opens the named file instead.
   */
  isSingleFolder(): boolean {
    return this.deps.host.workspaceFile() === undefined;
  }

  isUntitled(): boolean {
    return this.deps.host.workspaceFile()?.scheme === 'untitled';
  }

  /**
   * Write (or update) the repository's named workspace with these folders and
   * the workspace-level settings in force now, then open it in this window.
   *
   * False when it could not be written or opened — the caller then does what
   * it did before this existed, and why is in the Stack output.
   */
  async open(repoRoot: string, folders: FolderSpec[]): Promise<boolean> {
    const { host } = this.deps;
    const file = this.fileFor(repoRoot);
    try {
      this.write(file, folders);
    } catch (e) {
      host.log(`could not write ${file}: ${String(e)} — staying with an untitled workspace`);
      return false;
    }
    const stashKey = STATE_STASH_KEY + file;
    await this.deps.globalState.update(stashKey, this.snapshotState());
    if (this.isUntitled()) {
      await host.setWorkspaceValue(CONFIRM_SAVE_UNTITLED, false).catch((e: unknown) => {
        host.log(`could not turn off ${CONFIRM_SAVE_UNTITLED} for the untitled workspace: ${String(e)}`);
      });
    }
    try {
      await host.openWorkspace(file);
    } catch (e) {
      host.log(`could not open ${file}: ${String(e)}`);
      await this.deps.globalState.update(stashKey, undefined);
      return false;
    }
    host.log(`opened ${file}`);
    return true;
  }

  /**
   * Once per repository, in a window that is already an untitled workspace:
   * offer to name it. The answer is remembered — "Not now", or the toast
   * closed unanswered, is not asked again; **Stack: Name This Workspace** is
   * there for later.
   */
  async offer(repoRoot: string | undefined): Promise<void> {
    if (!repoRoot || !this.isUntitled()) return;
    const key = NAMING_ASKED_KEY + canonicalPath(repoRoot);
    if (this.deps.globalState.get(key) !== undefined) return;
    // Before the toast: a window closed while it is up must not ask again.
    await this.deps.globalState.update(key, 'asked');
    const name = path.basename(canonicalPath(repoRoot));
    const pick = await this.deps.host.ask(
      `Name this window "${name}"? It reloads once; agents keep running in tmux.`,
      NAME_IT,
      NOT_NOW,
    );
    await this.deps.globalState.update(key, pick === NAME_IT ? 'named' : 'not-now');
    if (pick === NAME_IT) await this.nameNow(repoRoot);
  }

  /** The palette command, and "Name it": this window's folders into the named file, and switch. */
  async nameNow(repoRoot: string | undefined): Promise<void> {
    const { host } = this.deps;
    if (!repoRoot) {
      host.warn('Stack: open a git repository first.');
      return;
    }
    const current = host.workspaceFile();
    if (current?.scheme === 'file') {
      host.warn(`Stack: this window is already named after ${path.basename(current.fsPath)}.`);
      return;
    }
    if (!(await this.open(repoRoot, this.currentFolders(repoRoot)))) {
      host.warn('Stack: could not write the workspace file — see the Stack output.');
    }
  }

  /** The window's folders, the repository's own first. */
  private currentFolders(repoRoot: string): FolderSpec[] {
    const root = canonicalPath(repoRoot);
    const folders = this.deps.host.folders();
    return [
      ...folders.filter((f) => canonicalPath(f.path) === root),
      ...folders.filter((f) => canonicalPath(f.path) !== root),
    ];
  }

  /** Every workspace-level value of the carried settings, as it is set right now. */
  private carriedSettings(): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    for (const key of carriedSettingKeys()) {
      const value = this.deps.host.workspaceValue(key);
      if (value !== undefined) settings[key] = value;
    }
    return settings;
  }

  private snapshotState(): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const key of this.deps.workspaceState.keys()) {
      const value = this.deps.workspaceState.get(key);
      if (value !== undefined) state[key] = value;
    }
    return state;
  }

  /**
   * Reuses the file when there is one. A file Stack cannot parse (someone
   * added comments to it — VS Code reads JSONC) is left exactly as it is and
   * opened anyway: VS Code reads it fine, and Stack puts the right folders in
   * through the workspace API once the window is up.
   */
  private write(file: string, folders: FolderSpec[]): void {
    const { fs, host } = this.deps;
    let existing: Record<string, unknown> | undefined;
    // A read that fails throws to open(), like a write that fails.
    const text = fs.exists(file) ? fs.readFile(file) : undefined;
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        existing = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        host.log(`${file} is not plain JSON; opening it as it is`);
        return;
      }
    }
    fs.mkdir(path.dirname(file));
    fs.writeFile(file, renderWorkspaceFile(existing, folders, this.carriedSettings()));
  }
}

/** The live VS Code workspace and window, as a NamedWorkspaceHost. */
export function vscodeNamedWorkspaceHost(output: { appendLine(line: string): void }): NamedWorkspaceHost {
  return {
    workspaceFile: () => vscode.workspace.workspaceFile,
    folders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => ({ path: f.uri.fsPath, name: f.name })),
    workspaceValue: (key) => vscode.workspace.getConfiguration().inspect(key)?.workspaceValue,
    setWorkspaceValue: async (key, value) => {
      await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Workspace);
    },
    openWorkspace: async (file) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(file), { forceReuseWindow: true });
    },
    ask: (message, ...items) => Promise.resolve(vscode.window.showInformationMessage(message, ...items)),
    warn: (message) => void vscode.window.showWarningMessage(message),
    log: (message) => output.appendLine(`[stack] named workspace: ${message}`),
  };
}
