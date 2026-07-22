import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { WorktreeManager } from '../../src/worktree/WorktreeManager';
import { parseWorktreeList } from '../../src/adapters/GitCliAdapter';
import { IGitPort, GitWorktreeEntry } from '../../src/ports/IGitPort';
import { IFileSystem } from '../../src/ports/IFileSystem';
import { IWorktreeRepository } from '../../src/ports/IWorktreeRepository';
import { Worktree, DebugTemplate, UnmessConfig } from '../../src/types';
import { WORKTREE_SETTINGS_EXCLUSIONS } from '../../src/constants';
import type { PortAllocator } from '../../src/worktree/portAllocator';
import type { ConfigManager } from '../../src/config/ConfigManager';
import type { AgentSessionManager } from '../../src/session/AgentSessionManager';

// ---------- test doubles ----------

/** In-memory stub of IWorktreeRepository (deliberately NOT WorktreeStore). */
function makeStoreStub(initial: Worktree[] = []) {
  let worktrees: Worktree[] = initial.map((w) => ({ ...w }));
  const portRegistry: Record<string, number> = {};
  for (const w of initial) portRegistry[w.path] = w.xdebugPort;
  const calls: string[] = [];
  const store: IWorktreeRepository & { calls: string[] } = {
    calls,
    getAll: () => [...worktrees],
    get: (id: string) => worktrees.find((w) => w.id === id),
    add: async (w: Worktree) => {
      calls.push(`add:${w.branch}`);
      worktrees.push({ ...w });
      portRegistry[w.path] = w.xdebugPort;
    },
    patch: async (id: string, fields: Partial<Worktree>) => {
      calls.push(`patch:${id}:${JSON.stringify(fields)}`);
      const wt = worktrees.find((w) => w.id === id);
      if (wt) Object.assign(wt, fields);
    },
    setAlias: async (id: string, alias: string) => {
      calls.push(`setAlias:${id}:${alias}`);
      const wt = worktrees.find((w) => w.id === id);
      if (wt) wt.alias = alias;
    },
    remove: async (id: string) => {
      calls.push(`remove:${id}`);
      const wt = worktrees.find((w) => w.id === id);
      if (wt) delete portRegistry[wt.path];
      worktrees = worktrees.filter((w) => w.id !== id);
    },
    getPortRegistry: () => ({ ...portRegistry }),
  };
  return store;
}

/** In-memory IFileSystem. */
function makeFsStub() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const fsStub: IFileSystem & { files: Map<string, string>; dirs: Set<string> } = {
    files,
    dirs,
    exists: (p: string) => files.has(p) || dirs.has(p),
    readFile: (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
    writeFile: (p: string, content: string) => {
      files.set(p, content);
    },
    mkdir: (p: string) => {
      dirs.add(p);
    },
  };
  return fsStub;
}

function makeGitStub(entries: GitWorktreeEntry[] = []): IGitPort & {
  listWorktrees: ReturnType<typeof vi.fn>;
  createWorktree: ReturnType<typeof vi.fn>;
  deleteWorktree: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
  branchExists: ReturnType<typeof vi.fn>;
  currentBranch: ReturnType<typeof vi.fn>;
} {
  return {
    listWorktrees: vi.fn(() => entries),
    createWorktree: vi.fn(),
    deleteWorktree: vi.fn(),
    deleteBranch: vi.fn(),
    branchExists: vi.fn(() => false),
    currentBranch: vi.fn(() => 'main'),
  };
}

function makeConfigStub(overrides: Partial<UnmessConfig> = {}): ConfigManager {
  return {
    get: (): UnmessConfig => ({
      worktreesDirectory: './zer',
      setupScript: '',
      teardownScript: '',
      claudeCommand: 'claude',
      xdebugBasePort: 9898,
      debugTemplate: {
        type: 'php',
        request: 'launch',
        name: 'Unmess: Debug',
        port: '{{PORT}}',
        pathMappings: { '/var/www/html': '{{WORKTREE_PATH}}' },
      } as DebugTemplate,
      ...overrides,
      // deep-copy the template each call, like vscode config does
      ...(overrides.debugTemplate
        ? { debugTemplate: JSON.parse(JSON.stringify(overrides.debugTemplate)) }
        : {}),
    }),
  } as ConfigManager;
}

