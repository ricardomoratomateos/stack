import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HookRoutes } from '../../../src/providers/shared/HookRoutes';

describe('HookRoutes', () => {
  let storage: string;
  const A = 'http://127.0.0.1:1111';
  const B = 'http://127.0.0.1:2222';

  beforeEach(() => { storage = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-routes-')); });
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
    expect(fs.statSync(file).mtimeMs).toBe(past.getTime());
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

  describe('launchEnv', () => {
    it('is just the worktree id before the server is up', () => {
      expect(new HookRoutes(storage).launchEnv('wt-1', undefined)).toBe('FOREMAN_WORKSPACE_ID="wt-1"');
      expect(new HookRoutes(storage).lookup('wt-1')).toBeUndefined();
    });

    it('adds the URL and takes the route over from another window', () => {
      new HookRoutes(storage).claim(['wt-1'], B);
      expect(new HookRoutes(storage).launchEnv('wt-1', A)).toBe(`FOREMAN_HOOK_URL="${A}" FOREMAN_WORKSPACE_ID="wt-1"`);
      expect(new HookRoutes(storage).lookup('wt-1')).toBe(A);
    });

    it('never fails a launch over the routing file', () => {
      // A FILE where the routes directory should be: every claim throws.
      fs.writeFileSync(path.join(storage, 'routes'), '');
      expect(new HookRoutes(storage).launchEnv('wt-1', A)).toBe(`FOREMAN_HOOK_URL="${A}" FOREMAN_WORKSPACE_ID="wt-1"`);
    });
  });
});
