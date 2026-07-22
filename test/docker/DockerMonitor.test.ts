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

  it('startPolling is idempotent per project (second call is a no-op)', async () => {
    const runner = makeRunner(JSONL);
    const monitor = new DockerMonitor(runner);
    const first = vi.fn();
    const second = vi.fn();

    monitor.startPolling('proj', first);
    monitor.startPolling('proj', second); // ignored: already polling
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.exec).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(runner.exec).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
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

    // real behavior: fetch completion writes the cache and fires onChange unconditionally
    expect(monitor.getContainers('proj')).toEqual([{ name: 'web', state: 'running' }]);
    expect(onChange).toHaveBeenCalledTimes(1);
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
