import { describe, it, expect, vi, afterEach } from 'vitest';
import { DockerMonitor } from '../../src/docker/DockerMonitor';
import { DockerStacks, type DockerStacksDeps } from '../../src/docker/DockerStacks';
import { composeProject } from '../../src/docker/dockerCompose';
import type { DockerRunOptions, DockerRunResult } from '../../src/docker/dockerCli';
import type { ForemanConfig, Worktree } from '../../src/types';

const ok = (stdout = ''): DockerRunResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string, code = 1): DockerRunResult => ({ code, stdout: '', stderr, timedOut: false });

function makeWorktree(over: Partial<Worktree> = {}): Worktree {
  return {
    id: 'b',
    branch: 'feat/b',
    path: '/repo/.worktrees/feat-b',
    repoRoot: '/repo',
    debugPort: 9899,
    dockerProjectName: 'feat-b',
    createdAt: 1,
    ...over,
  };
}

function makeConfig(over: Partial<ForemanConfig['docker']> = {}): ForemanConfig {
  return {
    worktreesDirectory: '.worktrees',
    defaultBaseBranch: 'main',
    setupScript: '',
    teardownScript: '',
    defaultProvider: 'claude',
    claudeCommand: 'claude',
    codexCommand: 'codex',
    opencodeCommand: 'opencode',
    notifyOnAttention: true,
    scopeSearchToActiveWorktree: true,
    focusMode: false,
    docker: {
      composeFile: 'docker-compose.yml',
      overrideFile: 'docker-compose.worktree.yml',
      ports: ['HTTP_PORT'],
      basePort: 20000,
      portStride: 100,
      ...over,
    },
    debugBasePort: 9898,
    debugTemplate: { type: 'node', request: 'attach', name: 'x', port: '{{PORT}}' },
  };
}

/** A `docker ps --format {{json .}}` line. */
function ps(project: string, name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ Names: name, State: 'running', Labels: `com.docker.compose.project=${project}`, Ports: '', ...extra });
}

interface FakeDocker {
  containers?: string[];
  info?: DockerRunResult;
  config?: DockerRunResult;
  up?: DockerRunResult | (() => Promise<DockerRunResult>);
  down?: DockerRunResult;
}

/**
 * A real DockerMonitor over a scripted docker CLI, so the stacks are tested
 * against the same listing and grouping the extension runs.
 */
function makeStacks(opts: {
  docker?: FakeDocker;
  config?: ForemanConfig;
  files?: string[];
  busyPorts?: number[];
} = {}) {
  const docker = opts.docker ?? {};
  const calls: Array<{ args: string[]; options: DockerRunOptions }> = [];
  const run = vi.fn(async (args: string[], options: DockerRunOptions): Promise<DockerRunResult> => {
    calls.push({ args, options });
    if (args[0] === 'ps') return ok((docker.containers ?? []).join('\n'));
    if (args[0] === 'info') return docker.info ?? ok('27.0');
    if (args.includes('config')) return docker.config ?? ok(JSON.stringify({ services: { web: { ports: [{ published: '20000' }] } } }));
    if (args.includes('up')) {
      options.onOutput?.(' Container web  Started\n');
      return typeof docker.up === 'function' ? docker.up() : docker.up ?? ok();
    }
    if (args.includes('down')) return docker.down ?? ok();
    throw new Error(`unexpected docker ${args.join(' ')}`);
  });
  const monitor = new DockerMonitor({ run }, async () => {});
  const files = new Set(opts.files ?? ['/repo/docker-compose.yml', '/repo/docker-compose.worktree.yml', '/repo/.worktrees/feat-b']);
  const output = { append: vi.fn(), reveal: vi.fn(), showError: vi.fn() };
  const notify = {
    showWarning: vi.fn(),
    withProgress: vi.fn(async <T,>(_t: string, task: (report: (m: string) => void) => Promise<T>) => task(() => {})),
  };
  const onChange = vi.fn();
  const busy = new Set(opts.busyPorts ?? []);
  const deps: DockerStacksDeps = {
    monitor,
    config: () => opts.config ?? makeConfig(),
    locate: (wt, file) => [`${wt.path}/${file}`, `${wt.repoRoot}/${file}`].find((p) => files.has(p)),
    exists: (p) => files.has(p),
    notify,
    output,
    onChange,
    isPortFree: async (port) => !busy.has(port),
  };
  const stacks = new DockerStacks(deps);
  const composeCalls = () => calls.filter((c) => c.args[0] === 'compose');
  return { stacks, monitor, run, calls, composeCalls, output, notify, onChange };
}

