import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrMonitor, parsePrListOutput, defaultRunner } from '../../src/pr/PrMonitor';
import type { IProcessRunner } from '../../src/ports/IProcessRunner';

const FIVE_MIN = 5 * 60 * 1000;

function makeRunner(stdout = ''): IProcessRunner & { exec: ReturnType<typeof vi.fn> } {
  return { exec: vi.fn().mockResolvedValue(stdout) };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const OPEN_PR = JSON.stringify([{ number: 42, state: 'OPEN', url: 'https://github.com/o/r/pull/42' }]);

describe('parsePrListOutput (parsePr)', () => {
  it('maps an OPEN PR', () => {
    expect(parsePrListOutput(OPEN_PR)).toEqual({
      number: 42,
      state: 'OPEN',
      url: 'https://github.com/o/r/pull/42',
    });
  });

  it('passes MERGED / CLOSED states through unchanged', () => {
    expect(parsePrListOutput('[{"number":1,"state":"MERGED","url":"u"}]'))
      .toEqual({ number: 1, state: 'MERGED', url: 'u' });
    expect(parsePrListOutput('[{"number":2,"state":"CLOSED","url":"u2"}]'))
      .toEqual({ number: 2, state: 'CLOSED', url: 'u2' });
  });

  it('does NOT distinguish drafts — state string is passed through as-is', () => {
    // gh is only asked for number,state,url; a draft PR reports state OPEN and
    // any unexpected state string is cast, not validated
    expect(parsePrListOutput('[{"number":3,"state":"DRAFT","url":"u3"}]'))
      .toEqual({ number: 3, state: 'DRAFT', url: 'u3' });
  });

  it('takes the FIRST PR when several match the branch', () => {
    const out = JSON.stringify([
      { number: 1, state: 'OPEN', url: 'first' },
      { number: 2, state: 'CLOSED', url: 'second' },
    ]);
    expect(parsePrListOutput(out)).toEqual({ number: 1, state: 'OPEN', url: 'first' });
  });

  it('returns null when there is no PR for the branch (empty array)', () => {
    expect(parsePrListOutput('[]')).toBeNull();
  });

  it('returns null on empty / whitespace-only output', () => {
    expect(parsePrListOutput('')).toBeNull();
    expect(parsePrListOutput('  \n ')).toBeNull();
  });

  it('returns null on unparseable output', () => {
    expect(parsePrListOutput('not json at all')).toBeNull();
    expect(parsePrListOutput('[{"number":')).toBeNull();
  });

  it('returns null on parseable-but-not-a-PR-array JSON', () => {
    expect(parsePrListOutput('{}')).toBeNull();   // .length undefined
    expect(parsePrListOutput('null')).toBeNull(); // throws, caught
  });
});

describe('PrMonitor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('getStatus returns undefined for an unknown worktree', () => {
    const monitor = new PrMonitor(makeRunner());
    expect(monitor.getStatus('nope')).toBeUndefined();
  });

  it('startPolling immediately runs gh pr list with the quoted branch and a 15s timeout', async () => {
    const runner = makeRunner(OPEN_PR);
    const monitor = new PrMonitor(runner);

    monitor.startPolling('feat/x', 'wt1', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.exec).toHaveBeenCalledTimes(1);
    expect(runner.exec).toHaveBeenCalledWith(
      'gh pr list --head "feat/x" --json number,state,url',
      { timeout: 15000 },
    );
    expect(monitor.getStatus('wt1')).toEqual({
      number: 42, state: 'OPEN', url: 'https://github.com/o/r/pull/42',
    });
  });

  it('polls every 5 minutes via a setTimeout chain', async () => {
    const runner = makeRunner(OPEN_PR);
    const monitor = new PrMonitor(runner);

    monitor.startPolling('feat/x', 'wt1', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.exec).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FIVE_MIN - 1);
    expect(runner.exec).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runner.exec).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(runner.exec).toHaveBeenCalledTimes(3);
  });

  it('fires the callback only when the status actually changes', async () => {
    const runner = makeRunner(OPEN_PR);
    const monitor = new PrMonitor(runner);
    const callback = vi.fn();

    monitor.startPolling('feat/x', 'wt1', callback);
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1); // undefined -> OPEN

    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(callback).toHaveBeenCalledTimes(1); // OPEN -> OPEN (same JSON): no fire

    runner.exec.mockResolvedValue('[{"number":42,"state":"MERGED","url":"https://github.com/o/r/pull/42"}]');
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(callback).toHaveBeenCalledTimes(2); // OPEN -> MERGED: fires
    expect(monitor.getStatus('wt1')).toEqual({
      number: 42, state: 'MERGED', url: 'https://github.com/o/r/pull/42',
    });
  });

  it('survives gh CLI errors: caches null, fires once for the initial undefined->null transition, then stays quiet', async () => {
    const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
      exec: vi.fn().mockRejectedValue(new Error('gh: command not found')),
    };
    const monitor = new PrMonitor(runner);
    const callback = vi.fn();

    monitor.startPolling('feat/x', 'wt1', callback);
    await vi.advanceTimersByTimeAsync(0);
    // real behavior: the very first poll fires (cache goes undefined -> null)
    expect(callback).toHaveBeenCalledTimes(1);
    expect(monitor.getStatus('wt1')).toBeNull();

    // subsequent failing polls do NOT emit (null -> null) and polling keeps going
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(runner.exec).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('caches null (no callback re-fire) on empty gh output after an initial null', async () => {
    const runner = makeRunner('');
    const monitor = new PrMonitor(runner);
    const callback = vi.fn();

    monitor.startPolling('feat/x', 'wt1', callback);
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(monitor.getStatus('wt1')).toBeNull();

    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('caches per worktree independently', async () => {
    const runner = makeRunner(OPEN_PR);
    const monitor = new PrMonitor(runner);

    monitor.startPolling('feat/a', 'wtA', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    runner.exec.mockResolvedValue('[]');
    monitor.startPolling('feat/b', 'wtB', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.getStatus('wtA')).toEqual({
      number: 42, state: 'OPEN', url: 'https://github.com/o/r/pull/42',
    });
    expect(monitor.getStatus('wtB')).toBeNull();
  });

  it('stopPolling clears the timer but keeps the cached status', async () => {
    const runner = makeRunner(OPEN_PR);
    const monitor = new PrMonitor(runner);

    monitor.startPolling('feat/x', 'wt1', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.exec).toHaveBeenCalledTimes(1);

    monitor.stopPolling('wt1');
    await vi.advanceTimersByTimeAsync(FIVE_MIN * 3);
    expect(runner.exec).toHaveBeenCalledTimes(1); // no more polls
    expect(monitor.getStatus('wt1')).toEqual({    // cache survives stopPolling
      number: 42, state: 'OPEN', url: 'https://github.com/o/r/pull/42',
    });
  });

  it('stopPolling for an unknown worktree is a no-op', () => {
    const monitor = new PrMonitor(makeRunner());
    expect(() => monitor.stopPolling('nope')).not.toThrow();
  });

  it('does not reschedule when stopped while a fetch is in flight (but still writes cache + fires)', async () => {
    const d = deferred<string>();
    const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
      exec: vi.fn().mockReturnValue(d.promise),
    };
    const monitor = new PrMonitor(runner);
    const callback = vi.fn();

    monitor.startPolling('feat/x', 'wt1', callback);
    monitor.stopPolling('wt1'); // deregistered before the first fetch resolves

    d.resolve(OPEN_PR);
    await vi.advanceTimersByTimeAsync(0);

    // real behavior: cache set + callback fired unconditionally on completion...
    expect(monitor.getStatus('wt1')).toEqual({
      number: 42, state: 'OPEN', url: 'https://github.com/o/r/pull/42',
    });
    expect(callback).toHaveBeenCalledTimes(1);
    // ...but no next poll is scheduled since the entry is gone
    await vi.advanceTimersByTimeAsync(FIVE_MIN * 3);
    expect(runner.exec).toHaveBeenCalledTimes(1);
  });

  it('startPolling for the same worktree stops the existing poll first', async () => {
    const runner = makeRunner(OPEN_PR);
    const monitor = new PrMonitor(runner);

    monitor.startPolling('feat/old', 'wt1', vi.fn());
    await vi.advanceTimersByTimeAsync(0); // old poll completed, its 5min timer is set

    monitor.startPolling('feat/new', 'wt1', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.exec).toHaveBeenCalledTimes(2);
    expect(runner.exec.mock.calls[1][0]).toBe('gh pr list --head "feat/new" --json number,state,url');

    // only the NEW poll runs after 5min — the old timer was cleared
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(runner.exec).toHaveBeenCalledTimes(3);
    expect(runner.exec.mock.calls[2][0]).toBe('gh pr list --head "feat/new" --json number,state,url');
  });

  it('dispose stops all polls and clears the cache', async () => {
    const runner = makeRunner(OPEN_PR);
    const monitor = new PrMonitor(runner);

    monitor.startPolling('feat/a', 'wtA', vi.fn());
    monitor.startPolling('feat/b', 'wtB', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.exec).toHaveBeenCalledTimes(2);

    monitor.dispose();
    expect(monitor.getStatus('wtA')).toBeUndefined();
    expect(monitor.getStatus('wtB')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(FIVE_MIN * 3);
    expect(runner.exec).toHaveBeenCalledTimes(2); // no polls after dispose
  });
});

// ── defaultRunner (real child_process execution, real timers) ───────────────

describe('defaultRunner', () => {
  it('resolves with trimmed stdout', async () => {
    await expect(defaultRunner.exec('printf "  hi  \\n"')).resolves.toBe('hi');
  });

  it('passes cwd, env and timeout through to child_process.exec', async () => {
    const out = await defaultRunner.exec('echo "$UNMESS_TEST_VAR:$(pwd)"', {
      cwd: '/',
      env: { ...process.env, UNMESS_TEST_VAR: 'pr-runner' },
      timeout: 10_000,
    });
    expect(out).toBe('pr-runner:/');
  });

  it('rejects when the command exits non-zero', async () => {
    await expect(defaultRunner.exec('exit 7')).rejects.toThrow();
  });
});
