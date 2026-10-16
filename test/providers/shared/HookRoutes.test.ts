import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HookRoutes } from '../../../src/providers/shared/HookRoutes';

// Auto-spy on node:fs (real implementations kept) so one removal can fail.
vi.mock('node:fs', { spy: true });

describe('HookRoutes', () => {
  let storage: string;
  const A = 'http://127.0.0.1:1111';
  const B = 'http://127.0.0.1:2222';

  beforeEach(() => { storage = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-routes-')); });
  afterEach(() => { fs.rmSync(storage, { recursive: true, force: true }); });

  it('routes each worktree to the window that claimed it — two windows, two repos', () => {
    new HookRoutes(storage).claim(['wt-a1', 'wt-a2'], A);
    new HookRoutes(storage).claim(['wt-b1'], B);
    const routes = new HookRoutes(storage);
    expect(routes.lookup('wt-a1')).toBe(A);
    expect(routes.lookup('wt-a2')).toBe(A);
    expect(routes.lookup('wt-b1')).toBe(B);
  });

  it('a reload re-claims with the new port', () => {
    new HookRoutes(storage).claim(['wt-1'], A);
    new HookRoutes(storage).claim(['wt-1'], B);
    expect(new HookRoutes(storage).lookup('wt-1')).toBe(B);
  });

  it('does not rewrite a route that already says the same thing', () => {
    const routes = new HookRoutes(storage);
    routes.claim(['wt-1'], A);
    const file = path.join(routes.dir, 'wt-1');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    routes.claim(['wt-1'], A);
    // Not toBe(past): utimes round-trips through seconds as a float, and ext4
    // hands back 1792181598437.999 for …438. Untouched means still a minute old.
    expect(fs.statSync(file).mtimeMs).toBeLessThan(Date.now() - 30_000);
  });

  it('closing a window withdraws only what still points at it', () => {
    // wt-shared was claimed by B after A: B's now, and B is still open.
    new HookRoutes(storage).claim(['wt-a', 'wt-shared'], A);
    new HookRoutes(storage).claim(['wt-b', 'wt-shared'], B);
    new HookRoutes(storage).setDefault(A);

    new HookRoutes(storage).release(A);

    const routes = new HookRoutes(storage);
    expect(routes.lookup('wt-a')).toBeUndefined();
    expect(routes.lookup('wt-shared')).toBe(B);
    expect(routes.lookup('wt-b')).toBe(B);
    expect(fs.existsSync(routes.defaultUrlPath)).toBe(false);
  });

  it("closing a window leaves another window's default endpoint alone", () => {
    new HookRoutes(storage).setDefault(B);
    new HookRoutes(storage).release(A);
    expect(fs.readFileSync(new HookRoutes(storage).defaultUrlPath, 'utf8')).toBe(B);
  });

  it('reads an empty route as no route', () => {
    const routes = new HookRoutes(storage);
    fs.mkdirSync(routes.dir, { recursive: true });
    fs.writeFileSync(path.join(routes.dir, 'wt-1'), '  \n');
    expect(routes.lookup('wt-1')).toBeUndefined();
  });

  it("closing a window leaves a claim's temp file alone — it is someone's write in progress", () => {
    const routes = new HookRoutes(storage);
    fs.mkdirSync(routes.dir, { recursive: true });
    const tmp = path.join(routes.dir, '.wt-1.123.tmp');
    fs.writeFileSync(tmp, A);
    routes.release(A);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  it('closing a window goes on past a route it cannot remove', () => {
    const routes = new HookRoutes(storage);
    routes.claim(['wt-1', 'wt-2'], A);
    vi.mocked(fs.rmSync).mockImplementationOnce(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    expect(() => routes.release(A)).not.toThrow();
    // One of the two survived the failed removal; the other is gone.
    expect(['wt-1', 'wt-2'].filter((id) => routes.lookup(id) === A)).toHaveLength(1);
  });

  it('release is a no-op before anything was claimed', () => {
    expect(() => new HookRoutes(storage).release(A)).not.toThrow();
  });

  it('never turns an id that is not a plain token into a path', () => {
    const routes = new HookRoutes(storage);
    routes.claim(['../escape', 'a/b', ''], A);
    expect(fs.existsSync(path.join(storage, 'escape'))).toBe(false);
    expect(fs.existsSync(routes.dir) ? fs.readdirSync(routes.dir) : []).toEqual([]);
    expect(routes.lookup('../escape')).toBeUndefined();
  });

  describe("Foreman's storage directory (the extension's old id)", () => {
    // globalStorage/<id>/ for both ids, side by side, as VS Code lays them out.
    let globalStorage: string;
    let mine: string;
    let legacy: string;
    beforeEach(() => {
      globalStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-gs-'));
      mine = path.join(globalStorage, 'ricardomoratomateos.stack');
      legacy = path.join(globalStorage, 'foreman.foreman');
    });
    afterEach(() => { fs.rmSync(globalStorage, { recursive: true, force: true }); });

    it("keeps Foreman's routes and hook-url current, so agents it started still reach this window", () => {
      fs.mkdirSync(legacy);
      const routes = new HookRoutes(mine);
      routes.claim(['wt-1'], A);
      routes.setDefault(A);
      const theirs = new HookRoutes(legacy, { mirrorLegacy: false });
      expect(theirs.lookup('wt-1')).toBe(A);
      expect(fs.readFileSync(path.join(legacy, 'hook-url'), 'utf8')).toBe(A);

      // A launch claims there too, and a closing window withdraws there too.
      routes.launchEnv('wt-2', A);
      expect(theirs.lookup('wt-2')).toBe(A);
      routes.release(A);
      expect(theirs.lookup('wt-1')).toBeUndefined();
      expect(fs.existsSync(path.join(legacy, 'hook-url'))).toBe(false);
    });

    it('never creates that directory on a machine that never ran Foreman', () => {
      const routes = new HookRoutes(mine);
      routes.claim(['wt-1'], A);
      routes.setDefault(A);
      routes.release(A);
      expect(fs.existsSync(legacy)).toBe(false);
    });

    it('is not mirrored when asked not to', () => {
      fs.mkdirSync(legacy);
      new HookRoutes(mine, { mirrorLegacy: false }).claim(['wt-1'], A);
      expect(fs.existsSync(path.join(legacy, 'routes'))).toBe(false);
    });
  });

  describe('launchEnv', () => {
    it('is just the worktree id before the server is up', () => {
      expect(new HookRoutes(storage).launchEnv('wt-1', undefined)).toBe('STACK_WORKSPACE_ID="wt-1" FOREMAN_WORKSPACE_ID="wt-1"');
      expect(new HookRoutes(storage).lookup('wt-1')).toBeUndefined();
    });

    it('adds the URL and takes the route over from another window', () => {
      new HookRoutes(storage).claim(['wt-1'], B);
      expect(new HookRoutes(storage).launchEnv('wt-1', A)).toBe(`STACK_HOOK_URL="${A}" FOREMAN_HOOK_URL="${A}" STACK_WORKSPACE_ID="wt-1" FOREMAN_WORKSPACE_ID="wt-1"`);
      expect(new HookRoutes(storage).lookup('wt-1')).toBe(A);
    });

    it('never fails a launch over the routing file', () => {
      // A FILE where the routes directory should be: every claim throws.
      fs.writeFileSync(path.join(storage, 'routes'), '');
      expect(new HookRoutes(storage).launchEnv('wt-1', A)).toBe(`STACK_HOOK_URL="${A}" FOREMAN_HOOK_URL="${A}" STACK_WORKSPACE_ID="wt-1" FOREMAN_WORKSPACE_ID="wt-1"`);
    });
  });
});