function makePortAllocatorStub(port = 9899): PortAllocator {
  return {
    allocate: vi.fn(() => port),
    release: vi.fn(),
  } as unknown as PortAllocator;
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    branch: 'feat/x',
    path: '/repo/zer/feat-x',
    repoRoot: '/repo',
    xdebugPort: 9899,
    dockerProjectName: 'feat-x',
    createdAt: 1,
    ...overrides,
  };
}

const REPO = '/repo';

// ---------- parseWorktreeList (pure, lives in GitCliAdapter) ----------

describe('parseWorktreeList', () => {
  it('parses main worktree', () => {
    const out = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n';
    expect(parseWorktreeList(out)).toEqual([
      { path: '/repo', head: 'abc123', branch: 'main' },
    ]);
  });

  it('parses linked worktrees with branch', () => {
    const out = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/zer/feat-x',
      'HEAD def456',
      'branch refs/heads/feat/x',
      '',
    ].join('\n');
    expect(parseWorktreeList(out)).toEqual([
      { path: '/repo', head: 'abc123', branch: 'main' },
      { path: '/repo/zer/feat-x', head: 'def456', branch: 'feat/x' },
    ]);
  });

  it('SKIPS detached HEAD worktrees (no branch line → filtered out)', () => {
    const out = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/zer/detached',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');
    const parsed = parseWorktreeList(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('/repo');
  });

  it('handles empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('ignores blocks without a worktree path line', () => {
    expect(parseWorktreeList('branch refs/heads/orphan\nHEAD abc123\n')).toEqual([]);
  });
});

// ---------- list ----------

describe('list', () => {
  it('sorts main worktree first', () => {
    const store = makeStoreStub([
      makeWorktree({ id: 'a', branch: 'feat/a', path: '/repo/zer/a', isMain: false }),
      makeWorktree({ id: 'main', branch: 'main', path: '/repo', isMain: true }),
      makeWorktree({ id: 'b', branch: 'feat/b', path: '/repo/zer/b', isMain: false }),
    ]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, makeGitStub(), makeFsStub());
    const list = mgr.list();
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe('main');
  });
});

// ---------- create ----------

