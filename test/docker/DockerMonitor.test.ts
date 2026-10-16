import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerMonitor } from '../../src/docker/DockerMonitor';
import type { DockerRunResult, IDockerRunner } from '../../src/docker/dockerCli';

const ok = (stdout = ''): DockerRunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string, code = 1): DockerRunResult => ({ code, stdout: '', stderr, timedOut: false });
const timedOut: DockerRunResult = { code: null, stdout: '', stderr: '', timedOut: true };

/** One `docker ps --format {{json .}}` line. */
function ps(project: string, name: string, state = 'running', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Names: name,
    State: state,
    Labels: `com.docker.compose.project=${project},com.docker.compose.service=${name}`,
    Ports: '',
    ...extra,
  });
}

function makeRunner(result: DockerRunResult | (() => DockerRunResult | Promise<DockerRunResult>) = ok()) {
  const run = vi.fn(async (_args: string[], _opts: unknown) => (typeof result === 'function' ? result() : result));
  return { run } as IDockerRunner & { run: typeof run };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const PS_ARGS = ['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', '{{json .}}'];

describe('DockerMonitor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('getContainers is empty for a project it has never seen', () => {
    expect(new DockerMonitor(makeRunner()).getContainers('nope')).toEqual([]);
  });

  it('constructs with the real runner by default', () => {
    const monitor = new DockerMonitor();
    expect(monitor.unavailable()).toBeUndefined();
    monitor.dispose();
  });

  describe('polling', () => {
    it('lists every compose container in ONE docker ps -a and groups them by project', async () => {
      const runner = makeRunner(ok([ps('a', 'a-web-1'), ps('b', 'b-db-1', 'exited', { Status: 'Exited (1) 1 minute ago' }), ps('a', 'a-api-1')].join('\n')));
      const monitor = new DockerMonitor(runner);

      monitor.startPolling('a', vi.fn());
      monitor.startPolling('b', vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Two projects, one process: the in-flight listing is shared.
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(runner.run).toHaveBeenCalledWith(PS_ARGS, { timeoutMs: 10_000 });
      expect(monitor.getContainers('a').map((c) => c.name)).toEqual(['a-api-1', 'a-web-1']);
      expect(monitor.getContainers('b')).toEqual([
        { name: 'b-db-1', state: 'exited', service: 'b-db-1', exitCode: 1, status: 'Exited (1) 1 minute ago', ports: [] },
      ]);
    });

    it('polls every 20s, but repaints only when what the card shows changed', async () => {
      let out = ps('p', 'web');
      const runner = makeRunner(() => ok(out));
      const monitor = new DockerMonitor(runner);
      const onChange = vi.fn();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      monitor.startPolling('p', onChange);
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(runner.run).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenCalledTimes(1); // same containers, no repaint

      out = ps('p', 'web', 'exited');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('repaints when a legacy alias project changes, too', async () => {
      let out = '';
      const monitor = new DockerMonitor(makeRunner(() => ok(out)));
      const onChange = vi.fn();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      monitor.startPolling('feat-a-123456', onChange, ['feat-a']);
      await vi.advanceTimersByTimeAsync(0);
      onChange.mockClear();

      out = ps('feat-a', 'feat-a-web-1');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('a later startPolling replaces the callback without polling again', async () => {
      const runner = makeRunner(() => ok(ps('p', `web-${runner.run.mock.calls.length}`)));
      const monitor = new DockerMonitor(runner);
      const stale = vi.fn();
      const live = vi.fn();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      monitor.startPolling('p', stale);
      await vi.advanceTimersByTimeAsync(0);
      monitor.startPolling('p', live);
      expect(runner.run).toHaveBeenCalledTimes(1);
      stale.mockClear();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(live).toHaveBeenCalled();
      expect(stale).not.toHaveBeenCalled();
    });

    it('never stacks a second docker ps on one that has not answered', async () => {
      const d = deferred<DockerRunResult>();
      const runner = makeRunner(() => d.promise);
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('p', vi.fn());

      await vi.advanceTimersByTimeAsync(60_000);
      monitor.nudge();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runner.run).toHaveBeenCalledTimes(1);

      d.resolve(ok());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runner.run.mock.calls.length).toBeGreaterThan(1);
    });

    it('stopping one project keeps polling the others', async () => {
      const runner = makeRunner(ok());
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('a', vi.fn());
      monitor.startPolling('b', vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      monitor.stopPolling('a');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runner.run).toHaveBeenCalledTimes(2);
    });

    it('stopping the last project stops the clock and forgets the cache and the failure', async () => {
      const runner = makeRunner(failed('Cannot connect to the Docker daemon'));
      const monitor = new DockerMonitor(runner);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      monitor.startPolling('p', vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.unavailable()).toBeDefined();

      monitor.stopPolling('p');
      expect(monitor.unavailable()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runner.run).toHaveBeenCalledTimes(1);
    });

    it('ignores a listing that lands after polling stopped', async () => {
      const d = deferred<DockerRunResult>();
      const monitor = new DockerMonitor(makeRunner(() => d.promise));
      const onChange = vi.fn();
      monitor.startPolling('p', onChange);
      monitor.stopPolling('p');

      d.resolve(ok(ps('p', 'web')));
      await vi.advanceTimersByTimeAsync(0);

      expect(monitor.getContainers('p')).toEqual([]);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('dispose stops everything, a listing in flight included', async () => {
      const d = deferred<DockerRunResult>();
      const runner = makeRunner(() => d.promise);
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('p', vi.fn());
      monitor.nudge();
      monitor.dispose();

      d.resolve(ok(ps('p', 'web')));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(monitor.getContainers('p')).toEqual([]);
      expect(runner.run).toHaveBeenCalledTimes(1);
    });

    it('dispose without anything running is harmless', () => {
      expect(() => new DockerMonitor(makeRunner()).dispose()).not.toThrow();
    });
  });

  describe('nudge', () => {
    it('does nothing while no project is watched', async () => {
      const runner = makeRunner();
      new DockerMonitor(runner).nudge();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('polls now and every 2s for a bounded burst', async () => {
      const runner = makeRunner();
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('p', vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      runner.run.mockClear();

      monitor.nudge();
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runner.run).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(16_000); // burst over (8 ticks) and the 20s tick
      const afterBurst = runner.run.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runner.run.mock.calls.length).toBe(afterBurst + 1);
    });

    it('a second nudge restarts the burst instead of stacking timers', async () => {
      const runner = makeRunner();
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('p', vi.fn());
      monitor.nudge();
      monitor.nudge();
      await vi.advanceTimersByTimeAsync(0);
      runner.run.mockClear();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(runner.run).toHaveBeenCalledTimes(1);
    });

    it('stopPolling cancels a running burst', async () => {
      const runner = makeRunner();
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('p', vi.fn());
      monitor.nudge();
      await vi.advanceTimersByTimeAsync(0);
      monitor.stopPolling('p');
      runner.run.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(runner.run).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('reports an unreachable daemon once, clears what it showed, and repaints', async () => {
      const runner = makeRunner(failed('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'));
      const monitor = new DockerMonitor(runner);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onChange = vi.fn();

      monitor.startPolling('p', onChange);
      await vi.advanceTimersByTimeAsync(40_000);

      expect(monitor.unavailable()).toBe('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
      expect(error).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('a timeout keeps the last known containers — a slow daemon is not a stopped stack', async () => {
      let result = ok(ps('p', 'web'));
      const monitor = new DockerMonitor(makeRunner(() => result));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      monitor.startPolling('p', vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      result = timedOut;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(monitor.getContainers('p')).toHaveLength(1);
      expect(monitor.unavailable()).toBe('docker ps did not answer within 10s');
    });

    it('logs a new message, and recovery repaints so the card drops its warning', async () => {
      let result = failed('first');
      const monitor = new DockerMonitor(makeRunner(() => result));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const onChange = vi.fn();
      monitor.startPolling('p', onChange);
      await vi.advanceTimersByTimeAsync(0);

      result = failed('', 125);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(error).toHaveBeenLastCalledWith('[stack] docker ps failed: docker ps exited with 125');

      result = ok();
      onChange.mockClear();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(monitor.unavailable()).toBeUndefined();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('treats a runner that rejects as a failed listing, and keeps polling', async () => {
      const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(ok());
      const monitor = new DockerMonitor({ run });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      monitor.startPolling('p', vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.unavailable()).toContain('boom');

      await vi.advanceTimersByTimeAsync(20_000);
      expect(monitor.unavailable()).toBeUndefined();
    });
  });

  describe('refresh', () => {
    it('waits out a listing already in flight and takes a fresh one', async () => {
      const d = deferred<DockerRunResult>();
      const runner = makeRunner(ok(ps('p', 'after')));
      runner.run.mockReturnValueOnce(d.promise);
      const monitor = new DockerMonitor(runner);
      monitor.startPolling('p', vi.fn());

      const refreshed = monitor.refresh();
      d.resolve(ok(ps('p', 'before')));
      await expect(refreshed).resolves.toBe(true);
      expect(runner.run).toHaveBeenCalledTimes(2);
      expect(monitor.getContainers('p')[0].name).toBe('after');
    });

    it('works with nothing watched, and says when docker could not be listed', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(new DockerMonitor(makeRunner(failed('nope'))).refresh()).resolves.toBe(false);
    });
  });

  it('projectPublishing names the stack holding a host port', async () => {
    const monitor = new DockerMonitor(makeRunner(ok(ps('other', 'mongo', 'running', { Ports: '0.0.0.0:27017->27017/tcp' }))));
    await monitor.refresh();
    expect(monitor.projectPublishing(27017)).toBe('other');
    expect(monitor.projectPublishing(1)).toBeUndefined();
  });

  it('runCompose hands the argv and options to the runner', async () => {
    const runner = makeRunner(ok('done'));
    const monitor = new DockerMonitor(runner);
    const opts = { cwd: '/wt', env: { A: '1' }, timeoutMs: 5 };
    await expect(monitor.runCompose(['compose', 'up'], opts)).resolves.toEqual(ok('done'));
    expect(runner.run).toHaveBeenCalledWith(['compose', 'up'], opts);
  });

  describe('checkDaemon', () => {
    const sleep = vi.fn(async () => {});

    it('is undefined when docker info answers', async () => {
      const runner = makeRunner(ok('27.0.1'));
      await expect(new DockerMonitor(runner, sleep).checkDaemon()).resolves.toBeUndefined();
      expect(runner.run).toHaveBeenCalledWith(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
    });

    it('waits for a daemon that is still starting', async () => {
      const run = vi.fn()
        .mockResolvedValueOnce(failed('Cannot connect to the Docker daemon. Is the docker daemon running?'))
        .mockResolvedValueOnce(failed('error during connect'))
        .mockResolvedValue(ok('27'));
      await expect(new DockerMonitor({ run }, sleep).checkDaemon()).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledTimes(3);
    });

    it('waits with real delays by default', async () => {
      const run = vi.fn().mockResolvedValueOnce(failed('connection refused')).mockResolvedValue(ok());
      const pending = new DockerMonitor({ run }).checkDaemon();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBeUndefined();
    });

    it('gives up with a clear message when the daemon never comes up', async () => {
      const run = vi.fn().mockResolvedValue(failed('Cannot connect to the Docker daemon'));
      await expect(new DockerMonitor({ run }, sleep).checkDaemon()).resolves.toMatch(/Docker is not running/);
      expect(run).toHaveBeenCalledTimes(4);
    });

    it('does not retry an error that waiting will not fix', async () => {
      const run = vi.fn().mockResolvedValue(failed('permission denied while trying to connect'));
      await expect(new DockerMonitor({ run }, sleep).checkDaemon()).resolves.toBe(
        'Docker is not usable: permission denied while trying to connect',
      );
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('says so when the CLI is missing or the daemon hangs', async () => {
      await expect(new DockerMonitor(makeRunner({ ...failed('ENOENT'), notFound: true }), sleep).checkDaemon())
        .resolves.toMatch(/docker CLI was not found/);
      await expect(new DockerMonitor(makeRunner(timedOut), sleep).checkDaemon()).resolves.toMatch(/looks hung/);
    });
  });
});
