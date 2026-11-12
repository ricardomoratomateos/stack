import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { runChecks, type DoctorDeps } from '../../src/daemon/doctor';
import { formatChecks, type Check } from '../../src/daemon/doctorReport';
import { NodeConfig } from '../../src/daemon/NodeConfig';
import { ProviderFactory } from '../../src/providers/ProviderFactory';
import { CLAUDE_SETTINGS_PATH } from '../../src/constants';

describe('stackd doctor', () => {
  let root: string;
  let home: string;
  let cfg: string;
  let bin: string;
  let deps: DoctorDeps;
  const by = (checks: Check[], id: string) => checks.find((c) => c.id === id);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')));
    home = path.join(root, 'home');
    cfg = path.join(root, 'cfg');
    bin = path.join(root, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(cfg);
    fs.mkdirSync(bin);
    // Only Claude Code is "installed".
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const config = new NodeConfig(() => undefined, path.join(cfg, 'settings.json'));
    deps = {
      config: config.get(),
      providers: new ProviderFactory(config, cfg, home).all(),
      claudeConfigPath: path.join(home, '.claude.json'),
      socketPath: path.join(cfg, 'stackd.sock'),
      tmuxVersion: async () => 'tmux 3.4',
      nodeVersion: '22.1.0',
      env: { PATH: bin },
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports tmux, node, a stackd that is not running, and the agent CLIs', async () => {
    const checks = await runChecks(deps);
    expect(by(checks, 'tmux')).toMatchObject({ ok: true, detail: 'tmux 3.4' });
    expect(by(checks, 'node')).toMatchObject({ ok: true, detail: 'v22.1.0' });
    expect(by(checks, 'stackd')).toMatchObject({ ok: false });
    expect(by(checks, 'stackd')?.fix).toMatch(/Stack\.app/);
    expect(by(checks, 'cli.claude')).toMatchObject({ ok: true, detail: `Claude Code: ${path.join(bin, 'claude')}` });
    // Not the default agent: missing is fine.
    expect(by(checks, 'cli.codex')).toMatchObject({ ok: true });
    expect(by(checks, 'cli.codex')?.detail).toMatch(/not installed/);
    // Hooks only for agents that are installed.
    expect(by(checks, 'hooks.codex')).toBeUndefined();
    expect(by(checks, 'hooks.opencode')).toBeUndefined();
  });

  it('fails a missing tmux, an old node and a missing default agent', async () => {
    fs.rmSync(path.join(bin, 'claude'));
    const checks = await runChecks({ ...deps, tmuxVersion: async () => undefined, nodeVersion: 'v18.19.0' });
    expect(by(checks, 'tmux')).toMatchObject({ ok: false, fix: 'brew install tmux' });
    expect(by(checks, 'node')).toMatchObject({ ok: false });
    expect(by(checks, 'cli.claude')).toMatchObject({ ok: false, fix: 'npm i -g @anthropic-ai/claude-code' });
  });

  it('sees stackd answering on its socket', async () => {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(deps.socketPath, r));
    try {
      expect(by(await runChecks(deps), 'stackd')).toMatchObject({ ok: true });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('checks the hooks: missing, installed, and a stale extension hook left behind', async () => {
    expect(by(await runChecks(deps), 'hooks.claude')).toMatchObject({ ok: false });
    expect(by(await runChecks(deps), 'hooks.claude')?.detail).toMatch(/missing in .*notify\.sh, SessionStart/);

    deps.providers.find((p) => p.id === 'claude')!.installHooks('http://127.0.0.1:1');
    expect(by(await runChecks(deps), 'hooks.claude')).toMatchObject({ ok: true });

    const settings = path.join(home, CLAUDE_SETTINGS_PATH);
    const json = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const old = '"/Users/x/Library/Application Support/Code/User/globalStorage/ricardomoratomateos.stack-agents/notify.sh" Stop claude';
    json.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: old }] });
    fs.writeFileSync(settings, JSON.stringify(json));
    const stale = by(await runChecks({ ...deps, inDaemon: true }), 'hooks.claude');
    expect(stale).toMatchObject({ ok: false });
    expect(stale?.detail).toContain('old VS Code extension hook');
    expect(stale?.fix).toMatch(/Restart stackd/);

    fs.writeFileSync(settings, '{ "hooks": ');
    expect(by(await runChecks(deps), 'hooks.claude')?.detail).toMatch(/syntax error/);
  });

  it('reports the MCP registration from ~/.claude.json', async () => {
    expect(by(await runChecks(deps), 'mcp')).toMatchObject({ ok: false });
    const bridge = path.join(cfg, 'stack-mcp.js');
    fs.writeFileSync(bridge, '');
    fs.writeFileSync(deps.claudeConfigPath, JSON.stringify({ mcpServers: { stack: { command: 'node', args: [bridge] } } }));
    expect(by(await runChecks({ ...deps, bridgePath: bridge }), 'mcp')).toMatchObject({ ok: true });
  });

  it('formats one line per check, fixes indented under failures', () => {
    const text = formatChecks([
      { id: 'tmux', ok: true, detail: 'tmux 3.4' },
      { id: 'node', ok: false, detail: 'v18', fix: 'Install Node 20+' },
    ]);
    expect(text).toBe('ok    tmux  tmux 3.4\nFAIL  node  v18\n            fix: Install Node 20+\n');
  });
});