describe('create', () => {
  let store: ReturnType<typeof makeStoreStub>;
  let git: ReturnType<typeof makeGitStub>;
  let fsStub: ReturnType<typeof makeFsStub>;
  let allocator: PortAllocator;

  beforeEach(() => {
    store = makeStoreStub();
    git = makeGitStub();
    fsStub = makeFsStub();
    allocator = makePortAllocatorStub(9899);
    // Simulate git actually materializing the worktree directory on add.
    git.createWorktree.mockImplementation((wtPath: string) => { fsStub.dirs.add(wtPath); });
  });

  function mgr(config = makeConfigStub()) {
    return new WorktreeManager(store, allocator, config, undefined, git, fsStub);
  }

  it('uses git worktree add -b when branch does not exist', async () => {
    git.branchExists.mockReturnValue(false);
    await mgr().create('feat/x', REPO);
    expect(git.createWorktree).toHaveBeenCalledWith(
      path.join(REPO, 'zer', 'feat-x'), 'feat/x', REPO, true,
    );
  });

  it('uses git worktree add (no -b, reuse branch) when branch exists — does NOT throw', async () => {
    git.branchExists.mockReturnValue(true);
    const wt = await mgr().create('feat/x', REPO);
    expect(wt.branch).toBe('feat/x');
    expect(git.createWorktree).toHaveBeenCalledWith(
      path.join(REPO, 'zer', 'feat-x'), 'feat/x', REPO, false,
    );
  });

  it('replaces / with - in the directory name', async () => {
    const wt = await mgr().create('feat/deep/nesting', REPO);
    expect(wt.path).toBe(path.join(REPO, 'zer', 'feat-deep-nesting'));
  });

  it('throws (no phantom store entry) when git worktree add leaves no directory', async () => {
    git.createWorktree.mockImplementation(() => { /* branch created, but no worktree dir */ });
    await expect(mgr().create('feat/x', REPO)).rejects.toThrow(/did not create the directory/);
    expect(store.calls).toEqual([]); // nothing registered
  });

  it('sets the alias (title) when provided; leaves it undefined otherwise', async () => {
    const withAlias = await mgr().create('feat/x', REPO, 'Fix the bug');
    expect(withAlias.alias).toBe('Fix the bug');
    const noAlias = await mgr().create('feat/y', REPO);
    expect(noAlias.alias).toBeUndefined();
    const emptyAlias = await mgr().create('feat/z', REPO, '');
    expect(emptyAlias.alias).toBeUndefined();
  });

  it('creates the worktrees directory before adding', async () => {
    await mgr().create('feat/x', REPO);
    expect(fsStub.dirs.has(path.join(REPO, 'zer'))).toBe(true);
  });

  it('resolves worktreesDirectory relative to repoRoot', async () => {
    const wt = await mgr(makeConfigStub({ worktreesDirectory: './trees' })).create('a', REPO);
    expect(wt.path).toBe(path.join(REPO, 'trees', 'a'));
  });

  it('uses an absolute worktreesDirectory as-is', async () => {
    const wt = await mgr(makeConfigStub({ worktreesDirectory: '/abs/wts' })).create('a', REPO);
    expect(wt.path).toBe(path.join('/abs/wts', 'a'));
  });

  it('derives dockerProjectName (lowercase, non [a-z0-9-] → -)', async () => {
    const wt = await mgr().create('Feat/X_1', REPO);
    expect(wt.dockerProjectName).toBe('feat-x-1');
  });

  it('generates launch.json and settings.json', async () => {
    const wt = await mgr().create('feat/x', REPO);
    const launchPath = path.join(wt.path, '.vscode/launch.json');
    const settingsPath = path.join(wt.path, '.vscode/settings.json');
    expect(fsStub.files.has(launchPath)).toBe(true);
    expect(fsStub.files.has(settingsPath)).toBe(true);
    expect(fsStub.dirs.has(path.dirname(launchPath))).toBe(true);
    expect(JSON.parse(fsStub.files.get(settingsPath)!)).toEqual(WORKTREE_SETTINGS_EXCLUSIONS);
  });

  it('persists to repository (worktree + port registry keyed by path)', async () => {
    const wt = await mgr().create('feat/x', REPO);
    expect(store.getAll()).toHaveLength(1);
    expect(store.get(wt.id)?.branch).toBe('feat/x');
    expect(store.getPortRegistry()[wt.path]).toBe(9899);
  });

  it('allocates a port', async () => {
    const wt = await mgr().create('feat/x', REPO);
    expect(allocator.allocate).toHaveBeenCalledTimes(1);
    expect(wt.xdebugPort).toBe(9899);
  });
});

// ---------- delete ----------

