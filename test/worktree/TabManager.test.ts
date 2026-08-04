import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { window, Uri, TabInputText, FakeMemento, resetVscodeMock } from '../__mocks__/vscode';
import { TabManager, findOwner } from '../../src/worktree/TabManager';

const STORE_KEY = 'unmess.tabs';

interface WorktreeRef { id: string; path: string }

const wtA: WorktreeRef = { id: 'a', path: '/wt/a' };
const wtB: WorktreeRef = { id: 'b', path: '/wt/b' };
const wtNested: WorktreeRef = { id: 'n', path: '/wt/a/nested' };

function fileTab(p: string) {
  return { input: new TabInputText(Uri.file(p)) };
}

function setOpenTabs(...paths: string[]): void {
  window.tabGroups.all = [{ tabs: paths.map(fileTab) }];
}

/** Construct a TabManager and capture the listeners it registers on the mock. */
function build(memento: FakeMemento, worktrees: () => WorktreeRef[]) {
  const manager = new TabManager(memento as never, worktrees);
  const tabsChanged = window.tabGroups.onDidChangeTabs.mock.calls[0][0] as () => void;
  const activeEditorChanged = window.onDidChangeActiveTextEditor.mock.calls[0][0] as () => void;
  return { manager, tabsChanged, activeEditorChanged };
}

function savedState(memento: FakeMemento) {
  return memento.get<Record<string, { uris: string[]; active?: string; hadViewer?: boolean }>>(STORE_KEY, {});
}

beforeEach(() => {
  resetVscodeMock();
});

// ── findOwner (pure function) ────────────────────────────────────────────────

describe('findOwner', () => {
  it('returns the worktree whose path is a prefix of the file path', () => {
    expect(findOwner('/wt/a/src/file.ts', [wtA, wtB])).toBe(wtA);
    expect(findOwner('/wt/b/other.ts', [wtA, wtB])).toBe(wtB);
  });

  it('returns the longest matching prefix when paths nest', () => {
    expect(findOwner('/wt/a/nested/deep/file.ts', [wtA, wtNested])).toBe(wtNested);
    // order-independent
    expect(findOwner('/wt/a/nested/deep/file.ts', [wtNested, wtA])).toBe(wtNested);
    // file outside the nested worktree still resolves to the outer one
    expect(findOwner('/wt/a/file.ts', [wtA, wtNested])).toBe(wtA);
  });

  it('handles worktree paths with and without trailing slash', () => {
    const slashed: WorktreeRef = { id: 's', path: '/wt/s/' };
    expect(findOwner('/wt/s/file.ts', [slashed])).toBe(slashed);
    expect(findOwner('/wt/a/file.ts', [wtA])).toBe(wtA);
    // exact path equality also matches (path without trailing slash)
    expect(findOwner('/wt/a', [wtA])).toBe(wtA);
  });

  it('returns undefined when no worktree matches', () => {
    expect(findOwner('/elsewhere/file.ts', [wtA, wtB])).toBeUndefined();
    expect(findOwner('/wt/c/file.ts', [wtA, wtB])).toBeUndefined();
    expect(findOwner('/x', [])).toBeUndefined();
    // slash normalization: /wt/ab is NOT owned by /wt/a
    expect(findOwner('/wt/ab/file.ts', [wtA])).toBeUndefined();
  });
});

// ── liveSnapshot (via listeners registered in the constructor) ──────────────

