import { describe, it, expect } from 'vitest';
import { detect, type DetectIo } from '../../src/settings/detect';

/** In-memory repo: `files` maps repo-relative paths to contents. */
function repo(files: Record<string, string>): DetectIo {
  const abs = (p: string) => p.replace(/^\/repo\/?/, '');
  return {
    readdir: (dir) => (dir === '/repo' ? [...new Set(Object.keys(files).map((f) => f.split('/')[0]))] : []),
    exists: (p) => abs(p) in files,
    read: (p) => { const k = abs(p); if (!(k in files)) throw new Error('ENOENT'); return files[k]; },
  };
}

describe('detect', () => {
  it('finds compose files at the root, base file before overrides', () => {
    const d = detect('/repo', repo({
      'docker-compose.worktree.yml': '',
      'docker-compose.yml': '',
      'compose.prod.yaml': '',
      'README.md': '',
    }));
    expect(d.composeFiles).toEqual(['docker-compose.yml', 'compose.prod.yaml', 'docker-compose.worktree.yml']);
  });

  it('collects port-like env vars across compose files, in every shell spelling, deduplicated', () => {
    const d = detect('/repo', repo({
      'docker-compose.yml': 'ports:\n  - "${HTTP_PORT}:80"\n  - "${DB_PORT:-5432}:5432"\nimage: ${IMAGE_TAG}\n',
      'docker-compose.worktree.yml': 'ports:\n  - "$HTTP_PORT:80"\n  - "${DEBUG_PORT-9003}:9003"\n',
    }));
    expect(d.portVars).toEqual(['HTTP_PORT', 'DB_PORT', 'DEBUG_PORT']);
  });

  it('keeps going when a compose file cannot be read', () => {
    const io = repo({ 'docker-compose.yml': '${HTTP_PORT}' });
    const broken: DetectIo = { ...io, read: (p) => { if (p.endsWith('docker-compose.yml')) throw new Error('EACCES'); return io.read(p); } };
    expect(detect('/repo', broken).portVars).toEqual([]);
  });

  it.each([
    [{ 'composer.json': '{}', 'package.json': '{}' }, 'php'],
    [{ 'package.json': '{}' }, 'node'],
    [{ 'pyproject.toml': '' }, 'python'],
    [{ 'requirements.txt': '' }, 'python'],
    [{ 'go.mod': '' }, 'go'],
    [{ 'README.md': '' }, undefined],
  ])('names the stack from %o → %s (PHP wins over the package.json it ships with)', (files, stack) => {
    expect(detect('/repo', repo(files as Record<string, string>)).stack).toBe(stack);
  });

  it('points at an existing setup/teardown script, preferring .unmess/', () => {
    const d = detect('/repo', repo({ '.unmess/setup.sh': '', 'scripts/setup.sh': '', 'teardown.sh': '' }));
    expect(d.setupScript).toBe('.unmess/setup.sh');
    expect(d.teardownScript).toBe('teardown.sh');
  });

  it('returns an empty detection for an unreadable root', () => {
    const io: DetectIo = { readdir: () => { throw new Error('ENOENT'); }, exists: () => false, read: () => '' };
    expect(detect('/nope', io)).toEqual({ composeFiles: [], portVars: [], stack: undefined, setupScript: undefined, teardownScript: undefined });
  });
});
