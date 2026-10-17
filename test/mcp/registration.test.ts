import { describe, it, expect, vi } from 'vitest';
import { claudeBinary, disableManager, enableManager, execRun, type Run, type RunResult } from '../../src/mcp/registration';

const bridge = { command: '/usr/bin/node', args: ['/store/stack-mcp.js'] };
const runner = (...results: RunResult[]) => {
  const run = vi.fn<Run>(async () => results.shift() ?? { code: 0, stdout: '', stderr: '' });
  return run;
};

describe('claudeBinary', () => {
  it('is the first word of the configured command', () => {
    expect(claudeBinary('claude --dangerously-skip-permissions')).toBe('claude');
    expect(claudeBinary('  /opt/claude  ')).toBe('/opt/claude');
    expect(claudeBinary('')).toBe('claude');
  });
});

describe('enableManager', () => {
  it('replaces any existing "stack" entry with one at user scope', async () => {
    const run = runner({ code: 1, stdout: '', stderr: 'No MCP server named stack' }, { code: 0, stdout: 'Added', stderr: '' });
    const res = await enableManager(run, 'claude', bridge);
    expect(run.mock.calls).toEqual([
      ['claude', ['mcp', 'remove', '--scope', 'user', 'stack']],
      ['claude', ['mcp', 'add', '--scope', 'user', 'stack', '--', '/usr/bin/node', '/store/stack-mcp.js']],
    ]);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/registered with Claude Code/);
  });

  it('says when claude cannot be run, or refuses', async () => {
    let res = await enableManager(runner({ code: null, stdout: '', stderr: '' }, { code: null, stdout: '', stderr: 'spawn claude ENOENT' }), 'claude', bridge);
    expect(res).toEqual({ ok: false, message: 'Stack: could not run "claude" (spawn claude ENOENT). Install Claude Code or set stack.claudeCommand.' });
    res = await enableManager(runner({ code: null, stdout: '', stderr: '' }, { code: null, stdout: '', stderr: '' }), 'claude', bridge);
    expect(res.message).toContain('(not found)');
    res = await enableManager(runner({ code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'a\nb\nc\nd: bad scope' }), 'claude', bridge);
    expect(res).toEqual({ ok: false, message: 'Stack: "claude mcp add" failed: b c d: bad scope' });
    res = await enableManager(runner({ code: 0, stdout: '', stderr: '' }, { code: 2, stdout: '', stderr: '' }), 'claude', bridge);
    expect(res.message).toBe('Stack: "claude mcp add" failed: exit code 2');
  });
});

describe('disableManager', () => {
  it('removes the user-scope entry, and says so either way', async () => {
    expect(await disableManager(runner({ code: 0, stdout: 'Removed', stderr: '' }), 'claude')).toEqual({ ok: true, message: 'Stack: manager tools removed from Claude Code.' });
    expect(await disableManager(runner({ code: 1, stdout: 'No MCP server found', stderr: '' }), 'claude')).toEqual({ ok: false, message: 'Stack: nothing to remove — No MCP server found' });
    expect((await disableManager(runner({ code: 1, stdout: '', stderr: '' }), 'claude')).message).toBe('Stack: nothing to remove — exit code 1');
    expect((await disableManager(runner({ code: null, stdout: '', stderr: 'ENOENT' }), 'x')).message).toBe('Stack: could not run "x" (ENOENT).');
    expect((await disableManager(runner({ code: null, stdout: '', stderr: '' }), 'x')).message).toBe('Stack: could not run "x" (not found).');
  });
});

describe('execRun', () => {
  it('runs a program without a shell and reports its exit code and output', async () => {
    expect(await execRun(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({ code: 0, stdout: 'hi', stderr: '' });
    expect(await execRun(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'])).toEqual({ code: 3, stdout: '', stderr: 'bad' });
    expect(await execRun(process.execPath, ['-e', 'process.exit(4)'])).toEqual({ code: 4, stdout: '', stderr: '' });
  });

  it('reports a program that cannot be started with a null code and the reason', async () => {
    const res = await execRun('/definitely/not/here', []);
    expect(res.code).toBeNull();
    expect(res.stderr).toMatch(/ENOENT/);
  });
});
