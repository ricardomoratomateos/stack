import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, commands, Uri, TabInputCustom, TabInputTerminal, TabInputText, resetVscodeMock } from '../__mocks__/vscode';
import { ImageDropCatcher, type ImageDropDeps } from '../../src/terminal/ImageDropCatcher';

type Tab = { label: string; input: unknown; isActive: boolean; group: Group };
type Group = { viewColumn: number; tabs: Tab[]; activeTab?: Tab };

function group(viewColumn: number, tabs: Array<{ label: string; input: unknown; active?: boolean }>): Group {
  const g: Group = { viewColumn, tabs: [] };
  g.tabs = tabs.map((t) => ({ label: t.label, input: t.input, isActive: !!t.active, group: g }));
  g.activeTab = g.tabs.find((t) => t.isActive);
  return g;
}
const terminal = (label: string, active = false) => ({ label, input: new TabInputTerminal(), active });
const image = (file: string, active = true) => ({ label: file.split('/').pop()!, input: new TabInputCustom(Uri.file(file), 'imagePreview.previewEditor'), active });

function makeDeps(over: Partial<ImageDropDeps> = {}): ImageDropDeps {
  return {
    worktreeIdForTerminalName: vi.fn((name) => ({ 'claude: develop': 'wt-dev', 'claude: feat/x': 'wt-x' } as Record<string, string>)[name]),
    hasTerminals: vi.fn(() => true),
    labelFor: vi.fn((id) => ({ 'wt-dev': 'develop', 'wt-x': 'feat/x' } as Record<string, string>)[id]),
    activeWorktreeId: vi.fn(() => 'wt-dev'),
    isScreenshotLike: vi.fn(() => true),
    attach: vi.fn(async () => {}),
    notify: vi.fn(),
    ...over,
  };
}