afterEach(() => { vi.restoreAllMocks(); });

const wt = makeWorktree();
const project = composeProject(wt);

describe('DockerStacks.files', () => {
  it('prefers the worktree copy and falls back to the main repo', () => {
    const { stacks } = makeStacks({ files: ['/repo/.worktrees/feat-b/docker-compose.yml', '/repo/docker-compose.worktree.yml'] });
    expect(stacks.files(wt)).toEqual({
      files: { base: '/repo/.worktrees/feat-b/docker-compose.yml', override: '/repo/docker-compose.worktree.yml' },
      baseFound: true,
      missingOverride: undefined,
    });
  });

  it('reports an override that exists nowhere instead of dropping it silently', () => {
    const { stacks } = makeStacks({ files: [] });
    expect(stacks.files(wt)).toEqual({
      files: { base: '/repo/docker-compose.yml' },
      baseFound: false,
      missingOverride: 'docker-compose.worktree.yml',
    });
  });

  it('has no override when none is configured, or it names the compose file itself', () => {
    expect(makeStacks({ config: makeConfig({ overrideFile: '' }) }).stacks.files(wt).files.override).toBeUndefined();
    expect(makeStacks({ config: makeConfig({ overrideFile: 'docker-compose.yml' }) }).stacks.files(wt).missingOverride).toBeUndefined();
  });
});

describe('DockerStacks.watch', () => {
  it('watches the worktree project with its legacy names as aliases', () => {
    const { stacks, monitor } = makeStacks();
    const start = vi.spyOn(monitor, 'startPolling');
    const stop = vi.spyOn(monitor, 'stopPolling');
    stacks.watch(wt);
    expect(start).toHaveBeenCalledWith(project, expect.any(Function), ['feat-b']);
    stacks.unwatch(wt);
    expect(stop).toHaveBeenCalledWith(project);
  });
});