describe('delete', () => {
  let store: ReturnType<typeof makeStoreStub>;
  let git: ReturnType<typeof makeGitStub>;
  let claude: { terminateSession: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    store = makeStoreStub([makeWorktree()]);
    git = makeGitStub();
    claude = { terminateSession: vi.fn() };
  });

  function mgr() {
    return new WorktreeManager(
      store, makePortAllocatorStub(), makeConfigStub(),
      claude as unknown as AgentSessionManager, git, makeFsStub(),
    );
  }

  it('terminates the tmux session first (before git worktree remove)', async () => {
    await mgr().delete('wt-1');
    expect(claude.terminateSession).toHaveBeenCalledWith('wt-1');
    expect(claude.terminateSession.mock.invocationCallOrder[0])
      .toBeLessThan(git.deleteWorktree.mock.invocationCallOrder[0]);
  });

  it('calls git.deleteWorktree with the worktree path; git failure still removes from store', async () => {
    git.deleteWorktree.mockImplementation(() => { throw new Error('worktree gone'); });
    await mgr().delete('wt-1');
    expect(git.deleteWorktree).toHaveBeenCalledWith('/repo/zer/feat-x', '/repo');
    expect(store.getAll()).toHaveLength(0);
    expect(store.getPortRegistry()['/repo/zer/feat-x']).toBeUndefined();
  });

  it('deletes branch only when deleteBranch=true; branch-delete failure tolerated', async () => {
    await mgr().delete('wt-1', false);
    expect(git.deleteBranch).not.toHaveBeenCalled();

    store = makeStoreStub([makeWorktree()]);
    git = makeGitStub();
    git.deleteBranch.mockImplementation(() => { throw new Error('no branch'); });
    await mgr().delete('wt-1', true);
    expect(git.deleteBranch).toHaveBeenCalledWith('feat/x', '/repo');
    expect(store.getAll()).toHaveLength(0);
  });

  it('deletes the branch when deleteBranch=true and git succeeds', async () => {
    await mgr().delete('wt-1', true);
    expect(git.deleteBranch).toHaveBeenCalledWith('feat/x', '/repo');
    expect(store.getAll()).toHaveLength(0);
  });

  it('no-ops for unknown id', async () => {
    await mgr().delete('nope');
    expect(claude.terminateSession).not.toHaveBeenCalled();
    expect(git.deleteWorktree).not.toHaveBeenCalled();
    expect(store.getAll()).toHaveLength(1);
  });

  it('works without a agentManager (optional dependency)', async () => {
    const m = new WorktreeManager(
      store, makePortAllocatorStub(), makeConfigStub(), undefined, git, makeFsStub(),
    );
    await m.delete('wt-1');
    expect(store.getAll()).toHaveLength(0);
  });
});

// ---------- reconcile ----------

