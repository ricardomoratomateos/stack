import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  computeDockerPorts, dockerPortsFor, portBlockFor, composeArgv, composeProject, dockerEnv,
  legacyComposeProjects, normalizeProjectName, composeScriptEnv, dockerConfigured,
} from '../../src/docker/dockerCompose';
import type { ForemanConfig, Worktree } from '../../src/types';

function makeConfig(over: Partial<ForemanConfig['docker']> = {}): ForemanConfig {
  return {
    worktreesDirectory: './zer',
    setupScript: '',
    teardownScript: '',
    defaultProvider: 'claude',
    claudeCommand: 'claude',
    opencodeCommand: 'opencode',
    notifyOnAttention: true,
    scopeSearchToActiveWorktree: true,
    docker: {
      composeFile: 'docker-compose.yml',
      overrideFile: 'docker-compose.worktree.yml',
      ports: ['HTTP_PORT', 'DB_PORT', 'DEBUG_PORT'],
      basePort: 20000,
      portStride: 100,
      ...over,
    },
    debugBasePort: 9898,
    debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
  };
}

function makeWorktree(over: Partial<Worktree> = {}): Worktree {
  return {
    id: 'a',
    branch: 'feat/a',
    path: '/repo/zer/feat-a',
    repoRoot: '/repo',
    debugPort: 9899, // slot 0
    dockerProjectName: 'feat-a',
    createdAt: 1,
    ...over,
  };
}

describe('computeDockerPorts', () => {
  it('assigns block ports by slot (derived from debugPort) and index', () => {
    // slot 0 -> block base 20000; DEBUG_PORT reuses the worktree debug port
    expect(computeDockerPorts(makeWorktree({ debugPort: 9899 }), makeConfig())).toEqual({
      HTTP_PORT: 20000,
      DB_PORT: 20001,
      DEBUG_PORT: 9899,
    });
  });

  it('shifts the whole block by portStride for the next worktree slot', () => {
    // debugPort 9900 -> slot 1 -> block base 20100
    expect(computeDockerPorts(makeWorktree({ debugPort: 9900 }), makeConfig())).toEqual({
      HTTP_PORT: 20100,
      DB_PORT: 20101,
      DEBUG_PORT: 9900,
    });
  });

  it('honours a custom basePort and stride', () => {
    const cfg = makeConfig({ basePort: 30000, portStride: 10, ports: ['A', 'B'] });
    expect(computeDockerPorts(makeWorktree({ debugPort: 9901 }), cfg)).toEqual({ A: 30020, B: 30021 });
  });

  it('returns an empty map when no ports are configured', () => {
    expect(computeDockerPorts(makeWorktree(), makeConfig({ ports: [] }))).toEqual({});
  });

  it('clamps a below-base debug port to slot 0 (defensive)', () => {
    expect(computeDockerPorts(makeWorktree({ debugPort: 0 }), makeConfig({ ports: ['HTTP_PORT'] }))).toEqual({
      HTTP_PORT: 20000,
    });
  });
});

describe('normalizeProjectName', () => {
  it.each([
    ['AS-6876', 'as-6876'],
    ['Feat Bar!', 'featbar'],
    ['_-leading', 'leading'],
    ['my_app.v2', 'my_appv2'],
    ['---', ''],
  ])('mirrors compose: %s → %s', (input, out) => {
    expect(normalizeProjectName(input)).toBe(out);
  });
});

describe('composeProject', () => {
  it('is the normalised basename plus a short, stable hash of the repo root', () => {
    const name = composeProject(makeWorktree({ path: '/repo/zer/AS-6876' }));
    expect(name).toMatch(/^as-6876-[0-9a-f]{6}$/);
    expect(composeProject(makeWorktree({ path: '/repo/zer/AS-6876' }))).toBe(name);
  });

  it('differs between two repositories with a worktree for the same branch', () => {
    // The basename alone collided: `down` in one repo removed the other's stack.
    const a = composeProject(makeWorktree({ path: '/one/.worktrees/feat-x', repoRoot: '/one' }));
    const b = composeProject(makeWorktree({ path: '/two/.worktrees/feat-x', repoRoot: '/two' }));
    expect(a).not.toBe(b);
    expect(a.startsWith('feat-x-')).toBe(true);
  });

  it('never starts with "-" or "_", which compose rejects', () => {
    expect(composeProject(makeWorktree({ path: '/repo/zer/-wip' }))).toMatch(/^wip-/);
    expect(composeProject(makeWorktree({ path: '/repo/zer/!!!' }))).toMatch(/^worktree-[0-9a-f]{6}$/);
  });

  it('keeps compose\'s own default for the main checkout, which Foreman runs plain', () => {
    expect(composeProject(makeWorktree({ path: '/x/My Repo', isMain: true }))).toBe('myrepo');
  });
});