describe('DockerStacks.up', () => {
  it('checks the daemon, resolves the merged config, then runs up -d as an awaited process', async () => {
    const { stacks, composeCalls, output, onChange, calls } = makeStacks();

    await expect(stacks.up(wt)).resolves.toBe(true);

    expect(calls[0].args).toEqual(['info', '--format', '{{.ServerVersion}}']);
    const [config, up] = composeCalls();
    const head = ['compose', '-p', project, '--project-directory', wt.path, '-f', '/repo/docker-compose.yml', '-f', '/repo/docker-compose.worktree.yml'];
    expect(config.args).toEqual([...head, 'config', '--format', 'json']);
    expect(up.args).toEqual([...head, 'up', '-d']);
    // PWD set by hand: no shell sits in between to set it any more.
    expect(up.options).toMatchObject({ cwd: wt.path, env: { HTTP_PORT: '20000', PWD: wt.path }, timeoutMs: 15 * 60_000 });
    expect(output.reveal).toHaveBeenCalled();
    expect(output.append).toHaveBeenCalledWith(expect.stringContaining(`$ docker compose -p ${project}`));
    expect(output.append).toHaveBeenCalledWith(' Container web  Started\n');
    expect(stacks.status(wt)).toEqual({ busy: undefined, error: undefined });
    expect(onChange).toHaveBeenCalled();
  });

  it('shows "starting" while it runs and refuses a second start meanwhile', async () => {
    let release!: (r: DockerRunResult) => void;
    const { stacks } = makeStacks({ docker: { up: () => new Promise((r) => { release = r; }) } });
    const first = stacks.up(wt);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(stacks.status(wt).busy).toBe('starting');
    await expect(stacks.up(wt)).resolves.toBe(false);
    release(ok());
    await expect(first).resolves.toBe(true);
    expect(stacks.status(wt).busy).toBeUndefined();
  });

  it('stops at a daemon that is not running, and says so on the card and in a toast', async () => {
    const { stacks, composeCalls, output } = makeStacks({ docker: { info: failed('permission denied') } });
    await expect(stacks.up(wt)).resolves.toBe(false);
    expect(composeCalls()).toEqual([]);
    expect(stacks.status(wt).error).toBe('Docker is not usable: permission denied');
    expect(output.showError).toHaveBeenCalledWith('Docker stack for "feat/b" did not start: Docker is not usable: permission denied');
  });

  it('fails before up when a port hard-coded in the base file is taken, naming the holder and the fix', async () => {
    const { stacks, composeCalls } = makeStacks({
      busyPorts: [27017],
      docker: {
        containers: [ps('feat-c-abcdef', 'mongo', { Ports: '0.0.0.0:27017->27017/tcp' })],
        config: ok(JSON.stringify({ services: { mongo: { ports: [{ published: '27017' }, { published: '20000' }] } } })),
      },
    });
    await expect(stacks.up(wt)).resolves.toBe(false);
    expect(composeCalls().some((c) => c.args.includes('up'))).toBe(false);
    const error = stacks.status(wt).error!;
    expect(error).toContain('27017 (mongo, held by "feat-c-abcdef")');
    expect(error).toContain('!override');
  });

  it('names the variable when one of its own generated ports is taken', async () => {
    const { stacks } = makeStacks({ busyPorts: [20000] });
    await stacks.up(wt);
    expect(stacks.status(wt).error).toBe('Port 20000 (web) from HTTP_PORT is already in use by something else.');
  });

  it('does not count ports its own running containers hold as conflicts', async () => {
    const { stacks } = makeStacks({
      busyPorts: [20000],
      docker: { containers: [ps(project, 'web', { Ports: '0.0.0.0:20000->80/tcp' })] },
    });
    await expect(stacks.up(wt)).resolves.toBe(true);
  });

  it('lets the caller move the worktree, telling it which ports are its own', async () => {
    const { stacks, composeCalls } = makeStacks({
      docker: { containers: [ps(project, 'web', { Ports: '0.0.0.0:20000->80/tcp' })] },
    });
    const relocate = vi.fn(async (w: Worktree) => ({ ...w, debugPort: 9900 }));
    await stacks.up(wt, relocate);
    expect([...relocate.mock.calls[0][1]].sort((a, b) => a - b)).toEqual([9899, 20000]);
    expect(composeCalls().find((c) => c.args.includes('up'))!.options.env).toMatchObject({ HTTP_PORT: '20100' });
  });

  it('reports an invalid compose configuration instead of running up', async () => {
    const { stacks } = makeStacks({ docker: { config: failed('yaml: line 3: did not find expected key') } });
    await stacks.up(wt);
    expect(stacks.status(wt).error).toBe('the compose configuration is invalid: yaml: line 3: did not find expected key');
  });

  it('skips the port check, not the start, on a compose too old for config --format json', async () => {
    const { stacks, composeCalls, output } = makeStacks({ docker: { config: failed('unknown flag: --format') } });
    await expect(stacks.up(wt)).resolves.toBe(true);
    expect(composeCalls().some((c) => c.args.includes('up'))).toBe(true);
    expect(output.append).toHaveBeenCalledWith(expect.stringContaining('skipping the port check'));
  });

  it('falls back to the exit code when config fails silently', async () => {
    const { stacks } = makeStacks({ docker: { config: failed('', 14) } });
    await stacks.up(wt);
    expect(stacks.status(wt).error).toBe('the compose configuration is invalid: exit 14');
  });

  it('surfaces compose\'s own error when up fails, and clears it on the next success', async () => {
    let up: DockerRunResult = failed(' Container db  Starting\nError response from daemon: Bind for 0.0.0.0:20000 failed: port is already allocated');
    const { stacks, output } = makeStacks({ docker: { up: async () => up } });
    await expect(stacks.up(wt)).resolves.toBe(false);
    expect(stacks.status(wt).error).toBe('Error response from daemon: Bind for 0.0.0.0:20000 failed: port is already allocated');
    expect(output.showError).toHaveBeenCalled();

    up = ok();
    await stacks.up(wt);
    expect(stacks.status(wt).error).toBeUndefined();
  });

  it('says when up hung or died without a word', async () => {
    const hung = makeStacks({ docker: { up: { code: null, stdout: '', stderr: '', timedOut: true } } });
    await hung.stacks.up(wt);
    expect(hung.stacks.status(wt).error).toMatch(/still running after 15 minutes/);

    const silent = makeStacks({ docker: { up: failed('', 2) } });
    await silent.stacks.up(wt);
    expect(silent.stacks.status(wt).error).toBe('docker compose up exited with 2');
  });

  it('warns that a configured override was not found, and carries on with the base file', async () => {
    const { stacks, notify, output } = makeStacks({ files: ['/repo/docker-compose.yml', wt.path] });
    await expect(stacks.up(wt)).resolves.toBe(true);
    expect(notify.showWarning).toHaveBeenCalledWith(expect.stringContaining('docker-compose.worktree.yml was not found'));
    expect(output.append).toHaveBeenCalledWith(expect.stringContaining('⚠'));
  });

  it('runs the main checkout\'s stack plain, with no injected ports and no override warning', async () => {
    const main = makeWorktree({ id: 'm', path: '/repo', isMain: true });
    const { stacks, composeCalls, notify } = makeStacks({ files: ['/repo/docker-compose.yml', '/repo'] });
    await stacks.up(main);
    expect(composeCalls().map((c) => c.args)).toEqual([['compose', 'config', '--format', 'json'], ['compose', 'up', '-d']]);
    expect(composeCalls()[1].options.env).toEqual({ PWD: '/repo' });
    expect(notify.showWarning).not.toHaveBeenCalled();
  });

  it('quotes paths with spaces in the logged command line', async () => {
    const spaced = makeWorktree({ path: "/repo/.worktrees/it's here" });
    const { stacks, output } = makeStacks({ files: ['/repo/docker-compose.yml', '/repo/docker-compose.worktree.yml', spaced.path] });
    await stacks.up(spaced);
    expect(output.append).toHaveBeenCalledWith(expect.stringContaining(`'/repo/.worktrees/it'\\''s here'`));
  });

  it('runs from the repo root when the worktree folder is gone', async () => {
    const { stacks, composeCalls } = makeStacks({ files: ['/repo/docker-compose.yml', '/repo/docker-compose.worktree.yml'] });
    await stacks.up(wt);
    expect(composeCalls()[0].options.cwd).toBe('/repo');
  });
});

