import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bridgeCommand, claudeMcpArgs, codexMcpArgs, installBridge } from '../../src/mcp/workerMcp';

describe('bridgeCommand', () => {
  it('runs node by absolute path when PATH has it, bare node otherwise', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-node-'));
    try {
      fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n', { mode: 0o755 });
      expect(bridgeCommand('/s/stack-mcp.js', { PATH: bin })).toEqual({ command: path.join(bin, 'node'), args: ['/s/stack-mcp.js'] });
      expect(bridgeCommand('/s/stack-mcp.js', { PATH: '' })).toEqual({ command: 'node', args: ['/s/stack-mcp.js'] });
      expect(bridgeCommand('/s/stack-mcp.js').args).toEqual(['/s/stack-mcp.js']);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('installBridge', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-bridge-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('copies the bundle into storage, rewriting it only when it changed', () => {
    const src = path.join(dir, 'dist.js');
    const storage = path.join(dir, 'storage');
    fs.writeFileSync(src, 'v1');
    const target = installBridge(src, storage)!;
    expect(target).toBe(path.join(storage, 'stack-mcp.js'));
    expect(fs.readFileSync(target, 'utf8')).toBe('v1');
    fs.utimesSync(target, 1, 1);
    expect(installBridge(src, storage)).toBe(target);
    expect(fs.statSync(target).mtimeMs).toBe(1000);
    fs.writeFileSync(src, 'v2');
    installBridge(src, storage);
    expect(fs.readFileSync(target, 'utf8')).toBe('v2');
  });

  it('without a bundle, keeps an installed bridge or reports none', () => {
    const storage = path.join(dir, 'storage');
    expect(installBridge(path.join(dir, 'missing.js'), storage)).toBeUndefined();
    fs.mkdirSync(storage);
    fs.writeFileSync(path.join(storage, 'stack-mcp.js'), 'old');
    expect(installBridge(path.join(dir, 'missing.js'), storage)).toBe(path.join(storage, 'stack-mcp.js'));
  });
});

describe('worker MCP arguments', () => {
  const bridge = { command: "/opt/my node/node", args: ["/it's/stack-mcp.js"] };

  it('claude: one --mcp-config JSON, shell-quoted', () => {
    const arg = claudeMcpArgs(bridge, 'wt-1');
    expect(arg.startsWith("--mcp-config '")).toBe(true);
    const json = arg.slice("--mcp-config '".length, -1).replace(/'\\''/g, "'");
    expect(JSON.parse(json)).toEqual({
      mcpServers: { stack: { type: 'stdio', command: '/opt/my node/node', args: ["/it's/stack-mcp.js"], env: { STACK_TASK_ID: 'wt-1' } } },
    });
  });

  it('codex: TOML values in -c overrides', () => {
    expect(codexMcpArgs({ command: 'node', args: ['/a', '/b'] }, 'wt-1')).toBe(
      `-c 'mcp_servers.stack.command="node"' -c 'mcp_servers.stack.args=["/a","/b"]' -c 'mcp_servers.stack.env={STACK_TASK_ID="wt-1"}'`,
    );
  });
});
