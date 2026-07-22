import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitCliAdapter } from '../../src/adapters/GitCliAdapter';
import { NodeFileSystem } from '../../src/adapters/NodeFileSystem';
import { NodeProcessRunner } from '../../src/adapters/NodeProcessRunner';

let tmp: string;
let repo: string;
const adapter = new GitCliAdapter();

function git(cmd: string, cwd = repo): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

beforeAll(() => {
  // realpathSync: macOS tmpdir is a symlink (/var → /private/var); git reports resolved paths
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unmess-gitcli-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git('init -b main');
  git('config user.email "test@unmess.dev"');
  git('config user.name "Unmess Test"');
  git('config commit.gpgsign false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git('add .');
  git('commit -m init');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GitCliAdapter (integration, real temp git repo)', () => {
  describe('listWorktrees', () => {
    it('lists main worktree', () => {
      const list = adapter.listWorktrees(repo);
      expect(list).toHaveLength(1);
      expect(list[0].path).toBe(repo);
      expect(list[0].branch).toBe('main');
      expect(list[0].head).toMatch(/^[0-9a-f]{40}$/);
    });

    it('lists linked worktrees', () => {
      const wtPath = path.join(tmp, 'wt-listed');
      git(`worktree add -b listed "${wtPath}"`);
      const list = adapter.listWorktrees(repo);
      expect(list.map((w) => w.path)).toContain(wtPath);
      expect(list.find((w) => w.path === wtPath)?.branch).toBe('listed');
      git(`worktree remove --force "${wtPath}"`);
      git('branch -D listed');
    });

    it('skips detached-HEAD worktrees', () => {
      const wtPath = path.join(tmp, 'wt-detached');
      git(`worktree add --detach "${wtPath}"`);
      const list = adapter.listWorktrees(repo);
      expect(list.map((w) => w.path)).not.toContain(wtPath);
      expect(list.map((w) => w.path)).toContain(repo); // main still listed
      git(`worktree remove --force "${wtPath}"`);
    });

    it('returns [] on git failure (not a repo)', () => {
      const notARepo = path.join(tmp, 'not-a-repo');
      fs.mkdirSync(notARepo, { recursive: true });
      expect(adapter.listWorktrees(notARepo)).toEqual([]);
    });
  });

  describe('createWorktree', () => {
    it('creates a linked worktree on a new branch (newBranch=true)', async () => {
      const wtPath = path.join(tmp, 'wt-feat-a');
      await adapter.createWorktree(wtPath, 'feat-a', repo, true);
      expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);
      expect(git('branch --show-current', wtPath).trim()).toBe('feat-a');
      const list = adapter.listWorktrees(repo);
      expect(list.find((w) => w.path === wtPath)?.branch).toBe('feat-a');
    });

    it('reuses an existing branch (newBranch=false)', async () => {
      git('branch feat-b');
      const wtPath = path.join(tmp, 'wt-feat-b');
      await adapter.createWorktree(wtPath, 'feat-b', repo, false);
      expect(git('branch --show-current', wtPath).trim()).toBe('feat-b');
      expect(adapter.listWorktrees(repo).find((w) => w.path === wtPath)?.branch).toBe('feat-b');
    });

    it('rejects when reusing a branch that does not exist', async () => {
      const wtPath = path.join(tmp, 'wt-missing-branch');
      await expect(adapter.createWorktree(wtPath, 'no-such-branch', repo, false)).rejects.toThrow();
    });
  });

  describe('deleteWorktree', () => {
    it('removes a linked worktree', async () => {
      const wtPath = path.join(tmp, 'wt-feat-a'); // created above
      await adapter.deleteWorktree(wtPath, repo);
      expect(fs.existsSync(wtPath)).toBe(false);
      expect(adapter.listWorktrees(repo).map((w) => w.path)).not.toContain(wtPath);
    });

    it('rejects for an unknown worktree path (caller decides to swallow)', async () => {
      await expect(adapter.deleteWorktree(path.join(tmp, 'nope'), repo)).rejects.toThrow();
    });
  });

  describe('deleteBranch', () => {
    it('force-deletes a branch', async () => {
      // feat-b worktree still holds the branch — remove it first
      await adapter.deleteWorktree(path.join(tmp, 'wt-feat-b'), repo);
      expect(adapter.branchExists('feat-b', repo)).toBe(true);
      adapter.deleteBranch('feat-b', repo);
      expect(adapter.branchExists('feat-b', repo)).toBe(false);
    });

    it('throws for a missing branch', () => {
      expect(() => adapter.deleteBranch('no-such-branch', repo)).toThrow();
    });
  });

  describe('branchExists', () => {
    it('returns true for an existing branch', () => {
      expect(adapter.branchExists('main', repo)).toBe(true);
    });

    it('returns false for a missing branch', () => {
      expect(adapter.branchExists('definitely-not-a-branch', repo)).toBe(false);
    });
  });

  describe('currentBranch', () => {
    it('returns the checked-out branch', () => {
      expect(adapter.currentBranch(repo)).toBe('main');
    });

    it('returns "" on detached HEAD', () => {
      const wtPath = path.join(tmp, 'wt-detached-cb');
      git(`worktree add --detach "${wtPath}"`);
      expect(adapter.currentBranch(wtPath)).toBe('');
      git(`worktree remove --force "${wtPath}"`);
    });

    it('throws outside a git repo', () => {
      const notARepo = path.join(tmp, 'not-a-repo-cb');
      fs.mkdirSync(notARepo, { recursive: true });
      expect(() => adapter.currentBranch(notARepo)).toThrow();
    });
  });

  describe('diff', () => {
    it('working: shows tracked modifications vs HEAD', async () => {
      const wtPath = path.join(tmp, 'wt-diff-working');
      git(`worktree add -b diff-working "${wtPath}"`);
      fs.appendFileSync(path.join(wtPath, 'README.md'), 'a new line\n');

      const out = await adapter.diff(wtPath, { base: 'working' });
      expect(out).toContain('README.md');
      expect(out).toContain('+a new line');

      git(`worktree remove --force "${wtPath}"`);
      git('branch -D diff-working');
    });

    it('working: renders untracked files as additions', async () => {
      const wtPath = path.join(tmp, 'wt-diff-untracked');
      git(`worktree add -b diff-untracked "${wtPath}"`);
      fs.writeFileSync(path.join(wtPath, 'brand-new.txt'), 'fresh content\n');

      const out = await adapter.diff(wtPath, { base: 'working' });
      expect(out).toContain('brand-new.txt');
      expect(out).toContain('+fresh content');

      git(`worktree remove --force "${wtPath}"`);
      git('branch -D diff-untracked');
    });

    it('branch: shows only what the branch introduced vs merge-base with main', async () => {
      const wtPath = path.join(tmp, 'wt-diff-branch');
      git(`worktree add -b diff-branch "${wtPath}"`);
      fs.writeFileSync(path.join(wtPath, 'feature.txt'), 'feature body\n');
      git('add .', wtPath);
      git('commit -m "add feature"', wtPath);

      // No mainBranchCandidates → uses the built-in default ['main','master','develop'].
      const out = await adapter.diff(wtPath, { base: 'branch' });
      expect(out).toContain('feature.txt');
      expect(out).toContain('+feature body');
      // README was untouched on this branch — it must not appear.
      expect(out).not.toContain('README.md');

      git(`worktree remove --force "${wtPath}"`);
      git('branch -D diff-branch');
    });

    it('branch: falls back to vs-HEAD when no main-branch candidate resolves', async () => {
      const wtPath = path.join(tmp, 'wt-diff-nomain');
      git(`worktree add -b diff-nomain "${wtPath}"`);
      fs.writeFileSync(path.join(wtPath, 'solo.txt'), 'solo\n');
      git('add .', wtPath);
      git('commit -m "solo"', wtPath);

      // No candidate exists → resolveMainBranch returns undefined → diff HEAD.
      const out = await adapter.diff(wtPath, { base: 'branch', mainBranchCandidates: ['nope-a', 'nope-b'] });
      // vs-HEAD shows nothing committed-but-unstaged; it must not throw and returns a string.
      expect(typeof out).toBe('string');

      // A working change now shows up (proving the HEAD fallback ran).
      fs.appendFileSync(path.join(wtPath, 'solo.txt'), 'more\n');
      const out2 = await adapter.diff(wtPath, { base: 'branch', mainBranchCandidates: ['nope'] });
      expect(out2).toContain('+more');

      git(`worktree remove --force "${wtPath}"`);
      git('branch -D diff-nomain');
    });

    it('returns "" outside a git repo', async () => {
      const notARepo = path.join(tmp, 'not-a-repo-diff');
      fs.mkdirSync(notARepo, { recursive: true });
      expect(await adapter.diff(notARepo, { base: 'working' })).toBe('');
    });
  });
});