describe('DockerStacks.down', () => {
  it('brings the stack down under its own name, bounded by a timeout', async () => {
    const { stacks, composeCalls } = makeStacks({ docker: { containers: [ps(project, 'web')] } });
    await expect(stacks.down(wt)).resolves.toBe('ok');
    expect(composeCalls()[0].args).toEqual([
      'compose', '-p', project, '--project-directory', wt.path,
      '-f', '/repo/docker-compose.yml', '-f', '/repo/docker-compose.worktree.yml', 'down',
    ]);
    expect(composeCalls()[0].options.timeoutMs).toBe(60_000);
  });

  it('also stops a stack an older Foreman started under the legacy name — it is not orphaned', async () => {
    const { stacks, composeCalls } = makeStacks({
      docker: { containers: [ps(project, 'web'), ps('feat-b', 'old-web', { Labels: `com.docker.compose.project=feat-b,com.docker.compose.project.working_dir=${wt.path}` })] },
    });
    await stacks.down(wt);
    expect(composeCalls().map((c) => c.args[2])).toEqual([project, 'feat-b']);
  });

  it('leaves another repo\'s stack alone even when it shares the legacy name', async () => {
    const { stacks, composeCalls } = makeStacks({
      docker: { containers: [ps('feat-b', 'web', { Labels: 'com.docker.compose.project=feat-b,com.docker.compose.project.working_dir=/other/.worktrees/feat-b' })] },
    });
    await stacks.down(wt);
    expect(composeCalls().map((c) => c.args[2])).toEqual([project]);
  });

  it('removes the stack by name when its compose file is gone', async () => {
    const { stacks, composeCalls } = makeStacks({ files: [wt.path] });
    await stacks.down(wt);
    expect(composeCalls()[0].args).toEqual(['compose', '-p', project, '--project-directory', wt.path, 'down']);
  });

  it('reports a timeout — and lets the caller stay quiet about it', async () => {
    const hung = { code: null, stdout: '', stderr: '', timedOut: true };
    const loud = makeStacks({ docker: { down: hung } });
    await expect(loud.stacks.down(wt, { timeoutMs: 5_000 })).resolves.toBe('timeout');
    expect(loud.stacks.status(wt).error).toBe('docker compose down did not finish within 5s.');
    expect(loud.output.showError).toHaveBeenCalledWith(expect.stringContaining('did not stop'));

    const quiet = makeStacks({ docker: { down: hung } });
    await quiet.stacks.down(wt, { report: false });
    expect(quiet.output.showError).not.toHaveBeenCalled();
  });

  it('reports a failure with compose\'s words, or the exit code', async () => {
    const a = makeStacks({ docker: { down: failed('Error: no such project') } });
    await expect(a.stacks.down(wt)).resolves.toBe('failed');
    expect(a.stacks.status(wt).error).toBe('Error: no such project');

    const b = makeStacks({ docker: { down: failed('', 3) } });
    await b.stacks.down(wt);
    expect(b.stacks.status(wt).error).toBe('docker compose down exited with 3');
  });

  it('keeps the first failure when several projects fail', async () => {
    const { stacks } = makeStacks({
      docker: {
        containers: [ps(project, 'web'), ps('feat-b', 'old')],
        down: failed('Error: first'),
      },
    });
    await stacks.down(wt);
    expect(stacks.status(wt).error).toBe('Error: first');
  });

  it('does not race a start that is still running', async () => {
    let release!: (r: DockerRunResult) => void;
    const { stacks } = makeStacks({ docker: { up: () => new Promise((r) => { release = r; }) } });
    const up = stacks.up(wt);
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(stacks.down(wt)).resolves.toBe('failed');
    release(ok());
    await up;
  });

  it('clears an old error once a stop succeeds, and forget() drops the state', async () => {
    const { stacks } = makeStacks({ docker: { info: failed('nope') } });
    await stacks.up(wt);
    expect(stacks.status(wt).error).toBeDefined();
    await stacks.down(wt);
    expect(stacks.status(wt).error).toBeUndefined();

    await stacks.up(wt);
    stacks.forget(wt);
    expect(stacks.status(wt)).toEqual({ busy: undefined, error: undefined });
  });
});

