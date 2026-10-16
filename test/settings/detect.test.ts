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

  it('suggests the base file, and an override only when its name says so', () => {
    const d = detect('/repo', repo({ 'docker-compose.yml': '', 'compose.prod.yaml': '', 'docker-compose.worktree.yml': '' }));
    expect(d.composeBase).toBe('docker-compose.yml');
    expect(d.composeOverride).toBe('docker-compose.worktree.yml');
    // Taking "the second file" made compose.prod.yaml the worktree override.
    expect(detect('/repo', repo({ 'docker-compose.yml': '', 'compose.prod.yaml': '' })).composeOverride).toBeUndefined();
  });

  it('suggests nothing when there are no compose files', () => {
    const d = detect('/repo', repo({ 'README.md': '' }));
    expect(d.composeBase).toBeUndefined();
    expect(d.composeOverride).toBeUndefined();
  });

  describe('compose files outside the root', () => {
    /** Directory-aware in-memory tree: any prefix of a file path is a directory. */
    function tree(files: Record<string, string>): DetectIo {
      const rel = (p: string) => p.replace(/^\/repo\/?/, '');
      return {
        readdir: (dir) => {
          const prefix = rel(dir) ? `${rel(dir)}/` : '';
          const children = Object.keys(files).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split('/')[0]);
          if (children.length === 0) throw new Error('ENOTDIR');
          return [...new Set(children)];
        },
        exists: (p) => rel(p) in files,
        read: (p) => files[rel(p)] ?? '',
      };
    }

    it('finds them in the usual folders, up to two levels down, root ones first', () => {
      const d = detect('/repo', tree({
        'docker/docker-compose.yml': '"${DB_PORT}:5432"',
        'deploy/local/compose.yaml': '',
        '.docker/compose.override.yml': '',
        'docker-compose.yml': '',
        'deploy/a/b/compose.yml': '', // three levels: too deep
        'src/docker-compose.yml': '', // not a compose folder
        'node_modules/x/docker-compose.yml': '',
      }));
      expect(d.composeFiles).toEqual([
        'docker-compose.yml',
        'docker/docker-compose.yml',
        '.docker/compose.override.yml',
        'deploy/local/compose.yaml',
      ]);
      expect(d.portVars).toEqual(['DB_PORT']);
    });

    it('pairs a subfolder base with the override beside it', () => {
      const d = detect('/repo', tree({ 'docker/compose.yml': '', 'docker/compose.worktree.yml': '' }));
      expect(d.composeBase).toBe('docker/compose.yml');
      expect(d.composeOverride).toBe('docker/compose.worktree.yml');
    });

    it('falls back to the first file when every one is qualified', () => {
      expect(detect('/repo', tree({ 'compose.dev.yml': '' })).composeBase).toBe('compose.dev.yml');
    });
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

  it('points at an existing setup/teardown script, preferring .foreman/', () => {
    const d = detect('/repo', repo({ '.foreman/setup.sh': '', 'scripts/setup.sh': '', 'teardown.sh': '' }));
    expect(d.setupScript).toBe('.foreman/setup.sh');
    expect(d.teardownScript).toBe('teardown.sh');
  });

  it('returns an empty detection for an unreadable root', () => {
    const io: DetectIo = { readdir: () => { throw new Error('ENOENT'); }, exists: () => false, read: () => '' };
    expect(detect('/nope', io)).toEqual({ composeFiles: [], portVars: [], stack: undefined, setupScript: undefined, teardownScript: undefined });
  });
});