describe('reconcile', () => {
  const MAIN: GitWorktreeEntry = { path: '/repo', head: 'aaa', branch: 'main' };
  const LINKED: GitWorktreeEntry = { path: '/repo/zer/feat-x', head: 'bbb', branch: 'feat/x' };

  it('adopts new worktrees found by git', async () => {
    const store = makeStoreStub();
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(9899), makeConfigStub(), undefined, git, makeFsStub());
    const { adopted, removed, current } = await mgr.reconcile(REPO);
    expect(removed).toEqual([]);
    expect(adopted).toHaveLength(2);
    expect(current).toHaveLength(2);
    const main = current.find((w) => w.path === '/repo')!;
    const linked = current.find((w) => w.path === '/repo/zer/feat-x')!;
    expect(main.isMain).toBe(true);
    expect(main.branch).toBe('main');
    expect(linked.isMain).toBe(false);
    expect(linked.branch).toBe('feat/x');
    expect(linked.dockerProjectName).toBe('feat-x');
    expect(linked.repoRoot).toBe(REPO);
    expect(typeof linked.id).toBe('string');
    expect(linked.id).not.toBe('');
  });

  it('ABORTS without touching the store when git output is empty (git error)', async () => {
    const existing = makeWorktree();
    const store = makeStoreStub([existing]);
    const git = makeGitStub([]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, makeFsStub());
    const result = await mgr.reconcile(REPO);
    expect(result).toEqual({ adopted: [], removed: [], current: [existing] });
    expect(store.calls).toEqual([]); // no add/patch/remove
  });

  it('patches isMain by exact normalized path match against repoRoot', async () => {
    const store = makeStoreStub([
      // '/repo/zer/..' normalizes to '/repo' → matches repoRoot.
      // NOTE: a trailing slash ('/repo/') would NOT match — path.normalize preserves it.
      makeWorktree({ id: 'm', branch: 'main', path: '/repo/zer/..', isMain: false }),
      makeWorktree({ id: 'x', branch: 'feat/x', path: '/repo/zer/feat-x', isMain: true }), // wrongly marked main
    ]);
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, makeFsStub());
    await mgr.reconcile(REPO);
    expect(store.get('m')?.isMain).toBe(true);
    expect(store.get('x')?.isMain).toBe(false);
  });

  it('syncs stale branch names from git', async () => {
    const store = makeStoreStub([
      makeWorktree({ id: 'x', branch: 'old-branch', path: '/repo/zer/feat-x', isMain: false }),
    ]);
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, makeFsStub());
    await mgr.reconcile(REPO);
    expect(store.get('x')?.branch).toBe('feat/x');
  });

  it('leaves stored entries absent from git untouched (no branch sync, kept in store)', async () => {
    const stale = makeWorktree({ id: 'gone', branch: 'old', path: '/repo/zer/gone', isMain: false });
    const store = makeStoreStub([stale]);
    const git = makeGitStub([MAIN]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, makeFsStub());
    await mgr.reconcile(REPO);
    expect(store.get('gone')).toEqual(stale); // still there, branch untouched
  });

  it('skips generating settings.json on adoption when it already exists', async () => {
    const fsStub = makeFsStub();
    fsStub.files.set(path.join(LINKED.path, '.vscode/settings.json'), 'preexisting-settings');
    const store = makeStoreStub();
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, fsStub);
    await mgr.reconcile(REPO);
    expect(fsStub.files.get(path.join(LINKED.path, '.vscode/settings.json'))).toBe('preexisting-settings');
    expect(fsStub.files.has(path.join(LINKED.path, '.vscode/launch.json'))).toBe(true); // still generated
  });

  it('does not patch stored worktrees that are already in sync', async () => {
    const store = makeStoreStub([
      makeWorktree({ id: 'x', branch: 'feat/x', path: '/repo/zer/feat-x', isMain: false }),
      makeWorktree({ id: 'm', branch: 'main', path: '/repo', isMain: true }),
    ]);
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, makeFsStub());
    await mgr.reconcile(REPO);
    expect(store.calls.filter((c) => c.startsWith('patch:'))).toEqual([]);
  });

  it('main worktree gets port 0; others get allocated ports', async () => {
    const store = makeStoreStub();
    const allocator = makePortAllocatorStub(9901);
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, allocator, makeConfigStub(), undefined, git, makeFsStub());
    const { current } = await mgr.reconcile(REPO);
    expect(current.find((w) => w.isMain)?.xdebugPort).toBe(0);
    expect(current.find((w) => !w.isMain)?.xdebugPort).toBe(9901);
    expect(allocator.allocate).toHaveBeenCalledTimes(1); // never called for main
  });

  it('generates .vscode files on adoption only when missing and not main', async () => {
    const fsStub = makeFsStub();
    // launch.json already present for the linked worktree → only settings.json generated
    fsStub.files.set(path.join(LINKED.path, '.vscode/launch.json'), 'preexisting');
    const store = makeStoreStub();
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, fsStub);
    await mgr.reconcile(REPO);
    // main: nothing generated
    expect(fsStub.files.has(path.join(MAIN.path, '.vscode/launch.json'))).toBe(false);
    expect(fsStub.files.has(path.join(MAIN.path, '.vscode/settings.json'))).toBe(false);
    // linked: existing launch.json untouched, missing settings.json generated
    expect(fsStub.files.get(path.join(LINKED.path, '.vscode/launch.json'))).toBe('preexisting');
    expect(fsStub.files.has(path.join(LINKED.path, '.vscode/settings.json'))).toBe(true);
  });

  it('generates both .vscode files on adoption when neither exists', async () => {
    const fsStub = makeFsStub();
    const store = makeStoreStub();
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, fsStub);
    await mgr.reconcile(REPO);
    expect(fsStub.files.has(path.join(LINKED.path, '.vscode/launch.json'))).toBe(true);
    expect(fsStub.files.has(path.join(LINKED.path, '.vscode/settings.json'))).toBe(true);
  });

  it('returns current list', async () => {
    const existing = makeWorktree({ id: 'x', branch: 'feat/x', path: '/repo/zer/feat-x', isMain: false });
    const store = makeStoreStub([existing]);
    const git = makeGitStub([MAIN, LINKED]);
    const mgr = new WorktreeManager(store, makePortAllocatorStub(), makeConfigStub(), undefined, git, makeFsStub());
    const { adopted, current } = await mgr.reconcile(REPO);
    expect(adopted).toHaveLength(1); // only main adopted
    expect(current).toHaveLength(2);
    expect(current.map((w) => w.path).sort()).toEqual(['/repo', '/repo/zer/feat-x']);
  });
});

