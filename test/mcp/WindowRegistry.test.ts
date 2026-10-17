import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WindowRegistry } from '../../src/mcp/WindowRegistry';

describe('WindowRegistry', () => {
  let dir: string;
  let now = 100;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-reg-')); now = 100; });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (pid = 4242) => new WindowRegistry(dir, { pid, now: () => now, token: 'tok' });
  const read = (r: WindowRegistry) => JSON.parse(fs.readFileSync(r.file, 'utf8'));

  it('writes nothing until it knows the port', () => {
    const r = make();
    r.update({ repoRoots: ['/r'] });
    r.focus();
    expect(fs.existsSync(r.file)).toBe(false);
  });

  it('writes windows/<pid>.json, 0600 in a 0700 directory, with everything a bridge needs', () => {
    const r = make();
    r.update({ port: 5555, repoRoots: ['/r'], workspaceFolders: ['/r'], worktreeIds: ['a'] });
    expect(r.file).toBe(path.join(dir, 'windows', '4242.json'));
    expect(read(r)).toEqual({ pid: 4242, port: 5555, token: 'tok', repoRoots: ['/r'], workspaceFolders: ['/r'], worktreeIds: ['a'], focusedAt: 100 });
    expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(r.dir).mode & 0o777).toBe(0o700);
  });

  it('does not rewrite unchanged content, but restores a file that went missing', () => {
    const r = make();
    r.update({ port: 5555 });
    const before = fs.statSync(r.file).mtimeMs;
    fs.utimesSync(r.file, 1, 1);
    r.update({ port: 5555 });
    expect(fs.statSync(r.file).mtimeMs).toBe(1000);
    fs.rmSync(r.file);
    r.update({ port: 5555 });
    expect(fs.existsSync(r.file)).toBe(true);
    expect(before).toBeGreaterThan(0);
  });

  it('focus moves focusedAt forward', () => {
    const r = make();
    r.update({ port: 1 });
    now = 999;
    r.focus();
    expect(read(r).focusedAt).toBe(999);
  });

  it('dispose removes the file, and nothing is written after it', () => {
    const r = make();
    r.update({ port: 1 });
    r.dispose();
    expect(fs.existsSync(r.file)).toBe(false);
    r.focus();
    r.update({ port: 2 });
    expect(fs.existsSync(r.file)).toBe(false);
    r.dispose(); // twice is fine
  });

  it('dispose never throws, even when the file cannot be removed', () => {
    const r = make();
    r.update({ port: 1 });
    fs.chmodSync(r.dir, 0o500);
    try {
      expect(() => r.dispose()).not.toThrow();
    } finally {
      fs.chmodSync(r.dir, 0o700);
    }
  });

  it('sweep removes the files of windows that are gone', () => {
    const dead = make(1111);
    dead.update({ port: 1 });
    const r = new WindowRegistry(dir, { pid: 4242, isAlive: (pid) => pid !== 1111 });
    r.sweep();
    expect(fs.existsSync(dead.file)).toBe(false);
  });

  it('defaults: its own pid, a random 64-hex token, the real clock and liveness check', () => {
    const r = new WindowRegistry(dir);
    expect(r.file).toBe(path.join(dir, 'windows', `${process.pid}.json`));
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(new WindowRegistry(dir).token).not.toBe(r.token);
    r.update({ port: 1 });
    expect(read(r).focusedAt).toBeGreaterThan(1_600_000_000_000);
    r.sweep();
    expect(fs.existsSync(r.file)).toBe(true);
  });
});
