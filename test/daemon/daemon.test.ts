import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeConfig } from '../../src/daemon/NodeConfig';
import { MemoryStore, readVsCodeGlobalState } from '../../src/daemon/vscodeState';
import { collectStatus, formatStatus } from '../../src/daemon/status';
import type { ISessionManager } from '../../src/ports/ISessionManager';

describe('NodeConfig', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackd-cfg-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('falls back to defaults with no files', () => {
    const c = new NodeConfig(() => dir, path.join(dir, 'none.json')).get();
    expect(c.defaultProvider).toBe('claude');
    expect(c.worktreesDirectory).toBe('.worktrees');
    expect(c.defaultBaseBranch).toBe('develop');
  });

  it('layers user settings over the repo config over defaults', () => {
    fs.mkdirSync(path.join(dir, '.stack'));
    fs.writeFileSync(path.join(dir, '.stack', 'config.json'), JSON.stringify({ version: 1, defaultBaseBranch: 'main', worktreesDirectory: '.wt' }));
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ 'stack.worktreesDirectory': '.mine', defaultProvider: 'opencode', claudeCommand: 'c' }));
    const c = new NodeConfig(() => dir, settings).get();
    expect(c.defaultBaseBranch).toBe('main');
    expect(c.worktreesDirectory).toBe('.mine');
    expect(c.defaultProvider).toBe('opencode');
    expect(c.claudeCommand).toBe('c');
  });

  it('reads settings from a version with Codex: defaultProvider "codex" falls back to Claude, a stray codexCommand is ignored', () => {
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ defaultProvider: 'codex', codexCommand: 'my-codex', 'stack.codexCommand': 'x', claudeCommand: 'c' }));
    const c = new NodeConfig(() => undefined, settings).get();
    expect(c.defaultProvider).toBe('claude');
    expect(c.claudeCommand).toBe('c');
    expect(c).not.toHaveProperty('codexCommand');
  });

  it('ignores a malformed settings file and wrongly typed values', () => {
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, '{nope');
    expect(new NodeConfig(() => undefined, settings).get().defaultProvider).toBe('claude');
    fs.writeFileSync(settings, JSON.stringify({ defaultProvider: 'bogus', setupInTerminal: 'x' }));
    const c = new NodeConfig(() => undefined, settings).get();
    expect(c.defaultProvider).toBe('claude');
    expect(c.setupInTerminal).toBe(false);
  });

  it('loads settings and a repo file of an older version: the keys of removed features are ignored', () => {
    // Per-worktree ports, the debug port and its launch.json template, search
    // scoping and the docker block: all gone, and none of them may stop loading.
    fs.mkdirSync(path.join(dir, '.stack'));
    fs.writeFileSync(path.join(dir, '.stack', 'config.json'), JSON.stringify({
      version: 1, defaultBaseBranch: 'main', ports: ['HTTP_PORT'], basePort: 31000, portStride: 20, debugBasePort: 9001,
      debugTemplate: { type: 'php', request: 'launch' }, docker: { composeFile: 'c.yml', ports: ['DB_PORT'] },
    }));
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({
      'stack.ports': ['API_PORT'], basePort: 1, portStride: 3, debugBasePort: 9898, debugTemplate: {},
      scopeSearchToActiveWorktree: false, 'stack.docker': { portStride: 7 }, claudeCommand: 'c',
    }));
    const c = new NodeConfig(() => dir, settings).get();
    expect(c.defaultBaseBranch).toBe('main');
    expect(c.claudeCommand).toBe('c');
    for (const key of ['ports', 'basePort', 'portStride', 'debugBasePort', 'debugTemplate', 'scopeSearchToActiveWorktree', 'docker']) {
      expect(c).not.toHaveProperty(key);
    }
  });
});

describe('MemoryStore / readVsCodeGlobalState', () => {
  it('keeps writes in memory and clones values', async () => {
    const seed = { a: { n: 1 } };
    const s = new MemoryStore(seed);
    await s.update('b', 2);
    seed.a.n = 9;
    expect(s.get('a', null)).toEqual({ n: 1 });
    expect(s.get('b', 0)).toBe(2);
  });

  it('returns {} when no state db exists', async () => {
    expect(await readVsCodeGlobalState(['/nonexistent/state.vscdb'])).toEqual({});
  });
});

describe('collectStatus', () => {
  const repo = '/r';
  const wt = (id: string, extra: object = {}) => ({
    id, branch: `b-${id}`, path: `/r/.worktrees/${id}`, repoRoot: repo, debugPort: 1, createdAt: 0, ...extra,
  });
  const tmux = (sessions: Record<string, Array<{ index: number; name: string }>>): ISessionManager => ({
    hasSession: async (n: string) => n in sessions,
    listWindows: async (n: string) => sessions[n] ?? [],
  } as unknown as ISessionManager);

  it('lists this repo\'s worktrees only, main first, with sessions and missing flag', async () => {
    // As an older version wrote the store: a debug port per worktree, and a port registry.
    const store = new MemoryStore({
      'stack.store': {
        worktrees: [wt('a'), wt('main', { isMain: true, path: '/r' }), { ...wt('other'), repoRoot: '/elsewhere' }],
        portRegistry: {},
      },
    });
    const items = await collectStatus(repo, {
      store,
      config: new NodeConfig(() => repo, '/nonexistent.json'),
      storagePath: os.tmpdir(),
      tmux: tmux({ 'stack-a': [{ index: 0, name: 'zsh' }, { index: 1, name: 'claude' }] }),
      exists: (p) => p === '/r',
    });
    expect(items.map((i) => i.id)).toEqual(['main', 'a']);
    expect(items[1].missing).toBe(true);
    expect(items[0].missing).toBe(false);
    expect(items[1].sessions.map((s) => s.kind)).toEqual(['agent']);
    const text = formatStatus(repo, items);
    expect(text).toContain('b-main [main]');
    expect(text).toContain('b-a [missing]');
    expect(text).toContain('1: ');
  });

  it('says so when nothing is tracked', () => {
    expect(formatStatus(repo, [])).toContain('no worktrees');
  });
});

describe('StackDaemon snapshot', () => {
  it('says which build and process it is, so the app can spot an old stackd and restart it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackd-snap-'));
    try {
      const { StackDaemon, STACKD_VERSION } = await import('../../src/daemon/StackDaemon');
      const daemon = new StackDaemon({ configDir: dir, home: dir, installHooks: false, notify: () => {} });
      expect(daemon.snapshot()).toMatchObject({ version: STACKD_VERSION, pid: process.pid, repos: [] });
      await daemon.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