// ---------- listFromGit ----------

describe('listFromGit', () => {
  it('delegates to the git port', () => {
    const entries: GitWorktreeEntry[] = [{ path: '/repo', head: 'aaa', branch: 'main' }];
    const git = makeGitStub(entries);
    const mgr = new WorktreeManager(makeStoreStub(), makePortAllocatorStub(), makeConfigStub(), undefined, git, makeFsStub());
    expect(mgr.listFromGit(REPO)).toEqual(entries);
    expect(git.listWorktrees).toHaveBeenCalledWith(REPO);
  });
});

// ---------- generateLaunchJson (observed through create) ----------

describe('generateLaunchJson', () => {
  it('substitutes {{PORT}} (quoted → number, unquoted → string) and {{WORKTREE_PATH}}', async () => {
    const config = makeConfigStub({
      debugTemplate: {
        type: 'php',
        request: 'launch',
        name: 'My Debug',
        port: '{{PORT}}', // quoted in JSON → becomes a number
        pathMappings: { '/var/www/html': '{{WORKTREE_PATH}}' },
        log: 'listening on {{PORT}}', // embedded → stays a string
      } as DebugTemplate,
    });
    const fsStub = makeFsStub();
    const git = makeGitStub();
    git.createWorktree.mockImplementation((p: string) => { fsStub.dirs.add(p); });
    const mgr = new WorktreeManager(
      makeStoreStub(), makePortAllocatorStub(9899), config, undefined, git, fsStub,
    );
    const wt = await mgr.create('feat/x', REPO);
    const written = JSON.parse(fsStub.files.get(path.join(wt.path, '.vscode/launch.json'))!);
    expect(written.version).toBe('0.2.0');
    expect(written.configurations).toHaveLength(1);
    const cfg = written.configurations[0];
    expect(cfg.port).toBe(9899); // number, not string
    expect(cfg.pathMappings['/var/www/html']).toBe(wt.path);
    expect(cfg.log).toBe('listening on 9899'); // string with substitution
    expect(cfg.name).toBe('My Debug');
  });

  it('defaults template name to "Unmess: Xdebug (<branch>)"', async () => {
    const config = makeConfigStub({
      debugTemplate: {
        type: 'php',
        request: 'launch',
        name: '',
        port: '{{PORT}}',
      } as DebugTemplate,
    });
    const fsStub = makeFsStub();
    const git = makeGitStub();
    git.createWorktree.mockImplementation((p: string) => { fsStub.dirs.add(p); });
    const mgr = new WorktreeManager(
      makeStoreStub(), makePortAllocatorStub(), config, undefined, git, fsStub,
    );
    const wt = await mgr.create('feat/x', REPO);
    const written = JSON.parse(fsStub.files.get(path.join(wt.path, '.vscode/launch.json'))!);
    expect(written.configurations[0].name).toBe('Unmess: Xdebug (feat/x)');
  });
});