/** Installs the catcher and returns a way to fire tab events with the given groups as the workbench state. */
function install(deps: ImageDropDeps, initialGroups: Group[] = []) {
  let handler: ((e: { opened: Tab[]; closed: Tab[]; changed: Tab[] }) => void) | undefined;
  window.tabGroups.onDidChangeTabs.mockImplementation((h: typeof handler) => { handler = h; return { dispose: vi.fn() }; });
  window.tabGroups.all = initialGroups as never;
  const catcher = new ImageDropCatcher(deps);
  return {
    catcher,
    async open(groups: Group[], opened: Tab[]) {
      window.tabGroups.all = groups as never;
      await handler!({ opened, closed: [], changed: [] });
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

beforeEach(() => { resetVscodeMock(); });

describe('ImageDropCatcher', () => {
  it('closes the image tab and attaches the file to the agent whose viewer shares the group', async () => {
    const deps = makeDeps();
    const h = install(deps);
    const g = group(2, [terminal('claude: feat/x'), image('/Users/me/Desktop/shot.png')]);
    await h.open([g], [g.tabs[1]]);

    expect(window.tabGroups.close).toHaveBeenCalledWith(g.tabs[1], true);
    expect(deps.attach).toHaveBeenCalledWith('wt-x', ['/Users/me/Desktop/shot.png']);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('shot.png to feat/x'), expect.any(Function));
  });

  it('with several viewers in the group, targets the one that was active before the image opened', async () => {
    const deps = makeDeps();
    // Before the drop: feat/x is the active tab of group 1.
    const before = group(1, [terminal('claude: develop'), terminal('claude: feat/x', true)]);
    const h = install(deps, [before]);
    const after = group(1, [terminal('claude: develop'), terminal('claude: feat/x'), image('/tmp/s.png')]);
    await h.open([after], [after.tabs[2]]);
    expect(deps.attach).toHaveBeenCalledWith('wt-x', ['/tmp/s.png']);
  });

  it('falls back to the active worktree when the group has no agent viewer', async () => {
    const deps = makeDeps();
    const h = install(deps);
    const g = group(1, [{ label: 'README.md', input: new TabInputText(Uri.file('/repo/README.md')) }, image('/tmp/s.png')]);
    await h.open([g], [g.tabs[1]]);
    expect(deps.attach).toHaveBeenCalledWith('wt-dev', ['/tmp/s.png']);
  });

  it('leaves the tab alone when nobody can take the file (no agent sessions)', async () => {
    const deps = makeDeps({ hasTerminals: vi.fn(() => false) });
    const h = install(deps);
    const g = group(1, [terminal('claude: develop'), image('/tmp/s.png')]);
    await h.open([g], [g.tabs[1]]);
    expect(window.tabGroups.close).not.toHaveBeenCalled();
    expect(deps.attach).not.toHaveBeenCalled();
  });

  it('leaves an image that was opened on purpose alone', async () => {
    const deps = makeDeps({ isScreenshotLike: vi.fn(() => false) });
    const h = install(deps);
    const g = group(1, [terminal('claude: develop'), image('/repo/docs/logo.png')]);
    await h.open([g], [g.tabs[1]]);
    expect(window.tabGroups.close).not.toHaveBeenCalled();
    expect(deps.attach).not.toHaveBeenCalled();
  });

  it('ignores tabs that are not local image files', async () => {
    const deps = makeDeps();
    const h = install(deps);
    const g = group(1, [terminal('claude: develop'), { label: 'notes.md', input: new TabInputText(Uri.file('/repo/notes.md')), active: true }]);
    await h.open([g], [g.tabs[1]]);
    expect(deps.attach).not.toHaveBeenCalled();
  });

  it('"Open instead" reopens the image, and that reopen is not caught again', async () => {
    const deps = makeDeps();
    const h = install(deps);
    const g = group(1, [terminal('claude: develop'), image('/tmp/s.png')]);
    await h.open([g], [g.tabs[1]]);
    const reopen = (deps.notify as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
    reopen();
    expect(commands.executeCommand).toHaveBeenCalledWith('vscode.open', expect.objectContaining({ fsPath: '/tmp/s.png' }));

    // The reopened tab lands in the same group, beside the same agent…
    const again = group(1, [terminal('claude: develop'), image('/tmp/s.png')]);
    await h.open([again], [again.tabs[1]]);
    expect(deps.attach).toHaveBeenCalledTimes(1);
    expect(window.tabGroups.close).toHaveBeenCalledTimes(1);

    // …but a later, genuine drop of the same file is caught as usual.
    const later = group(1, [terminal('claude: develop'), image('/tmp/s.png')]);
    await h.open([later], [later.tabs[1]]);
    expect(deps.attach).toHaveBeenCalledTimes(2);
  });

  it('names the agent generically when the worktree has no label', async () => {
    const deps = makeDeps({ labelFor: vi.fn(() => undefined) });
    const h = install(deps);
    const g = group(2, [terminal('claude: feat/x'), image('/Users/me/Desktop/shot.png')]);
    await h.open([g], [g.tabs[1]]);

    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('shot.png to the agent'), expect.any(Function));
  });

  it('opens an image the user opens as a text tab too', async () => {
    // Some image types open through TabInputText rather than the custom preview
    // editor; the drop is the same drop.
    const deps = makeDeps();
    const h = install(deps);
    const g = group(2, [
      terminal('claude: feat/x'),
      { label: 'shot.png', input: new TabInputText(Uri.file('/Users/me/Desktop/shot.png')), active: true },
    ]);
    await h.open([g], [g.tabs[1]]);

    expect(deps.attach).toHaveBeenCalledWith('wt-x', ['/Users/me/Desktop/shot.png']);
  });

  it('ignores a tab that is not backed by a file at all', async () => {
    const deps = makeDeps();
    const h = install(deps);
    const g = group(2, [terminal('claude: feat/x'), { label: 'Settings', input: { kind: 'webview' }, active: true }]);
    await h.open([g], [g.tabs[1]]);

    expect(window.tabGroups.close).not.toHaveBeenCalled();
    expect(deps.attach).not.toHaveBeenCalled();
  });

  it('survives a failure while handling one tab', async () => {
    // The handler runs inside VS Code's tab event; letting it throw would take
    // out the listener and silently stop catching every later drop.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      worktreeIdForTerminalName: vi.fn(() => { throw new Error('boom'); }),
    });
    const h = install(deps);
    const g = group(2, [terminal('claude: feat/x'), image('/Users/me/Desktop/shot.png')]);

    await expect(h.open([g], [g.tabs[1]])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[foreman] image drop failed', expect.any(Error));
    warn.mockRestore();
  });

  it('dispose unhooks the tab listener', () => {
    const dispose = vi.fn();
    window.tabGroups.onDidChangeTabs.mockReturnValue({ dispose });
    new ImageDropCatcher(makeDeps()).dispose();
    expect(dispose).toHaveBeenCalled();
  });
});
