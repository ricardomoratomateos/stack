import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerMonitor, parseDockerPsOutput, defaultRunner } from '../../src/docker/DockerMonitor';
import type { IProcessRunner } from '../../src/ports/IProcessRunner';

function makeRunner(stdout = ''): IProcessRunner & { exec: ReturnType<typeof vi.fn> } {
  return { exec: vi.fn().mockResolvedValue(stdout) };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('parseDockerPsOutput (parseContainers)', () => {
  it('parses JSON array output (Docker >= 2.21)', () => {
    const out = JSON.stringify([
      { Name: 'web', State: 'running' },
      { Name: 'db', State: 'exited' },
    ]);
    expect(parseDockerPsOutput(out)).toEqual([
      { name: 'web', state: 'running' },
      { name: 'db', state: 'stopped' },
    ]);
  });

  it('parses JSONL output (one object per line)', () => {
    const out = '{"Name":"web","State":"running"}\n{"Name":"db","State":"paused"}\n';
    expect(parseDockerPsOutput(out)).toEqual([
      { name: 'web', state: 'running' },
      { name: 'db', state: 'stopped' },
    ]);
  });

  it('defaults missing Name to "unknown" and non-"running" State to "stopped" (both formats)', () => {
    expect(parseDockerPsOutput('[{"State":"running"},{"Name":"x"}]')).toEqual([
      { name: 'unknown', state: 'running' },
      { name: 'x', state: 'stopped' },
    ]);
    expect(parseDockerPsOutput('{"State":"Running"}')).toEqual([
      { name: 'unknown', state: 'stopped' },
    ]);
  });

  it('returns empty on empty / whitespace-only output', () => {
    expect(parseDockerPsOutput('')).toEqual([]);
    expect(parseDockerPsOutput('   \n  ')).toEqual([]);
  });

  it('returns empty on malformed JSON-array output', () => {
    expect(parseDockerPsOutput('[{"Name": broken')).toEqual([]);
  });

  it('skips malformed JSONL lines individually, keeping valid ones', () => {
    const out = '{"Name":"ok","State":"running"}\nnot-json\n{"Name":"ok2","State":"exited"}';
    expect(parseDockerPsOutput(out)).toEqual([
      { name: 'ok', state: 'running' },
      { name: 'ok2', state: 'stopped' },
    ]);
  });

  it('returns empty when every line is malformed', () => {
    expect(parseDockerPsOutput('garbage\nmore garbage')).toEqual([]);
  });
});

describe('DockerMonitor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const JSONL = '{"Name":"web","State":"running"}';

  it('getContainers returns [] for an unknown project', () => {
    const monitor = new DockerMonitor(makeRunner());
    expect(monitor.getContainers('nope')).toEqual([]);
  });

  it('startPolling runs an immediate poll, caches the result and fires onChange', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);
    const onChange = vi.fn();

    monitor.startPolling('proj', onChange);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.exec).toHaveBeenCalledTimes(1);
    expect(runner.exec).toHaveBeenCalledWith('docker compose -p "proj" ps --format json', expect.anything());
    expect(monitor.getContainers('proj')).toEqual([{ name: 'web', state: 'running' }]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('lists by explicit project (-p), no cwd or compose file needed', async () => {
    const runner = makeRunner('');
    const monitor = new DockerMonitor(runner);

    monitor.startPolling('my-proj', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.exec.mock.calls[0][0]).toBe('docker compose -p "my-proj" ps --format json');
    const options = runner.exec.mock.calls[0][1];
    expect(options.cwd).toBeUndefined();
    expect(options.env.PATH).toBe(`${process.env['PATH'] ?? ''}:/usr/local/bin:/opt/homebrew/bin`);
  });

  it('polls every 20s and fires onChange on every successful poll (even without change)', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);
    const onChange = vi.fn();

    monitor.startPolling('proj', onChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.exec).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(runner.exec).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runner.exec).toHaveBeenCalledTimes(2);
    // same output as before, but onChange fires again (no change-detection in the code)
    expect(onChange).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(runner.exec).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('starts one timer per project, however many times it is called', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);

    monitor.startPolling('proj', vi.fn());
    monitor.startPolling('proj', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    // One immediate poll: the second call records its callback and returns
    // before polling, so repeated calls never pile up extra docker invocations.
    expect(runner.exec).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runner.exec).toHaveBeenCalledTimes(2);
  });

  it('a later startPolling REPLACES the callback instead of being ignored', async () => {
    // The callback used to live in the poll closure and was dropped on the
    // early return, so the first caller owned the project forever. A worktree
    // created in-session registered a no-op that way and its docker badge went
    // stale until the window was reloaded.
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);
    const stale = vi.fn();
    const live = vi.fn();

    monitor.startPolling('proj', stale);
    monitor.startPolling('proj', live);
    await vi.advanceTimersByTimeAsync(0);
    stale.mockClear();
    live.mockClear();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(live).toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
  });

  describe('nudge', () => {
    it('polls immediately and then every 2s, far faster than the 20s cadence', async () => {
      const runner = makeRunner(JSONL);
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('proj', vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      runner.exec.mockClear();

      monitor.nudge('proj');
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.exec).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(runner.exec).toHaveBeenCalledTimes(2);
    });

    it('fires the project callback, so the sidebar repaints', async () => {
      const runner = makeRunner(JSONL);
      const monitor = new DockerMonitor(runner);
      const onChange = vi.fn();
      monitor.startPolling('proj', onChange);
      await vi.advanceTimersByTimeAsync(0);
      onChange.mockClear();

      monitor.nudge('proj');
      await vi.advanceTimersByTimeAsync(0);

      expect(onChange).toHaveBeenCalled();
    });

    it('gives up after a bounded burst instead of polling docker forever', async () => {
      const runner = makeRunner(JSONL);
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('proj', vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      monitor.nudge('proj');
      await vi.advanceTimersByTimeAsync(60_000);
      const afterBurst = runner.exec.mock.calls.length;

      // Only the regular 20s poll should still be running.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runner.exec.mock.calls.length).toBe(afterBurst + 1);
    });

    it('a second nudge restarts the burst rather than stacking timers', async () => {
      const runner = makeRunner(JSONL);
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('proj', vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      monitor.nudge('proj');
      monitor.nudge('proj');
      await vi.advanceTimersByTimeAsync(0);
      runner.exec.mockClear();

      await vi.advanceTimersByTimeAsync(2_000);
      // One burst tick, not two.
      expect(runner.exec).toHaveBeenCalledTimes(1);
    });

    it('stopPolling cancels an in-flight burst', async () => {
      const runner = makeRunner(JSONL);
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('proj', vi.fn());
      monitor.nudge('proj');
      await vi.advanceTimersByTimeAsync(0);

      monitor.stopPolling('proj');
      runner.exec.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(runner.exec).not.toHaveBeenCalled();
    });

    it('dispose cancels an in-flight burst', async () => {
      const runner = makeRunner(JSONL);
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('proj', vi.fn());
      monitor.nudge('proj');
      await vi.advanceTimersByTimeAsync(0);

      monitor.dispose();
      runner.exec.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(runner.exec).not.toHaveBeenCalled();
    });
  });

  it('polls independently per project', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);

    monitor.startPolling('a', vi.fn());
    monitor.startPolling('b', vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.exec).toHaveBeenCalledTimes(2);
    expect(runner.exec.mock.calls[0][0]).toBe('docker compose -p "a" ps --format json');
    expect(runner.exec.mock.calls[1][0]).toBe('docker compose -p "b" ps --format json');
  });

  it('caches [] and still fires onChange when the exec fails', async () => {
    const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
      exec: vi.fn().mockRejectedValue(new Error('docker not found')),
    };
    const monitor = new DockerMonitor(runner);
    const onChange = vi.fn();

    monitor.startPolling('proj', onChange);
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.getContainers('proj')).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stopPolling clears the timer and the cache', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);

    monitor.startPolling('proj', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getContainers('proj')).toHaveLength(1);

    monitor.stopPolling('proj');
    expect(monitor.getContainers('proj')).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.exec).toHaveBeenCalledTimes(1); // no further polls
  });

  it('stopPolling for a project without a timer is a no-op (cache from refresh() is kept)', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);

    await monitor.refresh('proj');
    expect(monitor.getContainers('proj')).toHaveLength(1);

    monitor.stopPolling('proj'); // no timer registered -> cache untouched
    expect(monitor.getContainers('proj')).toHaveLength(1);
  });

  it('refresh fetches, updates the cache and returns the containers', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);

    const containers = await monitor.refresh('proj');
    expect(containers).toEqual([{ name: 'web', state: 'running' }]);
    expect(monitor.getContainers('proj')).toEqual(containers);
    expect(runner.exec).toHaveBeenCalledTimes(1);
  });

  it('runCompose runs the command in cwd with merged env, then refreshes the cache', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);

    await monitor.runCompose('proj', '/wt/proj', '-f a.yml down', { HTTP_PORT: '20000' });

    expect(runner.exec).toHaveBeenCalledTimes(2); // the down, then the refresh ps
    expect(runner.exec.mock.calls[0][0]).toBe('docker compose -f a.yml down');
    const opts = runner.exec.mock.calls[0][1];
    expect(opts.cwd).toBe('/wt/proj');
    expect(opts.env.HTTP_PORT).toBe('20000');
    expect(opts.env.PATH).toBe(`${process.env['PATH'] ?? ''}:/usr/local/bin:/opt/homebrew/bin`);
    expect(monitor.getContainers('proj')).toEqual([{ name: 'web', state: 'running' }]);
  });

  describe('failure reporting', () => {
    it('logs why docker failed instead of silently reporting no containers', async () => {
      // An unreachable daemon and an empty stack used to be the same silent [],
      // which made "the badge is empty" impossible to diagnose.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
        exec: vi.fn().mockRejectedValue(new Error('command not found: docker')),
      };
      const monitor = new DockerMonitor(runner);

      await monitor.refresh('proj');

      expect(spy).toHaveBeenCalledWith('[unmess] docker ps failed for "proj": command not found: docker');
      spy.mockRestore();
    });

    it('reports the same failure once, not on every poll', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
        exec: vi.fn().mockRejectedValue(new Error('daemon not running')),
      };
      const monitor = new DockerMonitor(runner);

      await monitor.refresh('proj');
      await monitor.refresh('proj');
      await monitor.refresh('proj');

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('reports a different failure even for the same project', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
        exec: vi.fn()
          .mockRejectedValueOnce(new Error('first problem'))
          .mockRejectedValueOnce(new Error('second problem')),
      };
      const monitor = new DockerMonitor(runner);

      await monitor.refresh('proj');
      await monitor.refresh('proj');

      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it('reports again after a recovery, so a flapping daemon is not hidden forever', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
        exec: vi.fn()
          .mockRejectedValueOnce(new Error('down'))
          .mockResolvedValueOnce(JSONL)
          .mockRejectedValueOnce(new Error('down')),
      };
      const monitor = new DockerMonitor(runner);

      await monitor.refresh('proj');
      await monitor.refresh('proj');
      await monitor.refresh('proj');

      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it('handles a rejection that is not an Error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
        exec: vi.fn().mockRejectedValue('just a string'),
      };
      const monitor = new DockerMonitor(runner);

      await expect(monitor.refresh('proj')).resolves.toEqual([]);
      expect(spy).toHaveBeenCalledWith('[unmess] docker ps failed for "proj": just a string');
      spy.mockRestore();
    });
  });

  it('refresh resolves [] when exec fails', async () => {
    const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
      exec: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const monitor = new DockerMonitor(runner);
    await expect(monitor.refresh('proj')).resolves.toEqual([]);
    expect(monitor.getContainers('proj')).toEqual([]);
  });

  it('dispose clears all timers and caches', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);

    monitor.startPolling('a', vi.fn());
    monitor.startPolling('b', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.exec).toHaveBeenCalledTimes(2);

    monitor.dispose();
    expect(monitor.getContainers('a')).toEqual([]);
    expect(monitor.getContainers('b')).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.exec).toHaveBeenCalledTimes(2); // no polls after dispose
  });

  it('a poll result landing after stopPolling still repopulates the cache (in-flight write)', async () => {
    const d = deferred<string>();
    const runner: IProcessRunner & { exec: ReturnType<typeof vi.fn> } = {
      exec: vi.fn().mockReturnValue(d.promise),
    };
    const monitor = new DockerMonitor(runner);
    const onChange = vi.fn();

    monitor.startPolling('proj', onChange);
    monitor.stopPolling('proj'); // stop while the first fetch is in flight

    d.resolve(JSONL);
    await vi.advanceTimersByTimeAsync(0);

    // The in-flight fetch still writes the cache when it lands...
    expect(monitor.getContainers('proj')).toEqual([{ name: 'web', state: 'running' }]);
    // ...but stopPolling dropped the callback, so nothing repaints a worktree
    // that is on its way out.
    expect(onChange).not.toHaveBeenCalled();
    // but no timer remains, so no further polls
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.exec).toHaveBeenCalledTimes(1);
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
      env: { ...process.env, UNMESS_TEST_VAR: 'docker-runner' },
      timeout: 10_000,
    });
    expect(out).toBe('docker-runner:/');
  });

  it('rejects when the command exits non-zero', async () => {
    await expect(defaultRunner.exec('exit 7')).rejects.toThrow();
  });
});

// ── DOCKER_PATH fallback when PATH is unset (module-load-time branch) ───────

describe('DOCKER_PATH', () => {
  it('falls back to an empty base PATH when process.env.PATH is unset', async () => {
    const originalPath = process.env['PATH'];
    vi.resetModules();
    delete process.env['PATH'];
    try {
      const fresh = await import('../../src/docker/DockerMonitor');
      const runner = makeRunner('');
      const monitor = new fresh.DockerMonitor(runner);
      await monitor.refresh('proj');
      const env = runner.exec.mock.calls[0][1].env as Record<string, string>;
      expect(env['PATH']).toBe(':/usr/local/bin:/opt/homebrew/bin');
    } finally {
      process.env['PATH'] = originalPath;
      vi.resetModules();
    }
  });
});