describe('NodeFileSystem (integration, temp dir)', () => {
  const nfs = new NodeFileSystem();

  it('exists reflects the real filesystem', () => {
    expect(nfs.exists(path.join(tmp, 'missing-file'))).toBe(false);
    expect(nfs.exists(repo)).toBe(true);
  });

  it('mkdir creates nested directories recursively (idempotent)', () => {
    const nested = path.join(tmp, 'a', 'b', 'c');
    nfs.mkdir(nested);
    nfs.mkdir(nested); // no throw on existing
    expect(fs.statSync(nested).isDirectory()).toBe(true);
  });

  it('writeFile + readFile round-trips utf8 content', () => {
    const p = path.join(tmp, 'roundtrip.txt');
    nfs.writeFile(p, 'héllo wörld');
    expect(nfs.readFile(p)).toBe('héllo wörld');
  });

  it('writeFile applies the given mode', () => {
    const p = path.join(tmp, 'script.sh');
    nfs.writeFile(p, '#!/bin/sh\n', { mode: 0o755 });
    expect(fs.statSync(p).mode & 0o777).toBe(0o755);
  });

  it('readFile throws for a missing file', () => {
    expect(() => nfs.readFile(path.join(tmp, 'nope.txt'))).toThrow();
  });
});

describe('NodeProcessRunner (integration)', () => {
  const runner = new NodeProcessRunner();

  it('resolves with trimmed stdout', async () => {
    await expect(runner.exec("printf 'hi\\n'")).resolves.toBe('hi');
  });

  it('respects cwd', async () => {
    await expect(runner.exec('pwd', { cwd: repo })).resolves.toBe(repo);
  });

  it('passes env vars', async () => {
    const out = await runner.exec('echo "$UNMESS_TEST_VAR"', {
      env: { ...process.env, UNMESS_TEST_VAR: 'val-42' },
    });
    expect(out).toBe('val-42');
  });

  it('rejects on non-zero exit', async () => {
    await expect(runner.exec('exit 3')).rejects.toThrow();
  });
});