describe('DockerStacks — which containers are this worktree\'s', () => {
  const legacy = (dir?: string) => ps('feat-b', 'feat-b-web-1', {
    Labels: `com.docker.compose.project=feat-b${dir ? `,com.docker.compose.project.working_dir=${dir}` : ''}`,
    Ports: '0.0.0.0:20000->80/tcp',
  });

  it('shows its own project first', async () => {
    const { stacks, monitor } = makeStacks({ docker: { containers: [ps(project, 'new'), legacy(wt.path)] } });
    await monitor.refresh();
    expect(stacks.containers(wt).map((c) => c.name)).toEqual(['new']);
    expect(stacks.project(wt)).toBe(project);
  });

  it('falls back to a legacy stack from this worktree or its repo (compose file in main/.foreman)', async () => {
    for (const dir of [wt.path, '/repo/.foreman', '/repo', undefined]) {
      const { stacks, monitor } = makeStacks({ docker: { containers: [legacy(dir)] } });
      await monitor.refresh();
      expect(stacks.containers(wt).map((c) => c.name)).toEqual(['feat-b-web-1']);
      expect(stacks.project(wt)).toBe('feat-b');
      expect(stacks.ownPorts(wt)).toEqual(new Set([9899, 20000]));
      expect(stacks.scriptEnv(wt).COMPOSE_PROJECT_NAME).toBe('feat-b');
    }
  });

  it('ignores a same-named legacy stack of another repository', async () => {
    const { stacks, monitor } = makeStacks({ docker: { containers: [legacy('/elsewhere/feat-b')] } });
    await monitor.refresh();
    expect(stacks.containers(wt)).toEqual([]);
    expect(stacks.project(wt)).toBe(project);
  });

  it('copes with a container that reports no ports at all', () => {
    const { stacks, monitor } = makeStacks();
    vi.spyOn(monitor, 'getContainers').mockImplementation((p) => (p === project ? [{ name: 'web', state: 'running' }] : []));
    expect(stacks.ownPorts(wt)).toEqual(new Set([9899]));
  });

  it('owns its debug port and its containers\' published ports', async () => {
    const { stacks } = makeStacks({ docker: { containers: [ps(project, 'web', { Ports: '0.0.0.0:20000->80/tcp' }), ps(project, 'db')] } });
    await stacks.refresh();
    expect(stacks.ownPorts(wt)).toEqual(new Set([9899, 20000]));
  });
});