describe('legacyComposeProjects', () => {
  it('lists the names an older Foreman (or a plain `compose up`) used for this worktree', () => {
    expect(legacyComposeProjects(makeWorktree({ path: '/x/Feat Bar!' }))).toEqual(['feat-bar-', 'featbar']);
  });

  it('deduplicates when both spellings agree', () => {
    expect(legacyComposeProjects(makeWorktree({ path: '/repo/zer/feat-a' }))).toEqual(['feat-a']);
  });

  it('drops names that normalise to nothing', () => {
    expect(legacyComposeProjects(makeWorktree({ path: '/repo/zer/__' }))).toEqual(['__']);
  });

  it('has none for the main checkout, whose name never changed', () => {
    expect(legacyComposeProjects(makeWorktree({ isMain: true }))).toEqual([]);
  });
});

describe('composeArgv', () => {
  const wt = makeWorktree();
  const project = composeProject(wt);

  it('pins the project and the project directory, and layers the override', () => {
    expect(composeArgv(wt, { base: '/repo/base.yml', override: '/repo/over.yml' }, ['up', '-d'])).toEqual([
      'compose', '-p', project, '--project-directory', '/repo/zer/feat-a',
      '-f', '/repo/base.yml', '-f', '/repo/over.yml', 'up', '-d',
    ]);
  });

  it('runs just the base file when there is no override', () => {
    expect(composeArgv(wt, { base: '/repo/base.yml' }, ['up', '-d'])).toEqual([
      'compose', '-p', project, '--project-directory', '/repo/zer/feat-a', '-f', '/repo/base.yml', 'up', '-d',
    ]);
  });

  it('can address a stack by name alone, under a legacy name', () => {
    expect(composeArgv(wt, undefined, ['down'], 'feat-a')).toEqual([
      'compose', '-p', 'feat-a', '--project-directory', '/repo/zer/feat-a', 'down',
    ]);
  });

  it('never pins or layers for the main repo (it uses its own stack)', () => {
    expect(composeArgv(makeWorktree({ isMain: true }), { base: '/repo/base.yml' }, ['down'])).toEqual(['compose', 'down']);
  });
});

describe('composeScriptEnv', () => {
  it('exports the project, the files (platform separator) and the ports to scripts', () => {
    const wt = makeWorktree();
    expect(composeScriptEnv(wt, makeConfig(), { base: '/r/a.yml', override: '/r/b.yml' })).toEqual({
      COMPOSE_PROJECT_NAME: composeProject(wt),
      COMPOSE_FILE: ['/r/a.yml', '/r/b.yml'].join(path.delimiter),
      HTTP_PORT: '20000',
      DB_PORT: '20001',
      DEBUG_PORT: '9899',
    });
  });

  it('takes an explicit project (a legacy stack still running) and a lone base file', () => {
    expect(composeScriptEnv(makeWorktree(), makeConfig(), { base: '/r/a.yml' }, 'feat-a')).toMatchObject({
      COMPOSE_PROJECT_NAME: 'feat-a',
      COMPOSE_FILE: '/r/a.yml',
    });
  });

  it('is empty for the main checkout and when docker is not configured', () => {
    expect(composeScriptEnv(makeWorktree({ isMain: true }), makeConfig(), { base: '/r/a.yml' })).toEqual({});
    expect(composeScriptEnv(makeWorktree(), makeConfig({ ports: [] }), { base: '/r/a.yml' })).toEqual({});
  });
});

describe('dockerConfigured', () => {
  it('is on with at least one port', () => {
    expect(dockerConfigured(makeConfig())).toBe(true);
    expect(dockerConfigured(makeConfig({ ports: [] }))).toBe(false);
  });
});

describe('dockerEnv', () => {
  it('stringifies the computed ports for a worktree', () => {
    expect(dockerEnv(makeWorktree({ debugPort: 9899 }), makeConfig())).toEqual({
      HTTP_PORT: '20000',
      DB_PORT: '20001',
      DEBUG_PORT: '9899',
    });
  });

  it('injects nothing for the main repo (it uses its own stack)', () => {
    expect(dockerEnv(makeWorktree({ isMain: true }), makeConfig())).toEqual({});
  });
});

describe('dockerPortsFor', () => {
  it('derives the same mapping as computeDockerPorts, keyed by the debug port alone', () => {
    // The allocator has to validate a slot before a worktree exists to hold it;
    // the two must never drift apart on which ports a slot owns.
    const config = makeConfig();
    const worktree = makeWorktree({ debugPort: 9901 });
    expect(dockerPortsFor(9901, config)).toEqual(computeDockerPorts(worktree, config));
  });
});

describe('portBlockFor', () => {
  it('lists every distinct port a slot will bind', () => {
    expect(portBlockFor(9901, makeConfig())).toEqual([9901, 20200, 20201]);
  });

  it('does not repeat the debug port, which DEBUG_PORT maps back onto', () => {
    const block = portBlockFor(9901, makeConfig());
    expect(block.filter((p) => p === 9901)).toHaveLength(1);
  });

  it('still covers the debug port when no docker ports are configured', () => {
    // VSCode's debug listener binds it even with docker orchestration off, so a
    // block of nothing would let two worktrees share one debug port.
    expect(portBlockFor(9901, makeConfig({ ports: [] }))).toEqual([9901]);
  });
});
