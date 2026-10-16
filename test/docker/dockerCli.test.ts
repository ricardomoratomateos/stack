import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createDockerRunner, dockerSearchPath, failureSummary } from '../../src/docker/dockerCli';

// The runner is exercised against node itself, standing in for the docker
// binary: real processes, real pipes, real signals — no docker needed.
const node = createDockerRunner(process.execPath);
const script = (code: string) => ['-e', code];

describe('dockerSearchPath', () => {
  it('appends every place a docker CLI is installed to on macOS', () => {
    const p = dockerSearchPath('/usr/bin', '/Users/me').split(':');
    expect(p).toEqual([
      '/usr/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/Users/me/.docker/bin',
      '/Users/me/.orbstack/bin',
      '/Users/me/.rd/bin',
    ]);
  });

  it('starts with the extra dirs when there is no PATH at all', () => {
    expect(dockerSearchPath('', '/h').startsWith('/usr/local/bin:')).toBe(true);
  });

  it('defaults to this process PATH and home', () => {
    expect(dockerSearchPath()).toContain(`${os.homedir()}/.orbstack/bin`);
  });

  it('copes with a process that has no PATH at all', () => {
    const saved = process.env['PATH'];
    delete process.env['PATH'];
    try {
      expect(dockerSearchPath(undefined, '/h').startsWith('/usr/local/bin:')).toBe(true);
    } finally {
      process.env['PATH'] = saved;
    }
  });
});

describe('createDockerRunner', () => {
  it('resolves with exit code and output, streaming every chunk as it arrives', async () => {
    const chunks: string[] = [];
    const r = await node.run(script('process.stdout.write("out"); process.stderr.write("err")'), {
      timeoutMs: 10_000,
      onOutput: (c) => chunks.push(c),
    });
    expect(r).toEqual({ code: 0, stdout: 'out', stderr: 'err', timedOut: false });
    expect(chunks.sort()).toEqual(['err', 'out']);
  });

  it('resolves — not rejects — with a non-zero exit and its stderr', async () => {
    const r = await node.run(script('console.error("port is already allocated"); process.exit(3)'), { timeoutMs: 10_000 });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('port is already allocated');
  });

  it('runs in cwd with the env merged over PATH and COMPOSE_ANSI=never', async () => {
    const dir = fs.realpathSync(os.tmpdir());
    const r = await node.run(
      script('console.log(JSON.stringify([process.cwd(), process.env.COMPOSE_ANSI, process.env.HTTP_PORT, process.env.PATH]))'),
      { cwd: dir, env: { HTTP_PORT: '20000' }, timeoutMs: 10_000 },
    );
    const [cwd, ansi, port, searchPath] = JSON.parse(r.stdout) as string[];
    expect(cwd).toBe(dir);
    expect(ansi).toBe('never');
    expect(port).toBe('20000');
    expect(searchPath).toContain('/opt/homebrew/bin');
  });

  it('kills a call that outlives its timeout and says so', async () => {
    const r = await node.run(script('setTimeout(() => {}, 30000)'), { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const r = await node.run(
      script('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'),
      { timeoutMs: 1_000 },
    );
    expect(r.timedOut).toBe(true);
  });

  it('reports a missing binary as notFound instead of throwing', async () => {
    const r = await createDockerRunner('/definitely/not/docker').run(['ps'], { timeoutMs: 1_000 });
    expect(r.notFound).toBe(true);
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it('reports other spawn errors without claiming the binary is missing', async () => {
    // A directory is not executable: EACCES, not ENOENT.
    const r = await createDockerRunner(os.tmpdir()).run([], { timeoutMs: 1_000 });
    expect(r.notFound).toBe(false);
    expect(r.code).toBeNull();
  });
});

describe('failureSummary', () => {
  it('picks the error line out of compose progress noise', () => {
    const stderr = [
      ' Network feat-a_default  Created',
      ' Container feat-a-db-1  Starting',
      'Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:27017 failed: port is already allocated',
    ].join('\n');
    expect(failureSummary(stderr)).toBe(
      'Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:27017 failed: port is already allocated',
    );
  });

  it('falls back to the last lines when nothing looks like an error', () => {
    expect(failureSummary('a\nb\nc\nd')).toBe('b · c · d');
  });

  it('caps very long output', () => {
    expect(failureSummary(`error ${'x'.repeat(1000)}`)).toHaveLength(398);
  });

  it('is empty for empty stderr', () => {
    expect(failureSummary('')).toBe('');
  });
});
