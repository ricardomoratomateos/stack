import { describe, it, expect, beforeEach } from 'vitest';
import { BreakpointManager } from '../../src/worktree/BreakpointManager';
import {
  FakeMemento,
  Uri,
  Position,
  Location,
  SourceBreakpoint,
  FunctionBreakpoint,
  debug,
  resetVscodeMock,
} from '../__mocks__/vscode';

const WORKTREES = [
  { id: 'main', path: '/repo' },
  { id: 'a', path: '/repo/zer/feat-a' },
  { id: 'b', path: '/repo/zer/feat-b' },
];

function bp(fsPath: string, line = 10, enabled = true): SourceBreakpoint {
  return new SourceBreakpoint(new Location(Uri.file(fsPath), new Position(line, 0)), enabled);
}

function fsPaths(): string[] {
  return (debug.breakpoints as SourceBreakpoint[])
    .filter((b) => b instanceof SourceBreakpoint)
    .map((b) => b.location.uri.fsPath);
}

let memento: FakeMemento;

beforeEach(() => {
  resetVscodeMock();
  memento = new FakeMemento();
});

describe('BreakpointManager.activate', () => {
  it('stashes other worktrees\' breakpoints, keeping the target\'s and unowned ones', () => {
    debug.breakpoints = [
      bp('/repo/zer/feat-a/x.php'),   // worktree a
      bp('/repo/zer/feat-b/y.php'),   // worktree b (target)
      bp('/opt/outside/z.php'),       // owned by no worktree
    ];
    const mgr = new BreakpointManager(memento as never, () => WORKTREES);

    mgr.activate('b', WORKTREES);

    expect(fsPaths().sort()).toEqual(['/opt/outside/z.php', '/repo/zer/feat-b/y.php']);
    expect(mgr.getStashed('a').map((s) => s.uri)).toEqual(['/repo/zer/feat-a/x.php']);
  });

  it('restores the target worktree\'s previously stashed breakpoints', () => {
    debug.breakpoints = [bp('/repo/zer/feat-a/x.php')];
    const mgr = new BreakpointManager(memento as never, () => WORKTREES);

    mgr.activate('b', WORKTREES);              // stash a
    expect(fsPaths()).toEqual([]);
    mgr.activate('a', WORKTREES);              // restore a
    expect(fsPaths()).toEqual(['/repo/zer/feat-a/x.php']);
    expect(mgr.getStashed('a')).toEqual([]);   // no longer stashed
  });

  it('round-trips condition/enabled/hitCondition/logMessage through the stash', () => {
    const b = new SourceBreakpoint(
      new Location(Uri.file('/repo/zer/feat-a/x.php'), new Position(4, 2)),
      false, 'x > 1', '>=3', 'hit',
    );
    debug.breakpoints = [b];
    const mgr = new BreakpointManager(memento as never, () => WORKTREES);

    mgr.activate('b', WORKTREES);              // stash a
    mgr.activate('a', WORKTREES);              // restore a

    const restored = (debug.breakpoints[0] as SourceBreakpoint);
    expect(restored.location.range.start.line).toBe(4);
    expect(restored.location.range.start.character).toBe(2);
    expect(restored.enabled).toBe(false);
    expect(restored.condition).toBe('x > 1');
    expect(restored.hitCondition).toBe('>=3');
    expect(restored.logMessage).toBe('hit');
  });

  it('never stashes function breakpoints (no file)', () => {
    debug.breakpoints = [new FunctionBreakpoint('doThing'), bp('/repo/zer/feat-a/x.php')];
    const mgr = new BreakpointManager(memento as never, () => WORKTREES);

    mgr.activate('b', WORKTREES);

    expect(debug.breakpoints.some((b) => b instanceof FunctionBreakpoint)).toBe(true);
    expect(fsPaths()).toEqual([]); // only the function breakpoint remains
  });

  it('is a no-op when there are no worktrees', () => {
    debug.breakpoints = [bp('/repo/zer/feat-a/x.php')];
    const mgr = new BreakpointManager(memento as never, () => []);
    mgr.activate('a', []);
    expect(fsPaths()).toEqual(['/repo/zer/feat-a/x.php']);
  });

  it('persists the stash to globalState and restores it on reconstruction', () => {
    debug.breakpoints = [bp('/repo/zer/feat-a/x.php', 7)];
    new BreakpointManager(memento as never, () => WORKTREES).activate('b', WORKTREES);

    // A fresh manager (e.g. after reload) sees the persisted stash.
    const revived = new BreakpointManager(memento as never, () => WORKTREES);
    expect(revived.getStashed('a').map((s) => ({ uri: s.uri, line: s.line }))).toEqual([
      { uri: '/repo/zer/feat-a/x.php', line: 7 },
    ]);
  });

  it('defaults the worktree list to the getter when omitted', () => {
    debug.breakpoints = [bp('/repo/zer/feat-a/x.php')];
    const mgr = new BreakpointManager(memento as never, () => WORKTREES);
    mgr.activate('b'); // no explicit list
    expect(fsPaths()).toEqual([]);
  });
});
