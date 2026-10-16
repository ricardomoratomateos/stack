import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScript } from '../../src/adapters/scriptRunner';

let tmp: string;

function script(name: string, body: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return p;
}

function output() {
  let text = '';
  return {
    append: (t: string) => { text += t; },
    appendLine: (t: string) => { text += `${t}\n`; },
    get text() { return text; },
  };
}

const base = { label: 'Teardown: feat/x', env: {}, timeoutMs: 10_000 };

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-script-')));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runScript (real bash)', () => {
  it('resolves 0 once the script has finished, with its output streamed', async () => {
    const out = output();
    const code = await runScript({ ...base, script: script('ok.sh', 'echo hello; echo oops >&2'), cwd: tmp }, out);
    expect(code).toBe(0);
    expect(out.text).toContain('hello');
    expect(out.text).toContain('oops');
    expect(out.text).toContain('✓ Teardown: feat/x');
  });

  it('hands the script its env and cwd without a shell in between', async () => {
    const out = output();
    const quoted = `it's "quoted" $(nope)`;
    await runScript(
      { ...base, script: script('env.sh', 'echo "cwd=$PWD"; echo "v=$FOREMAN_BRANCH"'), cwd: tmp, env: { FOREMAN_BRANCH: quoted } },
      out,
    );
    expect(out.text).toContain(`cwd=${tmp}`);
    expect(out.text).toContain(`v=${quoted}`);
  });

  it('resolves the exit code of a failing script', async () => {
    const out = output();
    expect(await runScript({ ...base, script: script('fail.sh', 'exit 3'), cwd: tmp }, out)).toBe(3);
    expect(out.text).toContain('exit code 3');
  });

  it('stops a script that runs past its time and resolves null', async () => {
    const out = output();
    const started = Date.now();
    const code = await runScript({ ...base, script: script('hang.sh', 'sleep 30'), cwd: tmp, timeoutMs: 200 }, out);
    expect(code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.text).toContain('stopped');
  });

  it('resolves null, never rejects, when it cannot start at all', async () => {
    const out = output();
    const code = await runScript({ ...base, script: script('x.sh', 'true'), cwd: path.join(tmp, 'no-such-dir') }, out);
    expect(code).toBeNull();
    expect(out.text).toContain('✗ Teardown: feat/x');
  });
});
