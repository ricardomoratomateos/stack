import { describe, it, expect } from 'vitest';
import { computeDockerPorts, dockerPortsFor, portBlockFor, buildComposeArgs, composeProject, dockerEnv } from '../../src/docker/dockerCompose';
import type { UnmessConfig, Worktree } from '../../src/types';

function makeConfig(over: Partial<UnmessConfig['docker']> = {}): UnmessConfig {
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
      ports: ['HTTP_PORT', 'DB_PORT', 'XDEBUG_PORT'],
      basePort: 20000,
      portStride: 100,
      ...over,
    },
    xdebugBasePort: 9898,
    debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
  };
}

function makeWorktree(over: Partial<Worktree> = {}): Worktree {
  return {
    id: 'a',
    branch: 'feat/a',
    path: '/repo/zer/feat-a',
    repoRoot: '/repo',
    xdebugPort: 9899, // slot 0
    dockerProjectName: 'feat-a',
    createdAt: 1,
    ...over,
  };
}

describe('computeDockerPorts', () => {
  it('assigns block ports by slot (derived from xdebugPort) and index', () => {
    // slot 0 -> block base 20000; XDEBUG_PORT reuses the worktree xdebug port
    expect(computeDockerPorts(makeWorktree({ xdebugPort: 9899 }), makeConfig())).toEqual({
      HTTP_PORT: 20000,
      DB_PORT: 20001,
      XDEBUG_PORT: 9899,
    });
  });

  it('shifts the whole block by portStride for the next worktree slot', () => {
    // xdebugPort 9900 -> slot 1 -> block base 20100
    expect(computeDockerPorts(makeWorktree({ xdebugPort: 9900 }), makeConfig())).toEqual({
      HTTP_PORT: 20100,
      DB_PORT: 20101,
      XDEBUG_PORT: 9900,
    });
  });

  it('honours a custom basePort and stride', () => {
    const cfg = makeConfig({ basePort: 30000, portStride: 10, ports: ['A', 'B'] });
    expect(computeDockerPorts(makeWorktree({ xdebugPort: 9901 }), cfg)).toEqual({ A: 30020, B: 30021 });
  });

  it('returns an empty map when no ports are configured', () => {
    expect(computeDockerPorts(makeWorktree(), makeConfig({ ports: [] }))).toEqual({});
  });

  it('clamps a below-base xdebug port to slot 0 (defensive)', () => {
    expect(computeDockerPorts(makeWorktree({ xdebugPort: 0 }), makeConfig({ ports: ['HTTP_PORT'] }))).toEqual({
      HTTP_PORT: 20000,
    });
  });
});

describe('composeProject', () => {
  it('uses the worktree directory basename, sanitized', () => {
    expect(composeProject(makeWorktree({ path: '/repo/zer/AS-6876' }))).toBe('as-6876');
    expect(composeProject(makeWorktree({ path: '/x/Feat Bar!' }))).toBe('feat-bar-');
  });
});

describe('buildComposeArgs', () => {
  it('pins the project (-p) and layers the override file when one is given', () => {
    expect(buildComposeArgs(makeWorktree(), '/repo/.unmess/base.yml', '/repo/.unmess/override.yml', 'up -d')).toBe(
      '-p "feat-a" -f "/repo/.unmess/base.yml" -f "/repo/.unmess/override.yml" up -d',
    );
  });

  it('pins the project and runs just the composeFile when no override is given', () => {
    expect(buildComposeArgs(makeWorktree(), '/repo/.unmess/base.yml', undefined, 'up -d')).toBe(
      '-p "feat-a" -f "/repo/.unmess/base.yml" up -d',
    );
  });

  it('never pins or layers for the main repo (it uses its own stack)', () => {
    expect(buildComposeArgs(makeWorktree({ isMain: true }), '/repo/base.yml', '/repo/override.yml', 'down')).toBe('down');
  });
});

describe('dockerEnv', () => {
  it('stringifies the computed ports for a worktree', () => {
    expect(dockerEnv(makeWorktree({ xdebugPort: 9899 }), makeConfig())).toEqual({
      HTTP_PORT: '20000',
      DB_PORT: '20001',
      XDEBUG_PORT: '9899',
    });
  });

  it('injects nothing for the main repo (it uses its own stack)', () => {
    expect(dockerEnv(makeWorktree({ isMain: true }), makeConfig())).toEqual({});
  });
});

describe('dockerPortsFor', () => {
  it('derives the same mapping as computeDockerPorts, keyed by the xdebug port alone', () => {
    // The allocator has to validate a slot before a worktree exists to hold it;
    // the two must never drift apart on which ports a slot owns.
    const config = makeConfig();
    const worktree = makeWorktree({ xdebugPort: 9901 });
    expect(dockerPortsFor(9901, config)).toEqual(computeDockerPorts(worktree, config));
  });
});

describe('portBlockFor', () => {
  it('lists every distinct port a slot will bind', () => {
    expect(portBlockFor(9901, makeConfig())).toEqual([9901, 20200, 20201]);
  });

  it('does not repeat the xdebug port, which XDEBUG_PORT maps back onto', () => {
    const block = portBlockFor(9901, makeConfig());
    expect(block.filter((p) => p === 9901)).toHaveLength(1);
  });

  it('still covers the xdebug port when no docker ports are configured', () => {
    // VSCode's debug listener binds it even with docker orchestration off, so a
    // block of nothing would let two worktrees share one Xdebug port.
    expect(portBlockFor(9901, makeConfig({ ports: [] }))).toEqual([9901]);
  });
});
