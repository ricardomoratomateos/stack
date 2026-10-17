import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { HookServer } from '../../src/server/HookServer';
import { WindowRegistry } from '../../src/mcp/WindowRegistry';
import { ManagerTools, type ManagerDeps } from '../../src/mcp/ManagerTools';
import { TOOL_NAMES } from '../../src/mcp/protocol';
import type { Worktree } from '../../src/types';
import type { WorktreeItem } from '../../src/webview/types';

/**
 * The whole path, for real: the bridge bundled the way esbuild.js bundles it,
 * started as its own process and spoken to over stdio by the MCP SDK's
 * client; it finds the window through the discovery file a WindowRegistry
 * wrote and calls a real HookServer with the window's token. Only the
 * window's service behind ManagerTools is a double.
 */
describe('stack-mcp bridge over stdio, against a real window', () => {
  let tmp: string;
  let repo: string;
  let storage: string;
  let bundle: string;
  let server: HookServer;
  let registry: WindowRegistry;
  let client: Client;
  const createWorktree = vi.fn(async (opts: { branch: string }) => ({
    ok: true,
    worktree: { id: 'new-1', branch: opts.branch, path: path.join(repo, '.worktrees', opts.branch) } as Worktree,
  }));

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-it-')));
    repo = path.join(tmp, 'repo');
    storage = path.join(tmp, 'storage');
    fs.mkdirSync(repo);
    bundle = path.join(tmp, 'stack-mcp.js');
    buildSync({
      entryPoints: [path.resolve(__dirname, '../../src/mcp/bridge/main.ts')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: bundle, logLevel: 'silent',
      define: { 'process.env.STACK_MCP_VERSION': '"it"' },
    });

    const wt: Worktree = { id: 'wt-1', branch: 'feat/x', path: path.join(repo, '.worktrees', 'feat-x'), repoRoot: repo, debugPort: 1, dockerProjectName: 'x', createdAt: 1 };
    const item = {
      id: 'wt-1', branch: 'feat/x', path: wt.path, isMain: false, deleting: false, agent: 'active', agentCount: 1, terminalCount: 0,
      sessions: [{ name: 'claude', kind: 'agent', provider: 'claude', state: 'active', index: 1 }],
      git: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 }, docker: [], ports: [], pr: null,
    } as WorktreeItem;
    const tools = new ManagerTools({
      repoRoot: () => repo,
      worktrees: () => [wt],
      items: () => [item],
      createWorktree,
      onStateChange: () => ({ dispose() {} }),
      agentState: () => 'active',
    } as unknown as ManagerDeps);

    server = new HookServer({ updateState: () => {} });
    await server.start();
    registry = new WindowRegistry(storage);
    server.setApi({ token: registry.token, handle: (tool, req) => tools.handle(tool, req) });
    registry.update({ port: server.listeningPort, repoRoots: [repo], workspaceFolders: [repo], worktreeIds: ['wt-1'] });

    client = new Client({ name: 'it', version: '1' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: repo,
      env: { PATH: process.env.PATH ?? '', STACK_STORAGE_DIR: storage },
      stderr: 'pipe',
    }));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    server?.dispose();
    registry?.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists the Stack tools', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'stack', version: 'it' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it('answers stack_status from the window its cwd belongs to', async () => {
    const res = await client.callTool({ name: 'stack_status', arguments: {} });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body).toEqual({
      repo,
      tasks: [{
        id: 'wt-1', name: 'feat/x', branch: 'feat/x', group: 'working',
        sessions: [{ index: 1, name: 'claude', kind: 'agent', provider: 'claude', state: 'active' }],
      }],
    });
  });

  it('creates a task with a ticket', async () => {
    const res = await client.callTool({
      name: 'stack_create_task',
      arguments: { title: 'Fix payments', prompt: 'Do it', ticket: { source: 'jira', key: 'AS-1234' } },
    });
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toMatchObject({ task_id: 'new-1', branch: 'AS-1234-fix-payments', status: 'created' });
    expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ branch: 'AS-1234-fix-payments', select: false }));
  });

  it('reports a clear error, not a crash, when the tool fails or the window is gone', async () => {
    const bad = await client.callTool({ name: 'stack_read_agent', arguments: { task_id: 'nope' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0].text).toMatch(/No task "nope"/);

    registry.dispose();
    const gone = await client.callTool({ name: 'stack_status', arguments: {} });
    expect(gone.isError).toBe(true);
    expect((gone.content as Array<{ text: string }>)[0].text).toMatch(/Open Stack on .*repo in VS Code/);
  });
});
