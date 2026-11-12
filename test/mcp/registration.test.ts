import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeBinary, enableManager, execRun, managerStatus, type Run, type RunResult } from '../../src/mcp/registration';
import { ASSET_FILES, MARKER, claudeAssets, installClaudeAssets } from '../../src/mcp/claudeAssets';
import { StackDaemon } from '../../src/daemon/StackDaemon';

const bridge = { command: '/usr/bin/node', args: ['/store/stack-mcp.js'] };
const runner = (...results: RunResult[]) => vi.fn<Run>(async () => results.shift() ?? { code: 0, stdout: '', stderr: '' });
// The real shipped files, as stackd reads them.
const SRC = path.join(__dirname, '../../resources/claude');

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-reg-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

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
  });

  it('says when claude cannot be run, or refuses', async () => {
    let res = await enableManager(runner({ code: null, stdout: '', stderr: '' }, { code: null, stdout: '', stderr: 'spawn claude ENOENT' }), 'claude', bridge);
    expect(res).toEqual({ ok: false, message: 'Could not run "claude" (spawn claude ENOENT). Install Claude Code or set claudeCommand.' });
    res = await enableManager(runner({ code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'a\nb\nc\nd: bad scope' }), 'claude', bridge);
    expect(res).toEqual({ ok: false, message: '"claude mcp add" failed: b c d: bad scope' });
  });
});

describe('execRun', () => {
  it('runs a program without a shell and reports its exit code and output', async () => {
    expect(await execRun(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({ code: 0, stdout: 'hi', stderr: '' });
    expect(await execRun(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'])).toEqual({ code: 3, stdout: '', stderr: 'bad' });
    expect((await execRun('/definitely/not/here', [])).code).toBeNull();
  });
});

describe('managerStatus', () => {
  const config = () => path.join(dir, '.claude.json');
  const write = (servers: unknown) => fs.writeFileSync(config(), JSON.stringify({ mcpServers: servers }));

  it('is registered when the user-scope "stack" server runs our bridge with a node that exists', () => {
    write({ stack: { type: 'stdio', command: process.execPath, args: ['/cfg/stack-mcp.js'] } });
    expect(managerStatus(config(), '/cfg/stack-mcp.js')).toEqual({ state: 'registered' });
  });

  it("points elsewhere for the VS Code extension's old path, or a node that is gone", () => {
    const old = '/Users/x/Library/Application Support/Code/User/globalStorage/ricardomoratomateos.stack-agents/stack-mcp.js';
    write({ stack: { command: '/usr/bin/node', args: [old] } });
    expect(managerStatus(config(), '/cfg/stack-mcp.js')).toEqual({ state: 'elsewhere', detail: `/usr/bin/node ${old}` });
    write({ stack: { command: '/gone/node', args: ['/cfg/stack-mcp.js'] } });
    expect(managerStatus(config(), '/cfg/stack-mcp.js').state).toBe('elsewhere');
  });

  it('is missing without the entry, the file, or with a file that does not parse', () => {
    write({ other: {} });
    expect(managerStatus(config(), '/b').state).toBe('missing');
    expect(managerStatus(path.join(dir, 'none.json'), '/b').state).toBe('missing');
    fs.writeFileSync(config(), '{not json');
    expect(managerStatus(config(), '/b').state).toBe('missing');
  });
});

describe('claudeAssets', () => {
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

  it('ships the skill and the /stack commands, all marked as Stack\'s', () => {
    const assets = claudeAssets(SRC);
    expect(Object.keys(assets)).toEqual([...ASSET_FILES]);
    for (const body of Object.values(assets)) expect(body).toContain(MARKER);
    expect(assets['skills/stack-manager/SKILL.md']).toMatch(/^---\nname: stack-manager\ndescription: /);
  });

  it("installs into an empty ~/.claude, refreshes its own (and the extension's) files, never the user's", () => {
    expect(installClaudeAssets(dir, SRC)).toEqual({ skipped: [] });
    fs.writeFileSync(path.join(dir, 'commands/stack.md'), 'old <!-- Installed by Stack (VS Code). Removed when "Stack tools in Claude Code" is switched off. -->');
    fs.writeFileSync(path.join(dir, 'commands/stack-next.md'), 'mine');
    expect(installClaudeAssets(dir, SRC)).toEqual({ skipped: ['commands/stack-next.md'] });
    expect(read('commands/stack.md')).toBe(claudeAssets(SRC)['commands/stack.md']);
    expect(read('commands/stack-next.md')).toBe('mine');
  });
});

describe('stackd enableManager / managerStatus', () => {
  const make = (run: Run, withBridge = true) => {
    const source = path.join(dir, 'dist-stack-mcp.js');
    fs.writeFileSync(source, '// bridge');
    return new StackDaemon({
      configDir: path.join(dir, 'cfg'),
      home: path.join(dir, 'home'),
      installHooks: false,
      bridgeSource: withBridge ? source : undefined,
      claudeAssets: SRC,
      run,
      notify: () => {},
    });
  };

  it('registers the stable bridge copy with the node stackd runs on, and installs the skill', async () => {
    const home = path.join(dir, 'home');
    const installed = path.join(dir, 'cfg', 'stack-mcp.js');
    // `claude mcp add` stands in for Claude Code writing ~/.claude.json.
    const run = vi.fn<Run>(async (_file, args) => {
      if (args[1] === 'add') {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { stack: { command: args[6], args: args.slice(7) } } }));
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const daemon = make(run);
    expect(await daemon.command('managerStatus', {})).toEqual({ state: 'missing' });

    const res = await daemon.command('enableManager', {}) as { state: string; message: string };

    expect(run.mock.calls[1]).toEqual(['claude', ['mcp', 'add', '--scope', 'user', 'stack', '--', process.execPath, installed]]);
    expect(res.state).toBe('registered');
    expect(res.message).toMatch(/registered/);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'stack-manager', 'SKILL.md'))).toBe(true);
    await daemon.stop();
  });

  it('refuses without a bundled bridge, and passes claude\'s complaint on', async () => {
    let daemon = make(runner(), false);
    await expect(daemon.command('enableManager', {})).rejects.toThrow(/bridge/);
    await daemon.stop();
    daemon = make(runner({ code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'nope' }));
    await expect(daemon.command('enableManager', {})).rejects.toThrow('"claude mcp add" failed: nope');
    await daemon.stop();
  });
});