describe('liveSnapshot', () => {
  let memento: FakeMemento;

  beforeEach(() => {
    memento = new FakeMemento();
  });

  it('groups open file tabs by owning worktree, preserving tab order', () => {
    const { tabsChanged } = build(memento, () => [wtA, wtB]);
    setOpenTabs('/wt/a/1.ts', '/wt/b/2.ts', '/wt/a/3.ts');
    tabsChanged();
    const saved = savedState(memento);
    expect(saved['a'].uris).toEqual(['/wt/a/1.ts', '/wt/a/3.ts']);
    expect(saved['b'].uris).toEqual(['/wt/b/2.ts']);
  });

  it('does not wipe saved state for worktrees with no current tabs', async () => {
    await memento.update(STORE_KEY, { a: { uris: ['/wt/a/old.ts'], active: '/wt/a/old.ts', hadViewer: true } });
    const { tabsChanged } = build(memento, () => [wtA, wtB]);
    setOpenTabs('/wt/b/2.ts'); // worktree a has zero open tabs
    tabsChanged();
    const saved = savedState(memento);
    expect(saved['a']).toEqual({ uris: ['/wt/a/old.ts'], active: '/wt/a/old.ts', hadViewer: true });
    expect(saved['b'].uris).toEqual(['/wt/b/2.ts']);
  });

  it('does nothing when closingProgrammatically > 0', async () => {
    vi.useFakeTimers();
    try {
      const { manager, tabsChanged } = build(memento, () => [wtA, wtB]);
      setOpenTabs('/wt/a/1.ts', '/wt/b/2.ts');
      await manager.closeOtherTabs('a', [wtA, wtB]); // bumps the counter
      setOpenTabs('/wt/a/1.ts');
      tabsChanged();
      expect(savedState(memento)['a']).toBeUndefined(); // suppressed

      vi.advanceTimersByTime(50); // counter decremented
      tabsChanged();
      expect(savedState(memento)['a'].uris).toEqual(['/wt/a/1.ts']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when worktree list is empty', () => {
    const { tabsChanged } = build(memento, () => []);
    setOpenTabs('/wt/a/1.ts');
    tabsChanged();
    expect(memento.get(STORE_KEY)).toBeUndefined(); // persist never ran
  });

  it('only tracks file-scheme text tabs (ignores diffs, webviews, untitled)', () => {
    const { tabsChanged } = build(memento, () => [wtA]);
    window.tabGroups.all = [{
      tabs: [
        fileTab('/wt/a/kept.ts'),
        { input: { original: Uri.file('/wt/a/diff.ts') } },          // not TabInputText (diff/webview)
        { input: new TabInputText(new Uri('untitled', '/wt/a/u')) }, // non-file scheme
        { input: undefined },                                        // no input at all
      ],
    }];
    tabsChanged();
    expect(savedState(memento)['a'].uris).toEqual(['/wt/a/kept.ts']);
  });

  it('updates active tab only for the worktree owning the active editor', () => {
    const { tabsChanged } = build(memento, () => [wtA, wtB]);
    setOpenTabs('/wt/a/1.ts', '/wt/b/2.ts');
    window.activeTextEditor = { document: { uri: Uri.file('/wt/a/1.ts') } };
    tabsChanged();
    const saved = savedState(memento);
    expect(saved['a'].active).toBe('/wt/a/1.ts');
    expect(saved['b'].active).toBeUndefined();
  });

  it('preserves previous active when active editor belongs to another worktree', async () => {
    await memento.update(STORE_KEY, { b: { uris: ['/wt/b/2.ts'], active: '/wt/b/prev.ts' } });
    const { tabsChanged } = build(memento, () => [wtA, wtB]);
    setOpenTabs('/wt/a/1.ts', '/wt/b/2.ts');
    window.activeTextEditor = { document: { uri: Uri.file('/wt/a/1.ts') } };
    tabsChanged();
    const saved = savedState(memento);
    expect(saved['b'].active).toBe('/wt/b/prev.ts');
    expect(saved['a'].active).toBe('/wt/a/1.ts');
  });

  it('persists to unmess.tabs on every snapshot', () => {
    const { tabsChanged, activeEditorChanged } = build(memento, () => [wtA]);
    setOpenTabs('/wt/a/1.ts');
    tabsChanged();
    expect(savedState(memento)['a'].uris).toEqual(['/wt/a/1.ts']);

    setOpenTabs('/wt/a/1.ts', '/wt/a/2.ts');
    activeEditorChanged(); // the editor-change listener snapshots too
    expect(savedState(memento)['a'].uris).toEqual(['/wt/a/1.ts', '/wt/a/2.ts']);
  });

  it('skips open tabs that belong to no worktree', () => {
    const { tabsChanged } = build(memento, () => [wtA]);
    setOpenTabs('/elsewhere/orphan.ts', '/wt/a/1.ts');
    tabsChanged();
    const saved = savedState(memento);
    expect(saved['a'].uris).toEqual(['/wt/a/1.ts']);
    expect(Object.keys(saved)).toEqual(['a']); // orphan created no entry
  });

  it('suppresses active-editor snapshots too while closingProgrammatically > 0', async () => {
    vi.useFakeTimers();
    try {
      const { manager, activeEditorChanged } = build(memento, () => [wtA, wtB]);
      setOpenTabs('/wt/a/1.ts', '/wt/b/2.ts');
      await manager.closeOtherTabs('a', [wtA, wtB]); // bumps the counter
      setOpenTabs('/wt/a/1.ts');
      activeEditorChanged();
      expect(savedState(memento)['a']).toBeUndefined(); // suppressed

      vi.advanceTimersByTime(50); // counter decremented
      activeEditorChanged();
      expect(savedState(memento)['a'].uris).toEqual(['/wt/a/1.ts']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves hadViewer across snapshots', async () => {
    await memento.update(STORE_KEY, { a: { uris: [], hadViewer: true } });
    const { tabsChanged } = build(memento, () => [wtA]);
    setOpenTabs('/wt/a/1.ts');
    tabsChanged();
    expect(savedState(memento)['a'].hadViewer).toBe(true);
  });
});

// ── closeOtherTabs ───────────────────────────────────────────────────────────

describe('closeOtherTabs', () => {
  let memento: FakeMemento;

  beforeEach(() => {
    memento = new FakeMemento();
  });

  it('closes tabs belonging to other worktrees', async () => {
    const { manager } = build(memento, () => [wtA, wtB]);
    const keep = fileTab('/wt/a/1.ts');
    const close1 = fileTab('/wt/b/2.ts');
    const close2 = fileTab('/wt/b/3.ts');
    window.tabGroups.all = [{ tabs: [keep, close1, close2] }];
    await manager.closeOtherTabs('a', [wtA, wtB]);
    expect(window.tabGroups.close).toHaveBeenCalledTimes(1);
    expect(window.tabGroups.close).toHaveBeenCalledWith([close1, close2]);
  });

  it('skips tabs with no owning worktree', async () => {
    const { manager } = build(memento, () => [wtA, wtB]);
    const orphan = fileTab('/elsewhere/x.ts');
    const other = fileTab('/wt/b/2.ts');
    window.tabGroups.all = [{ tabs: [orphan, other] }];
    await manager.closeOtherTabs('a', [wtA, wtB]);
    expect(window.tabGroups.close).toHaveBeenCalledWith([other]);
  });

  it('no-ops (no counter bump) when nothing to close', async () => {
    const { manager, tabsChanged } = build(memento, () => [wtA, wtB]);
    setOpenTabs('/wt/a/1.ts');
    await manager.closeOtherTabs('a', [wtA, wtB]);
    expect(window.tabGroups.close).not.toHaveBeenCalled();
    // counter was never bumped: a snapshot right after is NOT suppressed
    tabsChanged();
    expect(savedState(memento)['a'].uris).toEqual(['/wt/a/1.ts']);
  });

  it('increments closingProgrammatically during close, decrements ~50ms after', async () => {
    vi.useFakeTimers();
    try {
      const { manager, tabsChanged } = build(memento, () => [wtA, wtB]);
      setOpenTabs('/wt/a/1.ts', '/wt/b/2.ts');
      await manager.closeOtherTabs('a', [wtA, wtB]);

      // trailing tab events within 50ms are suppressed
      setOpenTabs('/wt/a/1.ts');
      tabsChanged();
      expect(savedState(memento)['a']).toBeUndefined();

      vi.advanceTimersByTime(49);
      tabsChanged();
      expect(savedState(memento)['a']).toBeUndefined();

      vi.advanceTimersByTime(1); // 50ms total → decrement fires
      tabsChanged();
      expect(savedState(memento)['a'].uris).toEqual(['/wt/a/1.ts']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('decrements the counter even when tabGroups.close rejects', async () => {
    vi.useFakeTimers();
    try {
      const { manager, tabsChanged } = build(memento, () => [wtA, wtB]);
      setOpenTabs('/wt/a/1.ts', '/wt/b/2.ts');
      window.tabGroups.close.mockRejectedValueOnce(new Error('boom'));
      await expect(manager.closeOtherTabs('a', [wtA, wtB])).rejects.toThrow('boom');
      vi.advanceTimersByTime(50);
      setOpenTabs('/wt/a/1.ts');
      tabsChanged();
      expect(savedState(memento)['a'].uris).toEqual(['/wt/a/1.ts']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── restoreTabs (real temp files for fs.existsSync) ─────────────────────────

describe('restoreTabs', () => {
  let memento: FakeMemento;
  let tmpDir: string;
  let fileOne: string;
  let fileTwo: string;
  let missing: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmess-tabs-'));
    fileOne = path.join(tmpDir, 'one.ts');
    fileTwo = path.join(tmpDir, 'two.ts');
    missing = path.join(tmpDir, 'gone.ts');
    fs.writeFileSync(fileOne, 'one');
    fs.writeFileSync(fileTwo, 'two');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    memento = new FakeMemento();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no-ops when no saved state', async () => {
    const { manager } = build(memento, () => [wtA]);
    await manager.restoreTabs('a');
    expect(window.tabGroups.close).not.toHaveBeenCalled();
    expect(window.showTextDocument).not.toHaveBeenCalled();
  });

  it('no-ops when saved uris are empty', async () => {
    await memento.update(STORE_KEY, { a: { uris: [] } });
    const { manager } = build(memento, () => [wtA]);
    await manager.restoreTabs('a');
    expect(window.tabGroups.close).not.toHaveBeenCalled();
    expect(window.showTextDocument).not.toHaveBeenCalled();
  });

  it('closes all currently open file tabs first', async () => {
    await memento.update(STORE_KEY, { a: { uris: [fileOne] } });
    const { manager } = build(memento, () => [wtA]);
    const openA = fileTab('/wt/a/x.ts');
    const openB = fileTab('/wt/b/y.ts');
    window.tabGroups.all = [{ tabs: [openA, openB] }];
    await manager.restoreTabs('a');
    expect(window.tabGroups.close).toHaveBeenCalledWith([openA, openB]);
    // close happened BEFORE any document was shown
    expect(window.tabGroups.close.mock.invocationCallOrder[0])
      .toBeLessThan(window.showTextDocument.mock.invocationCallOrder[0]);
  });

  it('skips the close step when no file tabs are open', async () => {
    await memento.update(STORE_KEY, { a: { uris: [fileOne] } });
    const { manager } = build(memento, () => [wtA]);
    await manager.restoreTabs('a');
    expect(window.tabGroups.close).not.toHaveBeenCalled();
    expect(window.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it('reopens uris sequentially in saved order with preview:false and preserveFocus:FALSE', async () => {
    await memento.update(STORE_KEY, { a: { uris: [fileTwo, fileOne] } });
    const { manager } = build(memento, () => [wtA]);
    await manager.restoreTabs('a');
    expect(window.showTextDocument).toHaveBeenCalledTimes(2);
    expect(window.showTextDocument.mock.calls[0][0].fsPath).toBe(fileTwo);
    expect(window.showTextDocument.mock.calls[1][0].fsPath).toBe(fileOne);
    // preserveFocus MUST be false: openPositioning defaults to "right", so the
    // insertion point only walks forward if each opened tab becomes active.
    // With true, every tab lands beside the first one and the order reverses.
    for (const call of window.showTextDocument.mock.calls) {
      expect(call[1]).toEqual({ preview: false, preserveFocus: false });
    }
  });

  it('re-focuses the saved active tab last, after the whole order is laid out', async () => {
    await memento.update(STORE_KEY, { a: { uris: [fileTwo, fileOne], active: fileTwo } });
    const { manager } = build(memento, () => [wtA]);
    await manager.restoreTabs('a');
    expect(window.showTextDocument).toHaveBeenCalledTimes(3);
    expect(window.showTextDocument.mock.calls.map(c => c[0].fsPath))
      .toEqual([fileTwo, fileOne, fileTwo]);
  });

  it('does not re-focus an active tab that was filtered out (file gone)', async () => {
    await memento.update(STORE_KEY, { a: { uris: [missing, fileOne], active: missing } });
    const { manager } = build(memento, () => [wtA]);
    await manager.restoreTabs('a');
    expect(window.showTextDocument).toHaveBeenCalledTimes(1);
    expect(window.showTextDocument.mock.calls[0][0].fsPath).toBe(fileOne);
  });

  it('swallows a failure re-focusing the active tab', async () => {
    await memento.update(STORE_KEY, { a: { uris: [fileOne], active: fileOne } });
    const { manager } = build(memento, () => [wtA]);
    window.showTextDocument
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('unreadable'));
    await expect(manager.restoreTabs('a')).resolves.toBeUndefined();
    expect(window.showTextDocument).toHaveBeenCalledTimes(2);
  });

  it('filters out uris whose file no longer exists', async () => {
    await memento.update(STORE_KEY, { a: { uris: [missing, fileOne] } });
    const { manager } = build(memento, () => [wtA]);
    await manager.restoreTabs('a');
    expect(window.showTextDocument).toHaveBeenCalledTimes(1);
    expect(window.showTextDocument.mock.calls[0][0].fsPath).toBe(fileOne);
  });

  it('returns early when no saved uri exists on disk anymore', async () => {
    await memento.update(STORE_KEY, { a: { uris: [missing] } });
    const { manager } = build(memento, () => [wtA]);
    await manager.restoreTabs('a');
    expect(window.showTextDocument).not.toHaveBeenCalled();
  });

  it('skips unreadable files without aborting the rest', async () => {
    await memento.update(STORE_KEY, { a: { uris: [fileOne, fileTwo] } });
    const { manager } = build(memento, () => [wtA]);
    window.showTextDocument.mockRejectedValueOnce(new Error('unreadable'));
    await expect(manager.restoreTabs('a')).resolves.toBeUndefined();
    expect(window.showTextDocument).toHaveBeenCalledTimes(2);
    expect(window.showTextDocument.mock.calls[1][0].fsPath).toBe(fileTwo);
  });

  it('suppresses liveSnapshot during the whole operation (until 50ms after)', async () => {
    vi.useFakeTimers();
    const tmpWt: WorktreeRef = { id: 'a', path: tmpDir };
    await memento.update(STORE_KEY, { a: { uris: [fileOne, fileTwo] } });
    const { manager, tabsChanged } = build(memento, () => [tmpWt]);
    // only fileOne open right now — an unsuppressed snapshot would shrink
    // saved uris to [fileOne]
    setOpenTabs(fileOne);

    // VSCode fires tab events for every close/open mid-restore — simulate them
    window.tabGroups.close.mockImplementation(async () => { tabsChanged(); return true; });
    window.showTextDocument.mockImplementation(async () => { tabsChanged(); });

    await manager.restoreTabs('a');
    tabsChanged(); // trailing event right after the operation
    expect(savedState(memento)['a'].uris).toEqual([fileOne, fileTwo]); // untouched

    vi.advanceTimersByTime(50); // both counters (close + open) decrement
    setOpenTabs(fileTwo);
    tabsChanged(); // suppression window over → snapshot resumes
    expect(savedState(memento)['a'].uris).toEqual([fileTwo]);

    // restore default impls replaced above (clearAllMocks does not)
    window.tabGroups.close.mockResolvedValue(true);
    window.showTextDocument.mockResolvedValue(undefined);
  });
});

// ── updateViewerState ────────────────────────────────────────────────────────

describe('updateViewerState', () => {
  let memento: FakeMemento;

  beforeEach(() => {
    memento = new FakeMemento();
  });

  it('sets hadViewer=true for worktrees with an open viewer', async () => {
    await memento.update(STORE_KEY, { a: { uris: ['/wt/a/1.ts'] } });
    const { manager } = build(memento, () => [wtA, wtB]);
    manager.updateViewerState([wtA, wtB], new Set(['a']));
    expect(savedState(memento)['a'].hadViewer).toBe(true);
  });

  it('sets hadViewer=false for the rest, preserving their uris/active', async () => {
    await memento.update(STORE_KEY, {
      b: { uris: ['/wt/b/2.ts'], active: '/wt/b/2.ts', hadViewer: true },
    });
    const { manager } = build(memento, () => [wtA, wtB]);
    manager.updateViewerState([wtA, wtB], new Set(['a']));
    const saved = savedState(memento);
    expect(saved['b']).toEqual({ uris: ['/wt/b/2.ts'], active: '/wt/b/2.ts', hadViewer: false });
    // worktree with no prior state gets a fresh entry
    expect(saved['a']).toEqual({ uris: [], hadViewer: true });
  });

  it('persists after updating', () => {
    const { manager } = build(memento, () => [wtA]);
    expect(memento.get(STORE_KEY)).toBeUndefined();
    manager.updateViewerState([wtA], new Set());
    expect(savedState(memento)['a']).toEqual({ uris: [], hadViewer: false });
  });
});

// ── constructor ──────────────────────────────────────────────────────────────

describe('constructor', () => {
  it('hydrates saved state from unmess.tabs on startup', async () => {
    const memento = new FakeMemento();
    await memento.update(STORE_KEY, {
      a: { uris: ['/wt/a/1.ts'], active: '/wt/a/1.ts', hadViewer: true },
      b: { uris: [] },
    });
    const { manager } = build(memento, () => [wtA, wtB]);
    expect(manager.getState('a')).toEqual({ uris: ['/wt/a/1.ts'], active: '/wt/a/1.ts', hadViewer: true });
    expect(manager.getState('b')).toEqual({ uris: [] });
    expect(manager.getState('unknown')).toBeUndefined();
  });

  it('registers tab and active-editor listeners', () => {
    build(new FakeMemento(), () => []);
    expect(window.tabGroups.onDidChangeTabs).toHaveBeenCalledTimes(1);
    expect(window.onDidChangeActiveTextEditor).toHaveBeenCalledTimes(1);
  });
});
