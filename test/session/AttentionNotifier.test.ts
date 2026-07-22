import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, resetVscodeMock } from 'vscode';
import { AttentionNotifier, StateChange, AttentionNotifierDeps } from '../../src/session/AttentionNotifier';

// ── harness ──────────────────────────────────────────────────────────────────

function makeHarness(overrides: Partial<AttentionNotifierDeps> = {}) {
  const emitter = new EventEmitter<StateChange>();
  const deps = {
    onStateChange: emitter.event,
    labelFor: vi.fn((id: string) => (id === 'wt1' ? 'feature-x' : undefined)),
    sessionTitle: vi.fn((): string | undefined => undefined),
    isWatching: vi.fn(() => false),
    enabled: vi.fn(() => true),
    notify: vi.fn(),
    ...overrides,
  };
  const notifier = new AttentionNotifier(deps);
  const counts: number[] = [];
  notifier.onAttentionChange((c) => counts.push(c));
  return { emitter, deps, notifier, counts };
}

beforeEach(() => {
  resetVscodeMock();
});

// ─────────────────────────────────────────────────────────────────────────────
// notification triggers
// ─────────────────────────────────────────────────────────────────────────────

describe('notification triggers', () => {
  it('does not notify on the first observed state (launch/reconnect baseline)', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'permission' });
    // permission after a known baseline DOES notify — only the very first event is silent
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('notifies when the agent finishes (active → waiting)', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    expect(h.deps.notify).toHaveBeenCalledWith('feature-x: agent finished and is waiting for you');
  });

  it('notifies when the agent asks for permission', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'permission' });
    expect(h.deps.notify).toHaveBeenCalledWith('feature-x: agent is asking for permission');
  });

  it('notifies on waiting after permission (agent stopped while a request pended)', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'permission' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    expect(h.deps.notify).toHaveBeenCalledTimes(2);
  });

  it('does not notify on waiting unless the agent was just working (idle → waiting)', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'idle' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it('does not notify on repeated identical states', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('does not notify while the user is watching the session', () => {
    const h = makeHarness({ isWatching: vi.fn(() => true) });
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.notifier.attentionCount()).toBe(0);
  });

  it('clears an existing badge when a state change arrives while the user is watching', () => {
    let watching = false;
    const h = makeHarness({ isWatching: () => watching });
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'permission' }); // not watching yet → badge 1
    expect(h.notifier.attentionCount()).toBe(1);
    watching = true;
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' }); // now watching → cleared
    expect(h.notifier.attentionCount()).toBe(0);
  });

  it('keeps the badge but skips the notification when disabled', () => {
    const h = makeHarness({ enabled: vi.fn(() => false) });
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.notifier.attentionCount()).toBe(1);
  });

  it('falls back to the worktree id when no label resolves', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt2', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt2', state: 'waiting' });
    expect(h.deps.notify).toHaveBeenCalledWith('wt2: agent finished and is waiting for you');
  });

  it('appends the live session title when the triggering window is known', () => {
    const h = makeHarness({ sessionTitle: vi.fn(() => 'Wants to run Bash: npm test') });
    h.emitter.fire({ worktreeId: 'wt1', state: 'active', windowIndex: 2 });
    h.emitter.fire({ worktreeId: 'wt1', state: 'permission', windowIndex: 2 });
    expect(h.deps.sessionTitle).toHaveBeenCalledWith('wt1', 2);
    expect(h.deps.notify).toHaveBeenCalledWith(
      'feature-x: agent is asking for permission — Wants to run Bash: npm test',
    );
  });

  it('omits the title when the window has none, and never asks without a window index', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active', windowIndex: 2 });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting', windowIndex: 2 });
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'permission' });
    expect(h.deps.notify).toHaveBeenNthCalledWith(1, 'feature-x: agent finished and is waiting for you');
    expect(h.deps.notify).toHaveBeenNthCalledWith(2, 'feature-x: agent is asking for permission');
    expect(h.deps.sessionTitle).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// attention count / badge
// ─────────────────────────────────────────────────────────────────────────────

describe('attention count', () => {
  it('counts each worktree once and emits on change', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt2', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    h.emitter.fire({ worktreeId: 'wt2', state: 'permission' });
    expect(h.notifier.attentionCount()).toBe(2);
    expect(h.counts).toEqual([1, 2]);
  });

  it('does not re-emit when an already-flagged worktree needs attention again', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'permission' });
    expect(h.deps.notify).toHaveBeenCalledTimes(2);
    expect(h.counts).toEqual([1]);
  });

  it('clears the flag when the agent becomes active again', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    expect(h.notifier.attentionCount()).toBe(0);
    expect(h.counts).toEqual([1, 0]);
  });

  it('clears the flag when the session terminates', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'permission' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'terminated' });
    expect(h.notifier.attentionCount()).toBe(0);
  });

  it('acknowledge clears the flag and emits; a second acknowledge is a no-op', () => {
    const h = makeHarness();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    h.notifier.acknowledge('wt1');
    h.notifier.acknowledge('wt1');
    expect(h.counts).toEqual([1, 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dispose
// ─────────────────────────────────────────────────────────────────────────────

describe('dispose', () => {
  it('stops reacting to state changes after dispose', () => {
    const h = makeHarness();
    h.notifier.dispose();
    h.emitter.fire({ worktreeId: 'wt1', state: 'active' });
    h.emitter.fire({ worktreeId: 'wt1', state: 'waiting' });
    expect(h.deps.notify).not.toHaveBeenCalled();
    expect(h.counts).toEqual([]);
  });
});
