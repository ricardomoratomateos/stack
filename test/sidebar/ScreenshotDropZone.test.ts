import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ScreenshotDropZone,
  extractDroppedPaths,
  DROP_ZONE_VIEW_ID,
  type DropZoneDeps,
} from '../../src/sidebar/ScreenshotDropZone';
import { Uri, resetVscodeMock } from '../__mocks__/vscode';
import type * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

interface FakeItem {
  asString?: () => Promise<string>;
  asFile?: () => unknown;
}

/** Structural stand-in for vscode.DataTransfer (get + forEach are all we use). */
function makeTransfer(entries: Record<string, FakeItem>): vscode.DataTransfer {
  return {
    get: (mime: string) => entries[mime],
    forEach: (cb: (item: FakeItem, mime: string) => void) => {
      for (const [mime, item] of Object.entries(entries)) cb(item, mime);
    },
  } as unknown as vscode.DataTransfer;
}

function uriListItem(text: string): FakeItem {
  return { asString: async () => text };
}

function makeDeps(over: Partial<DropZoneDeps> = {}): DropZoneDeps & {
  attach: ReturnType<typeof vi.fn>;
  saveTempFile: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return {
    targetLabel: () => 'feat/x',
    attach: vi.fn(async () => {}),
    saveTempFile: vi.fn(async (name: string) => `/tmp/saved/${name}`),
    warn: vi.fn(),
    ...over,
  } as DropZoneDeps & {
    attach: ReturnType<typeof vi.fn>;
    saveTempFile: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  resetVscodeMock();
});

// ─────────────────────────────────────────────────────────────────────────────
// extractDroppedPaths
// ─────────────────────────────────────────────────────────────────────────────

describe('extractDroppedPaths', () => {
  const noTemp = async () => {
    throw new Error('saveTempFile must not be called');
  };

  it('decodes file: URIs from text/uri-list (screenshot names contain spaces)', async () => {
    const dt = makeTransfer({
      'text/uri-list': uriListItem(
        'file:///var/folders/T/NSIRD_screencaptureui/Captura%20de%20pantalla.png\r\nfile:///tmp/two.png',
      ),
    });
    await expect(extractDroppedPaths(dt, noTemp)).resolves.toEqual([
      '/var/folders/T/NSIRD_screencaptureui/Captura de pantalla.png',
      '/tmp/two.png',
    ]);
  });

  it('skips blank lines, comments, non-file URIs and malformed file URIs', async () => {
    const dt = makeTransfer({
      'text/uri-list': uriListItem(
        '\n# a uri-list comment\nhttps://example.com/x.png\nfile://not-localhost/x.png\nfile:///ok.png',
      ),
    });
    await expect(extractDroppedPaths(dt, noTemp)).resolves.toEqual(['/ok.png']);
  });

  it('falls through to file entries when the uri-list has no usable line', async () => {
    const dt = makeTransfer({
      'text/uri-list': uriListItem('https://example.com/remote.png'),
      files: { asFile: () => ({ name: 'shot.png', uri: Uri.file('/drops/shot.png') }) },
    });
    await expect(extractDroppedPaths(dt, noTemp)).resolves.toEqual(['/drops/shot.png']);
  });

  it('uses DataTransferFile.uri when there is no uri-list at all', async () => {
    const dt = makeTransfer({
      files: { asFile: () => ({ name: 'shot.png', uri: Uri.file('/drops/shot.png') }) },
    });
    await expect(extractDroppedPaths(dt, noTemp)).resolves.toEqual(['/drops/shot.png']);
  });

  it('persists pathless files via saveTempFile (promised files without a uri)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const save = vi.fn(async (name: string) => `/tmp/unmess-drop/${name}`);
    const dt = makeTransfer({
      files: { asFile: () => ({ name: 'shot.png', uri: undefined, data: async () => bytes }) },
    });
    await expect(extractDroppedPaths(dt, save)).resolves.toEqual(['/tmp/unmess-drop/shot.png']);
    expect(save).toHaveBeenCalledWith('shot.png', bytes);
  });

  it('ignores items that are not files and returns [] for an empty transfer', async () => {
    const dt = makeTransfer({
      'text/plain': {}, // no asFile method at all
      'application/vnd.code.tree.other': { asFile: () => undefined },
    });
    await expect(extractDroppedPaths(dt, noTemp)).resolves.toEqual([]);
    await expect(extractDroppedPaths(makeTransfer({}), noTemp)).resolves.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ScreenshotDropZone
// ─────────────────────────────────────────────────────────────────────────────

describe('ScreenshotDropZone', () => {
  it('exposes the view id the package.json contribution must use', () => {
    expect(DROP_ZONE_VIEW_ID).toBe('unmess-drop-zone');
  });

  it('declares text/uri-list and files as accepted drop mimes, and drags nothing', () => {
    const zone = new ScreenshotDropZone(makeDeps());
    expect(zone.dropMimeTypes).toEqual(['text/uri-list', 'files']);
    expect(zone.dragMimeTypes).toEqual([]);
  });

  it('renders a single root row and no children below it', () => {
    const zone = new ScreenshotDropZone(makeDeps());
    expect(zone.getChildren()).toEqual(['drop-here']);
    expect(zone.getChildren('drop-here')).toEqual([]);
  });

  it('shows the active worktree as the drop target', () => {
    const zone = new ScreenshotDropZone(makeDeps({ targetLabel: () => 'feat/login' }));
    const item = zone.getTreeItem('drop-here');
    expect(item.label).toBe('Drop screenshot here');
    expect(item.description).toBe('→ feat/login');
    expect((item.iconPath as { id: string }).id).toBe('device-camera');
  });

  it('signals when there is no active worktree to receive the drop', () => {
    const zone = new ScreenshotDropZone(makeDeps({ targetLabel: () => undefined }));
    expect(zone.getTreeItem('drop-here').description).toBe('— no active worktree');
  });

  it('refresh() fires onDidChangeTreeData and dispose() stops it', () => {
    const zone = new ScreenshotDropZone(makeDeps());
    const listener = vi.fn();
    zone.onDidChangeTreeData(listener);
    zone.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    zone.dispose();
    zone.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('routes dropped paths to attach()', async () => {
    const deps = makeDeps();
    const zone = new ScreenshotDropZone(deps);
    await zone.handleDrop(
      'drop-here',
      makeTransfer({ 'text/uri-list': uriListItem('file:///shots/a%20b.png') }),
    );
    expect(deps.attach).toHaveBeenCalledWith(['/shots/a b.png']);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('warns instead of attaching when the drop carries nothing usable', async () => {
    const deps = makeDeps();
    const zone = new ScreenshotDropZone(deps);
    await zone.handleDrop(undefined, makeTransfer({}));
    expect(deps.warn).toHaveBeenCalledWith('Unmess: that drop did not contain a usable file.');
    expect(deps.attach).not.toHaveBeenCalled();
  });
});
