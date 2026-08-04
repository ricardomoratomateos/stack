import * as vscode from 'vscode';
import { fileURLToPath } from 'node:url';

/** View id of the drop-zone tree — must match the contribution in package.json. */
export const DROP_ZONE_VIEW_ID = 'unmess-drop-zone';

/** `text/uri-list` — how VS Code delivers path-based drops (Explorer, OS files with a path). */
const URI_LIST_MIME = 'text/uri-list';
/**
 * `files` — the special mime that opts a tree into receiving {@link vscode.DataTransferFile}
 * entries, which are only created for content dropped from OUTSIDE the editor (the OS).
 */
const FILES_MIME = 'files';

/** The only element the drop-zone tree ever renders. */
export type DropZoneElement = 'drop-here';

export interface DropZoneDeps {
  /** Display label of the worktree that will receive the drop, if any. */
  targetLabel(): string | undefined;
  /** Route dropped absolute file paths to the active worktree's agent. */
  attach(paths: string[]): Promise<void>;
  /**
   * Persist bytes for a dropped file that arrived without a filesystem path
   * (DataTransferFile.uri is optional). Returns the absolute path written.
   */
  saveTempFile(name: string, data: Uint8Array): Promise<string>;
  warn(message: string): void;
}

/**
 * Resolve a DataTransfer (from a tree-view drop) into absolute file paths.
 *
 * Order matters: `text/uri-list` carries the real path when the OS provided
 * one (this is what a macOS screenshot-thumbnail drop should produce once the
 * file promise materialises). The `files` entries are the fallback for drops
 * that only carry content — those get written to a temp file.
 */
export async function extractDroppedPaths(
  dataTransfer: vscode.DataTransfer,
  saveTempFile: (name: string, data: Uint8Array) => Promise<string>,
): Promise<string[]> {
  const uriList = dataTransfer.get(URI_LIST_MIME);
  if (uriList) {
    const paths: string[] = [];
    for (const line of (await uriList.asString()).split(/\r?\n/)) {
      const trimmed = line.trim();
      // uri-list comments start with '#'; only file: URIs map to local paths.
      if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('file:')) continue;
      try {
        paths.push(fileURLToPath(trimmed));
      } catch {
        // Malformed or non-local file URI — skip it.
      }
    }
    if (paths.length > 0) return paths;
  }

  // No path-based entries — fall back to DataTransferFile items (OS drops).
  const files: vscode.DataTransferFile[] = [];
  dataTransfer.forEach((item) => {
    const file = item.asFile?.();
    if (file) files.push(file);
  });
  const paths: string[] = [];
  for (const file of files) {
    if (file.uri) paths.push(file.uri.fsPath);
    else paths.push(await saveTempFile(file.name, await file.data()));
  }
  return paths;
}

/**
 * A one-row tree view that exists only to be a drop target for OS files
 * (macOS screenshot thumbnails in particular). Webview views never receive OS
 * drags (sandboxed iframe) and editor-area terminals let VS Code's editor
 * drop-target steal the file — a TreeView with a TreeDragAndDropController
 * declaring `text/uri-list` + `files` is the one sidebar surface the workbench
 * routes external file drops to.
 */
export class ScreenshotDropZone
implements vscode.TreeDataProvider<DropZoneElement>, vscode.TreeDragAndDropController<DropZoneElement> {
  readonly dropMimeTypes = [URI_LIST_MIME, FILES_MIME];
  readonly dragMimeTypes: string[] = [];

  private changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly deps: DropZoneDeps) {}

  getTreeItem(_element: DropZoneElement): vscode.TreeItem {
    const label = this.deps.targetLabel();
    const item = new vscode.TreeItem('Drop screenshot here', vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('device-camera');
    item.description = label ? `→ ${label}` : '— no active worktree';
    item.tooltip =
      'Drag an image here (e.g. the macOS screenshot thumbnail) to paste its path into the active worktree’s agent';
    return item;
  }

  getChildren(element?: DropZoneElement): DropZoneElement[] {
    return element ? [] : ['drop-here'];
  }

  /** Re-render the row (the “→ target” hint follows the active worktree). */
  refresh(): void {
    this.changeEmitter.fire();
  }

  async handleDrop(_target: DropZoneElement | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const paths = await extractDroppedPaths(dataTransfer, this.deps.saveTempFile);
    if (paths.length === 0) {
      this.deps.warn('Unmess: that drop did not contain a usable file.');
      return;
    }
    await this.deps.attach(paths);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
